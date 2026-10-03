-- Migration: backfill deployed function bodies into the repo.
--
-- Background: ~28 migrations between 20260619000000 and 20260625120000 were
-- applied out-of-band via Supabase MCP with stub bodies (`select 1 where false`)
-- checked into the repo. The real function bodies lived only in deployed
-- Postgres, making the repo non-replayable and reviews partly guesswork.
--
-- This single consolidated migration recreates every public-schema function
-- whose body was missing or stubbed in the repo, using the EXACT body
-- currently deployed to production (captured via pg_get_functiondef on
-- 2026-06-26). Applying this migration against a fresh database produces
-- the same function definitions as the deployed project.
--
-- Order matters: functions are recreated in dependency order (helpers first,
-- then leaf handlers, then composites). CREATE OR REPLACE is idempotent for
-- already-existing functions. No data migrations — pure DDL.
--
-- Functions included (32 total):
--   Helpers:        _extract_json_path, render_template, resolve_merge_tags,
--                   resolve_tenant_by_phone, next_business_window,
--                   clamp_to_advance_window, compare_values, evaluate_condition,
--                   get_internal_dispatch_key, set_audit_actor
--   Payload RPCs:   get_email_payload, get_sms_payload, get_sms_send_payload,
--                   get_call_payload, get_alert_payload
--   Engine:         advance_journey, should_dispatch, record_send_event,
--                   process_wait_action, process_retell_call_result
--   Inbound:        process_inbound_sms, process_inbound_email,
--                   process_journey_webhook, replay_webhook_sample
--   Native inline:  process_action_set_lead_fields, process_action_find_lead,
--                   process_action_conditional_split, process_team_alert_action,
--                   cancel_pending_on_engagement
--   Dashboard:      journey_funnel, dashboard_summary, error_groups


-- ########################################################
-- _extract_json_path
-- ########################################################
CREATE OR REPLACE FUNCTION public._extract_json_path(p_payload jsonb, p_path text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  v_clean text;
  v_cur jsonb := p_payload;
  v_result text;
  v_idx int;
  -- Match: bracket index, OR bare integer (a numeric path segment),
  -- OR identifier (must start with letter/underscore so '0' doesn't fall here).
  -- Order matters — alternation is left-to-right.
  v_pat text := '(\[(-?\d+)\])|(-?\d+)|([a-zA-Z_][a-zA-Z0-9_]*)';
  v_match text[];
begin
  if p_path is null or trim(p_path) = '' then return null; end if;
  v_clean := trim(p_path);

  -- JSONPath syntax: $.foo.bar — use Postgres built-in.
  if v_clean like '$%' then
    begin
      select jsonb_path_query_first(p_payload, v_clean::jsonpath) #>> '{}' into v_result;
      return v_result;
    exception when others then return null; end;
  end if;

  for v_match in
    select regexp_matches(v_clean, v_pat, 'g')
  loop
    if v_match[2] is not null then
      -- bracket-form array index: [N]
      if v_cur is null then return null; end if;
      if jsonb_typeof(v_cur) <> 'array' then return null; end if;
      v_idx := v_match[2]::int;
      if v_idx < 0 then v_idx := jsonb_array_length(v_cur) + v_idx; end if;
      v_cur := v_cur -> v_idx;
    elsif v_match[3] is not null then
      -- bare numeric segment: treat as array index when current is an array,
      -- otherwise treat as object key (covers payloads that put digits in keys).
      if v_cur is null then return null; end if;
      if jsonb_typeof(v_cur) = 'array' then
        v_idx := v_match[3]::int;
        if v_idx < 0 then v_idx := jsonb_array_length(v_cur) + v_idx; end if;
        v_cur := v_cur -> v_idx;
      elsif jsonb_typeof(v_cur) = 'object' then
        v_cur := v_cur -> v_match[3];
      else
        return null;
      end if;
    elsif v_match[4] is not null then
      -- object key
      if v_cur is null then return null; end if;
      if jsonb_typeof(v_cur) <> 'object' then return null; end if;
      v_cur := v_cur -> v_match[4];
    end if;
  end loop;

  if v_cur is null or jsonb_typeof(v_cur) = 'null' then return null; end if;
  return v_cur #>> '{}';
end;
$function$;


-- ########################################################
-- render_template
-- ########################################################
CREATE OR REPLACE FUNCTION public.render_template(p_body text, p_lead leads)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res text := p_body;
  v_key text;
  v_val text;
begin
  if v_res is null then return null; end if;

  -- Canonical identifier first. Users can drop {{lead_id}} into templates,
  -- update_lead values, http_request bodies — anywhere merge tags work.
  v_res := replace(v_res, '{{lead_id}}', coalesce(p_lead.id::text, ''));

  -- Standard lead columns.
  v_res := replace(v_res, '{{first_name}}',    coalesce(p_lead.first_name, ''));
  v_res := replace(v_res, '{{last_name}}',     coalesce(p_lead.last_name, ''));
  v_res := replace(v_res, '{{email}}',         coalesce(p_lead.email, ''));
  v_res := replace(v_res, '{{phone_raw}}',     coalesce(p_lead.phone_raw, ''));
  v_res := replace(v_res, '{{phone_e164}}',    coalesce(p_lead.phone_e164, ''));
  v_res := replace(v_res, '{{campaign_type}}', coalesce(p_lead.campaign_type, ''));
  v_res := replace(v_res, '{{source}}',        coalesce(p_lead.source, ''));
  v_res := replace(v_res, '{{zip_code}}',      coalesce(p_lead.zip_code, ''));
  v_res := replace(v_res, '{{address}}',       coalesce(p_lead.address_line1, ''));

  if p_lead.custom_fields is not null then
    for v_key, v_val in select * from jsonb_each_text(p_lead.custom_fields) loop
      v_res := replace(v_res, '{{' || v_key || '}}', coalesce(v_val, ''));
    end loop;
  end if;

  return v_res;
end;
$function$;


-- ########################################################
-- resolve_merge_tags
-- ########################################################
CREATE OR REPLACE FUNCTION public.resolve_merge_tags(p_body text, p_lead leads)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res text;
  v_match text[];
  v_full text;
  v_path text;
  v_val text;
begin
  v_res := render_template(p_body, p_lead);
  if v_res is null then return null; end if;

  for v_match in
    select regexp_matches(v_res, '\{\{raw_payload\.([^}]+)\}\}', 'g')
  loop
    v_path := v_match[1];
    v_full := '{{raw_payload.' || v_path || '}}';
    v_val  := _extract_json_path(p_lead.raw_payload, v_path);
    v_res  := replace(v_res, v_full, coalesce(v_val, ''));
  end loop;

  return v_res;
end;
$function$;


-- ########################################################
-- resolve_tenant_by_phone
-- ########################################################
CREATE OR REPLACE FUNCTION public.resolve_tenant_by_phone(p_phone text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
begin
  select tenant_id into v_tenant_id
  from tenant_credentials
  where provider = 'twilio'
    and (config->>'from_number' = p_phone or config->>'from_number' = replace(p_phone, '+', ''))
    and active = true
  limit 1;
  
  return v_tenant_id;
end;
$function$;


-- ########################################################
-- next_business_window
-- ########################################################
CREATE OR REPLACE FUNCTION public.next_business_window(p_timezone text, p_business_hours jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_local_now timestamp := (now() at time zone p_timezone);
  v_local_date date := v_local_now::date;
  v_start_time time := (p_business_hours->>'start')::time;
  v_end_time time := (p_business_hours->>'end')::time;
  v_days jsonb := p_business_hours->'days';
  v_dow text;
  v_candidate_local timestamp;
  v_iters int := 0;
begin
  loop
    v_dow := to_char(v_local_date, 'Dy');  -- 'Mon','Tue',...,'Sun'

    if v_days @> to_jsonb(v_dow) then
      -- This day is a business day. Pick start_time if we're before it, otherwise this day is past.
      if v_local_date = v_local_now::date and v_local_now::time < v_start_time then
        v_candidate_local := (v_local_date::text || ' ' || v_start_time::text)::timestamp;
        return v_candidate_local at time zone p_timezone;
      elsif v_local_date > v_local_now::date then
        v_candidate_local := (v_local_date::text || ' ' || v_start_time::text)::timestamp;
        return v_candidate_local at time zone p_timezone;
      end if;
    end if;

    v_local_date := v_local_date + 1;
    v_iters := v_iters + 1;
    if v_iters > 14 then
      -- safety: business_hours has no valid days configured
      return now() + interval '24 hours';
    end if;
  end loop;
end;
$function$;


-- ########################################################
-- clamp_to_advance_window
-- ########################################################
CREATE OR REPLACE FUNCTION public.clamp_to_advance_window(p_run_at timestamp with time zone, p_window jsonb, p_timezone text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_enabled   bool := coalesce((p_window->>'enabled')::bool, false);
  v_days      jsonb;
  v_start     time;
  v_end       time;
  v_filter    jsonb;
  v_local     timestamp;
  v_date      date;
  v_time      time;
  v_dow       text;
  v_iters     int := 0;
  v_filter_ok bool;
  v_op        text;
  v_value     text;
  v_ftype     text;
begin
  if not v_enabled or p_window is null then
    return p_run_at;
  end if;

  v_days  := coalesce(p_window->'days', '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]'::jsonb);
  v_start := nullif(p_window->'window'->>'start', '')::time;
  v_end   := nullif(p_window->'window'->>'end',   '')::time;
  if v_start is null then v_start := time '00:00'; end if;
  if v_end   is null then v_end   := time '23:59'; end if;
  v_filter := p_window->'additional_filter';
  v_ftype  := v_filter->>'type';
  v_op     := coalesce(v_filter->>'op', 'is');
  v_value  := v_filter->>'value';

  v_local := (p_run_at at time zone p_timezone);
  v_date  := v_local::date;
  v_time  := v_local::time;

  loop
    v_dow := to_char(v_date, 'Dy');

    if v_days @> to_jsonb(v_dow) then
      v_filter_ok := true;
      if v_ftype is not null and v_value is not null and v_value <> '' then
        if v_ftype = 'current_day_of_month' then
          v_filter_ok := (extract(day from v_date)::int = v_value::int);
        elsif v_ftype = 'current_month' then
          v_filter_ok := (lower(to_char(v_date, 'FMMonth')) = lower(v_value));
        elsif v_ftype = 'current_year' then
          v_filter_ok := (extract(year from v_date)::int = v_value::int);
        end if;
        if v_op = 'is_not' then
          v_filter_ok := not v_filter_ok;
        end if;
      end if;

      if v_filter_ok then
        if v_date > v_local::date then
          return ((v_date::text || ' ' || v_start::text)::timestamp) at time zone p_timezone;
        elsif v_time < v_start then
          return ((v_date::text || ' ' || v_start::text)::timestamp) at time zone p_timezone;
        elsif v_time <= v_end then
          return p_run_at;
        end if;
      end if;
    end if;

    v_date := v_date + 1;
    v_time := v_start;
    v_iters := v_iters + 1;
    if v_iters > 366 then
      return p_run_at + interval '24 hours';
    end if;
  end loop;
end;
$function$;


-- ########################################################
-- compare_values
-- ########################################################
CREATE OR REPLACE FUNCTION public.compare_values(p_actual jsonb, p_op text, p_value jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  v_actual_text text;
  v_value_text text;
begin
  if p_op = 'is_empty' then
    return p_actual is null
        or jsonb_typeof(p_actual) = 'null'
        or (jsonb_typeof(p_actual) = 'string' and p_actual = '""'::jsonb);
  elsif p_op = 'is_not_empty' then
    return p_actual is not null
       and jsonb_typeof(p_actual) <> 'null'
       and not (jsonb_typeof(p_actual) = 'string' and p_actual = '""'::jsonb);
  elsif p_actual is null or jsonb_typeof(p_actual) = 'null' then
    return false;
  end if;

  v_actual_text := p_actual #>> '{}';
  v_value_text  := p_value  #>> '{}';

  if p_op = 'equals' then
    return v_actual_text = v_value_text;
  elsif p_op = 'not_equals' then
    return v_actual_text <> v_value_text;
  elsif p_op = 'contains' then
    return v_actual_text ilike '%' || v_value_text || '%';
  elsif p_op = 'not_contains' then
    return v_actual_text not ilike '%' || v_value_text || '%';
  elsif p_op = 'gt' then
    return v_actual_text::numeric > v_value_text::numeric;
  elsif p_op = 'lt' then
    return v_actual_text::numeric < v_value_text::numeric;
  elsif p_op = 'gte' then
    return v_actual_text::numeric >= v_value_text::numeric;
  elsif p_op = 'lte' then
    return v_actual_text::numeric <= v_value_text::numeric;
  elsif p_op = 'is_true' then
    return v_actual_text in ('true','t','1');
  elsif p_op = 'is_false' then
    return v_actual_text in ('false','f','0');
  end if;
  return false;
end;
$function$;


-- ########################################################
-- evaluate_condition
-- ########################################################
CREATE OR REPLACE FUNCTION public.evaluate_condition(p_condition jsonb, p_lead_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lead leads;
  v_combinator text;
  v_rules jsonb;
  v_rule jsonb;
  v_field text;
  v_op text;
  v_value jsonb;
  v_actual jsonb;
  v_tags jsonb;
  v_lead_jsonb jsonb;
  v_temp boolean;
  v_result boolean;
begin
  if p_condition is null or jsonb_typeof(p_condition) = 'null' then
    return true;
  end if;

  v_rules := p_condition->'rules';
  if v_rules is null or jsonb_array_length(v_rules) = 0 then
    return true;
  end if;

  select * into v_lead from leads where id = p_lead_id;
  if not found then return false; end if;
  v_lead_jsonb := to_jsonb(v_lead);
  v_combinator := lower(coalesce(p_condition->>'combinator', 'and'));
  v_result := (v_combinator = 'and');

  for v_rule in select * from jsonb_array_elements(v_rules) loop
    v_field := v_rule->>'field';
    v_op := v_rule->>'op';
    v_value := v_rule->'value';
    v_temp := false;

    if v_field = 'tags' then
      v_tags := coalesce(v_lead.custom_fields->'tags', '[]'::jsonb);
      if v_op = 'includes' then
        v_temp := v_tags ? (v_value #>> '{}');
      elsif v_op = 'excludes' then
        v_temp := not (v_tags ? (v_value #>> '{}'));
      elsif v_op = 'includes_any' then
        v_temp := exists(
          select 1 from jsonb_array_elements_text(v_value) e where v_tags ? e
        );
      elsif v_op = 'includes_all' then
        v_temp := not exists(
          select 1 from jsonb_array_elements_text(v_value) e where not (v_tags ? e)
        );
      elsif v_op = 'is_empty' then
        v_temp := jsonb_array_length(v_tags) = 0;
      elsif v_op = 'is_not_empty' then
        v_temp := jsonb_array_length(v_tags) > 0;
      end if;
    elsif v_field like 'custom.%' then
      v_actual := v_lead.custom_fields -> substring(v_field from 8);
      v_temp := compare_values(v_actual, v_op, v_value);
    else
      v_actual := v_lead_jsonb -> v_field;
      v_temp := compare_values(v_actual, v_op, v_value);
    end if;

    if v_combinator = 'and' then
      v_result := v_result and v_temp;
    else
      v_result := v_result or v_temp;
    end if;
  end loop;

  return v_result;
end;
$function$;


-- ########################################################
-- get_internal_dispatch_key
-- ########################################################
CREATE OR REPLACE FUNCTION public.get_internal_dispatch_key()
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'vault', 'public'
AS $function$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = 'internal_dispatch_key'
   limit 1;
$function$;


-- ########################################################
-- set_audit_actor
-- ########################################################
CREATE OR REPLACE FUNCTION public.set_audit_actor(p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform set_config('app.current_actor', coalesce(p_actor::text, ''), false);
end;
$function$;


-- ########################################################
-- get_alert_payload
-- ########################################################
CREATE OR REPLACE FUNCTION public.get_alert_payload(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_template templates;
  v_tenant tenants;
  v_body text;
  v_subject text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    raise exception 'Action not found: %', p_action_id;
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    raise exception 'Lead not found for action: %', p_action_id;
  end if;

  select * into v_tenant from tenants where id = v_action.tenant_id;
  if not found then
    raise exception 'Tenant not found: %', v_action.tenant_id;
  end if;

  -- Attempt to select the specific template
  if v_action.template_key is not null then
    select * into v_template from templates 
    where tenant_id = v_action.tenant_id 
      and template_key = v_action.template_key 
    order by version desc 
    limit 1;
  end if;

  -- Fallback 1: Find any team_alert template for this tenant
  if v_template.id is null then
    select * into v_template from templates
    where tenant_id = v_action.tenant_id
      and channel = 'team_alert'
    order by version desc
    limit 1;
  end if;

  -- Fallback 2: Construct default subject/body
  if v_template.id is null then
    v_subject := '🚨 Follow-Up Alert: Manual Follow-up Required';
    v_body := 'Hi Team,' || chr(10) || chr(10) ||
              'An automated alert has been triggered for lead ' || coalesce(v_lead.first_name, '') || ' ' || coalesce(v_lead.last_name, '') || '.' || chr(10) ||
              'Phone: ' || coalesce(v_lead.phone_e164, 'N/A') || chr(10) ||
              'Email: ' || coalesce(v_lead.email, 'N/A') || chr(10) ||
              'Action: ' || coalesce(v_action.action_type, 'N/A') || chr(10) ||
              'Reason: ' || coalesce(v_action.payload->>'reason', 'N/A') || chr(10) ||
              'Details: ' || coalesce(v_action.payload::text, 'N/A') || chr(10) || chr(10) ||
              'Best,' || chr(10) ||
              'Follow-Up Engine';
  else
    v_subject := v_template.subject;
    v_body := v_template.body;
  end if;

  -- Replace basic template variables
  v_subject := replace(v_subject, '{{first_name}}', coalesce(v_lead.first_name, ''));
  v_body := replace(v_body, '{{first_name}}', coalesce(v_lead.first_name, ''));
  v_body := replace(v_body, '{{last_name}}', coalesce(v_lead.last_name, ''));

  return jsonb_build_object(
    'action_id', v_action.id,
    'first_name', v_lead.first_name,
    'subject', v_subject,
    'body', v_body,
    'alert_email_to', v_tenant.team_alert_email
  );
end;
$function$;


-- ########################################################
-- get_sms_send_payload
-- ########################################################
CREATE OR REPLACE FUNCTION public.get_sms_send_payload(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action      actions;
  v_lead        leads;
  v_template    templates;
  v_credentials tenant_credentials;
  v_body        text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then raise exception 'Action not found: %', p_action_id; end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then raise exception 'Lead not found: %', p_action_id; end if;

  select * into v_template
    from templates
   where tenant_id = v_action.tenant_id and template_key = v_action.template_key
   order by version desc limit 1;
  if not found then raise exception 'Template not found: %', v_action.template_key; end if;

  select * into v_credentials
    from tenant_credentials
   where tenant_id = v_action.tenant_id and provider='twilio' and active=true
   limit 1;
  if not found then raise exception 'No active Twilio credentials for tenant %', v_action.tenant_id; end if;

  v_body := resolve_merge_tags(v_template.body, v_lead);

  return jsonb_build_object(
    'action_id',    v_action.id,
    'tenant_id',    v_action.tenant_id,
    'phone_to',     v_lead.phone_e164,
    'body',         v_body,
    'account_sid',  v_credentials.config->>'account_sid',
    'auth_token',   v_credentials.config->>'auth_token',
    'from_number',  v_credentials.config->>'from_number'
  );
end;
$function$;


-- ########################################################
-- get_sms_payload
-- ########################################################
CREATE OR REPLACE FUNCTION public.get_sms_payload(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_template templates;
  v_credentials tenant_credentials;
  v_body text;
  v_inline_body text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    raise exception 'Action not found: %', p_action_id;
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    raise exception 'Lead not found for action: %', p_action_id;
  end if;

  v_inline_body := v_action.payload->'inline'->>'body';

  if v_inline_body is null or v_inline_body = '' then
    select * into v_template from templates
     where tenant_id = v_action.tenant_id
       and template_key = v_action.template_key
     order by version desc
     limit 1;
    if not found then
      raise exception 'Template not found for action: %', p_action_id;
    end if;
    v_body := render_template(v_template.body, v_lead);
  else
    -- Inline path: render merge tags on the operator-typed body.
    begin
      v_body := render_template(v_inline_body, v_lead);
    exception when undefined_function then
      v_body := replace(v_inline_body, '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
  end if;

  select * into v_credentials from tenant_credentials
   where tenant_id = v_action.tenant_id
     and provider = 'twilio'
     and active = true;

  if not found then
    raise exception 'Active Twilio credentials not found for tenant %', v_action.tenant_id;
  end if;

  return jsonb_build_object(
    'action_id', v_action.id,
    'provider_id', v_action.provider_id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'body', v_body,
    'twilio_credential_name', v_credentials.n8n_credential_name,
    'twilio_from_number', v_credentials.config->>'from_number'
  );
end;
$function$;


-- ########################################################
-- get_call_payload
-- ########################################################
CREATE OR REPLACE FUNCTION public.get_call_payload(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action       actions;
  v_lead         leads;
  v_credentials  tenant_credentials;
  v_step_agent_id text;
  v_agent        retell_agents;
  v_resolved_agent_id    text;
  v_resolved_from_number text;
  v_step_spec    jsonb;
  v_dyn_decl     jsonb;
  v_dyn_row      jsonb;
  v_dyn_key      text;
  v_dyn_val_raw  text;
  v_dyn_val      text;
  v_dyn_vars     jsonb;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Action not found');
  end if;

  if v_action.status = 'completed' then
    return jsonb_build_object(
      'outcome',     'already_completed',
      'action_id',   v_action.id,
      'provider_id', v_action.provider_id,
      'reason',      'Action already completed; nothing to do.'
    );
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Lead not found');
  end if;

  select * into v_credentials from tenant_credentials
   where tenant_id = v_action.tenant_id
     and provider  = 'retell'
     and active    = true;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Retell credentials not found');
  end if;

  v_step_spec     := v_action.payload -> 'step_spec';
  v_step_agent_id := v_step_spec ->> 'retell_agent_id';

  if v_step_agent_id is not null and v_step_agent_id <> '' then
    select * into v_agent
      from retell_agents
     where tenant_id = v_action.tenant_id
       and agent_id  = v_step_agent_id
       and active    = true
     limit 1;
    if found then
      v_resolved_agent_id    := v_agent.agent_id;
      v_resolved_from_number := coalesce(v_agent.from_number, v_credentials.config->>'from_number');
    else
      return jsonb_build_object('outcome', 'failed', 'reason', 'retell_agent_not_found: ' || v_step_agent_id);
    end if;
  else
    v_resolved_agent_id    := v_credentials.config->>'agent_id';
    v_resolved_from_number := v_credentials.config->>'from_number';
  end if;

  if v_resolved_agent_id is null or v_resolved_agent_id = '' then
    return jsonb_build_object('outcome', 'failed', 'reason', 'No Retell agent configured');
  end if;

  ---------------------------------------------------------------------
  -- Build retell_dynamic_variables:
  --   baseline (system convention: followup_lead_id, first_name, lead_id)
  --   then for each row in step_spec.retell_dynamic_variables render
  --   the value via resolve_merge_tags and merge it on top.
  -- Step config wins on key conflicts, so authors can override baseline
  -- if they really want to.
  ---------------------------------------------------------------------
  v_dyn_vars := jsonb_build_object(
    'followup_lead_id', v_lead.id::text,
    'lead_id',         v_lead.id::text,
    'first_name',      coalesce(v_lead.first_name, '')
  );

  v_dyn_decl := v_step_spec -> 'retell_dynamic_variables';
  if v_dyn_decl is not null and jsonb_typeof(v_dyn_decl) = 'array' then
    for v_dyn_row in select * from jsonb_array_elements(v_dyn_decl)
    loop
      v_dyn_key     := trim(coalesce(v_dyn_row ->> 'key', ''));
      v_dyn_val_raw := coalesce(v_dyn_row ->> 'value', '');
      if v_dyn_key = '' then continue; end if;
      -- Render merge tags against the lead. Empty result is fine (Retell
      -- will receive an empty string and the agent prompt should handle it).
      v_dyn_val := resolve_merge_tags(v_dyn_val_raw, v_lead);
      v_dyn_vars := v_dyn_vars || jsonb_build_object(v_dyn_key, coalesce(v_dyn_val, ''));
    end loop;
  end if;

  return jsonb_build_object(
    'outcome',                'success',
    'action_id',              v_action.id,
    'provider_id',            v_action.provider_id,
    'phone_to',               v_lead.phone_e164,
    'first_name',             v_lead.first_name,
    'lead_id',                v_lead.id,
    'retell_credential_name', v_credentials.n8n_credential_name,
    'retell_from_number',     v_resolved_from_number,
    'retell_agent_id',        v_resolved_agent_id,
    'retell_dynamic_variables', v_dyn_vars,
    'metadata',               jsonb_build_object(
                                'followup_lead_id',   v_lead.id::text,
                                'followup_action_id', v_action.id::text
                              )
  );
end;
$function$;


-- ########################################################
-- get_email_payload
-- ########################################################
CREATE OR REPLACE FUNCTION public.get_email_payload(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_template templates;
  v_sender senders;
  v_body_html text;
  v_body_plain text;
  v_subject text;
  v_now timestamptz := now();
  v_next_eligible timestamptz;
  v_min_between interval;
  v_sender_is_usable bool;
  v_has_prior_thread bool;
  v_inline_subject text;
  v_inline_body text;
  v_inline_plain text;
  v_inline_format text;
  v_prior_subject text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return jsonb_build_object('outcome','failed','reason','Action not found'); end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then return jsonb_build_object('outcome','failed','reason','Lead not found'); end if;

  v_inline_subject := v_action.payload->'inline'->>'subject';
  v_inline_body    := v_action.payload->'inline'->>'body';
  v_inline_plain   := v_action.payload->'inline'->>'body_plain';
  v_inline_format  := v_action.payload->'inline'->>'body_format';

  if v_inline_body is null or v_inline_body = '' then
    select * into v_template
      from templates
     where tenant_id = v_action.tenant_id
       and template_key = v_action.template_key
     order by version desc
     limit 1;
    if not found then return jsonb_build_object('outcome','failed','reason','Template not found'); end if;
  end if;

  -- Sender resolution (unchanged).
  if v_lead.assigned_sender_id is not null then
    select * into v_sender from senders where id = v_lead.assigned_sender_id;
    v_sender_is_usable :=
         v_sender.id is not null
     and v_sender.active = true
     and v_sender.warmup_stage in ('warming','active')
     and (v_sender.pause_until is null or v_sender.pause_until < v_now)
     and v_sender.google_refresh_token is not null;

    if not v_sender_is_usable then
      select exists(select 1 from events where lead_id = v_lead.id and channel = 'email') into v_has_prior_thread;
      if v_has_prior_thread then
        return jsonb_build_object(
          'outcome','failed',
          'reason','Assigned sender ' || v_sender.sender_email ||
                   ' is no longer usable, but this lead has an existing email thread. ' ||
                   'Manually reassign or reconnect the sender to preserve thread continuity.'
        );
      end if;
      update leads set assigned_sender_id = null where id = v_lead.id;
      v_lead.assigned_sender_id := null;
      v_sender := null;
    end if;
  end if;

  if v_sender.id is null then
    select * into v_sender
      from senders
     where tenant_id = v_action.tenant_id
       and active = true
       and warmup_stage in ('warming','active')
       and (pause_until is null or pause_until < v_now)
       and google_refresh_token is not null
     order by last_sent_at nulls first
     limit 1;
  end if;
  if v_sender.id is null then
    return jsonb_build_object(
      'outcome','no_sender',
      'reason','No sender available. Connect Google for at least one active sender in Settings → Senders.'
    );
  end if;

  if v_sender.last_reset_date < current_date then
    update senders set sent_today = 0, last_reset_date = current_date
     where id = v_sender.id returning * into v_sender;
  end if;

  v_min_between := (v_sender.min_seconds_between_sends || ' seconds')::interval;

  if v_sender.pause_until is not null and v_sender.pause_until > v_now then
    return jsonb_build_object('outcome','throttled','reason','Sender paused until ' || v_sender.pause_until::text,
      'next_eligible_at', v_sender.pause_until, 'sender_id', v_sender.id, 'sender_email', v_sender.sender_email);
  end if;
  if v_sender.sent_today >= v_sender.daily_limit then
    v_next_eligible := (current_date + interval '1 day') + interval '1 minute';
    return jsonb_build_object('outcome','throttled',
      'reason','Daily limit reached: ' || v_sender.sent_today || '/' || v_sender.daily_limit || ' for ' || v_sender.sender_email,
      'next_eligible_at', v_next_eligible, 'sender_id', v_sender.id, 'sender_email', v_sender.sender_email);
  end if;
  if v_sender.last_sent_at is not null and v_sender.last_sent_at + v_min_between > v_now then
    v_next_eligible := v_sender.last_sent_at + v_min_between;
    return jsonb_build_object('outcome','throttled','reason','Cooldown: min_seconds_between_sends=' || v_sender.min_seconds_between_sends,
      'next_eligible_at', v_next_eligible, 'sender_id', v_sender.id, 'sender_email', v_sender.sender_email);
  end if;

  if v_lead.assigned_sender_id is null or v_lead.assigned_sender_id != v_sender.id then
    update leads set assigned_sender_id = v_sender.id where id = v_lead.id;
  end if;

  if v_inline_body is not null and v_inline_body <> '' then
    -- Inline path. If operator didn't type a subject AND we're replying
    -- on an existing thread, derive subject from the most recent
    -- outbound on that thread so Gmail keeps the thread together.
    if (v_inline_subject is null or trim(v_inline_subject) = '' or v_inline_subject ~ '^\s*[Rr][Ee]:\s*$')
       and v_lead.email_thread_id is not null then
      select subject into v_prior_subject
        from events
       where lead_id = v_lead.id
         and channel = 'email'
         and direction = 'outbound'
         and subject is not null
         and length(trim(subject)) > 0
         and raw_payload->>'thread_id' = v_lead.email_thread_id
       order by created_at desc
       limit 1;
      if v_prior_subject is not null then
        v_inline_subject := v_prior_subject;
      end if;
    end if;

    begin
      v_subject := render_template(coalesce(v_inline_subject, ''), v_lead);
    exception when undefined_function then
      v_subject := replace(coalesce(v_inline_subject,''), '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    begin
      v_body_html := render_template(v_inline_body, v_lead);
    exception when undefined_function then
      v_body_html := replace(v_inline_body, '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    if v_inline_plain is not null and v_inline_plain <> '' then
      begin
        v_body_plain := render_template(v_inline_plain, v_lead);
      exception when undefined_function then
        v_body_plain := replace(v_inline_plain, '{{first_name}}', coalesce(v_lead.first_name,''));
      end;
    end if;
  else
    begin
      v_subject := render_template(v_template.subject, v_lead);
    exception when undefined_function then
      v_subject := replace(coalesce(v_template.subject,''), '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    begin
      v_body_html := render_template(v_template.body, v_lead);
    exception when undefined_function then
      v_body_html := replace(coalesce(v_template.body,''), '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    if v_template.body_plain is not null and length(v_template.body_plain) > 0 then
      begin
        v_body_plain := render_template(v_template.body_plain, v_lead);
      exception when undefined_function then
        v_body_plain := replace(v_template.body_plain, '{{first_name}}', coalesce(v_lead.first_name,''));
      end;
    end if;
  end if;

  return jsonb_build_object(
    'outcome','success',
    'action_id', v_action.id,
    'provider_id', v_action.provider_id,
    'email_to', v_lead.email,
    'first_name', v_lead.first_name,
    'subject', v_subject,
    'body', v_body_html,
    'body_html', v_body_html,
    'body_plain', v_body_plain,
    'body_format', coalesce(v_inline_format, v_template.body_format, 'both'),
    'gmail_credential_id', '',
    'gmail_credential_name', v_sender.n8n_credential_name,
    'sender_id', v_sender.id,
    'sender_email', v_sender.sender_email,
    'sender_name', v_sender.sender_name,
    'email_thread_id', v_lead.email_thread_id,
    'last_email_message_id', v_lead.last_email_message_id,
    'has_thread', (v_lead.email_thread_id is not null and v_lead.last_email_message_id is not null)
  );
end;
$function$;


-- ########################################################
-- replay_webhook_sample
-- ########################################################
CREATE OR REPLACE FUNCTION public.replay_webhook_sample(p_sample_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sample journey_webhook_samples;
  v_journey journeys;
begin
  select * into v_sample from journey_webhook_samples where id = p_sample_id;
  if not found then return jsonb_build_object('status','failed','reason','sample_not_found'); end if;
  select * into v_journey from journeys where id = v_sample.journey_id;
  return process_journey_webhook(v_journey.webhook_token, v_sample.payload, v_sample.headers, null);
end;
$function$;


-- ########################################################
-- should_dispatch
-- ########################################################
CREATE OR REPLACE FUNCTION public.should_dispatch(p_action_id uuid)
 RETURNS TABLE(can_dispatch boolean, reason text, reschedule_to timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_tenant tenants;
  v_bh jsonb;
  v_now_local timestamp;
  v_local_time time;
  v_local_dow text;
  v_business_days jsonb;
  v_start time;
  v_end time;
  v_suppressed int;
begin
  select * into v_action from actions where id = p_action_id;
  select * into v_lead from leads where id = v_action.lead_id;
  select * into v_tenant from tenants where id = v_action.tenant_id;

  if v_action.action_type = 'wait' then
    return query select true, null::text, null::timestamptz;
    return;
  end if;

  if v_lead.opt_out then
    return query select false, 'lead_opt_out', null::timestamptz;
    return;
  end if;
  if v_lead.responded and v_action.action_type <> 'team_alert' then
    return query select false, 'lead_responded', null::timestamptz;
    return;
  end if;
  if v_lead.callback_requested and v_action.action_type <> 'team_alert' then
    return query select false, 'callback_requested', null::timestamptz;
    return;
  end if;

  if coalesce((v_lead.custom_fields ->> '_skip_outbound_until_wait')::bool, false)
     and v_action.action_type in ('email','sms','call') then
    return query select false, 'skip_outbound_until_wait', null::timestamptz;
    return;
  end if;

  -- NEW: per-tenant per-channel kill switch.
  if coalesce((v_tenant.channel_pauses ->> v_action.action_type)::bool, false) then
    return query select false, 'channel_paused', null::timestamptz;
    return;
  end if;

  select count(*) into v_suppressed
    from suppressions
   where tenant_id = v_action.tenant_id
     and (channel is null or channel = v_action.action_type)
     and (
       (v_action.action_type = 'email' and email = v_lead.email)
       or (v_action.action_type in ('sms','call') and phone_e164 = v_lead.phone_e164)
     );
  if v_suppressed > 0 then
    return query select false, 'suppressed', null::timestamptz;
    return;
  end if;

  if v_tenant.status <> 'active' then
    return query select false, 'tenant_inactive', null::timestamptz;
    return;
  end if;

  if v_action.action_type in ('call', 'sms') then
    v_bh := v_tenant.business_hours;
    v_business_days := v_bh -> 'days';
    v_start := (v_bh ->> 'start')::time;
    v_end := (v_bh ->> 'end')::time;
    v_now_local := (now() at time zone v_tenant.timezone);
    v_local_time := v_now_local::time;
    v_local_dow := to_char(v_now_local, 'Dy');

    if not (v_business_days @> to_jsonb(v_local_dow))
       or v_local_time < v_start
       or v_local_time > v_end then
      return query select false, 'outside_business_hours',
        next_business_window(v_tenant.timezone, v_tenant.business_hours);
      return;
    end if;
  end if;

  return query select true, null::text, null::timestamptz;
end;
$function$;


-- ########################################################
-- advance_journey
-- ########################################################
CREATE OR REPLACE FUNCTION public.advance_journey(p_action_id uuid, p_outcome text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action       actions;
  v_lead         leads;
  v_tenant       tenants;
  v_journey      journeys;
  v_steps        jsonb;
  v_current_step jsonb;
  v_next_step    jsonb;
  v_exit         text;
  v_next_index   int;
  v_delay_amount numeric;
  v_delay_unit   text;
  v_run_at       timestamptz;
  v_new_action_id uuid;
  v_wait_mode    text;
  v_until_iso    text;
  v_on_passed    text;
  v_on_passed_step int;
  v_aw           jsonb;
  v_clamp_tz     text;
  v_next_type    text;
begin
  -- Atomic advance-claim. The first caller stamps advanced_at on the action's
  -- result; any concurrent/racing caller (replied vs timeout, or a duplicate
  -- retry) finds the key already present and no-ops. The UPDATE row-locks the
  -- action, serializing concurrent callers.
  update actions
     set result = coalesce(result, '{}'::jsonb)
                  || jsonb_build_object('advanced_at', now(),
                                        'advanced_outcome', p_outcome)
   where id = p_action_id
     and not (coalesce(result, '{}'::jsonb) ? 'advanced_at')
  returning * into v_action;

  if not found then
    return null;
  end if;

  select * into v_lead from leads where id = v_action.lead_id for update;
  select * into v_tenant from tenants where id = v_action.tenant_id;
  v_clamp_tz := coalesce(nullif(v_lead.timezone, ''), v_tenant.timezone);

  select * into v_journey
    from journeys
   where tenant_id = v_lead.tenant_id
     and journey_key = v_lead.journey_template
     and active
   order by version desc
   limit 1;
  if not found then
    update leads set journey_status = 'completed' where id = v_lead.id;
    return null;
  end if;

  v_steps := v_journey.spec -> 'steps';
  select s into v_current_step from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::int = v_action.step_index;

  v_exit := v_current_step -> 'on_outcome' -> p_outcome ->> 'exit';
  if v_exit is not null then
    update leads set journey_status = v_exit, updated_at = now() where id = v_lead.id;
    return null;
  end if;

  v_next_index := (v_current_step -> 'on_outcome' -> p_outcome ->> 'next_step')::int;
  if v_next_index is null then
    update leads set journey_status = 'completed' where id = v_lead.id;
    return null;
  end if;

  select s into v_next_step from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::int = v_next_index;
  if v_next_step is null then
    update leads set journey_status = 'completed' where id = v_lead.id;
    return null;
  end if;

  v_next_type := v_next_step ->> 'type';

  -- wait_reply shares the scheduling engine with wait (duration, until,
  -- advance_window) but has its own outcomes (replied/timeout) and does not
  -- use on_passed branching — if an `until` datetime already passed, the
  -- wait_reply times out immediately (run_at = now()).
  if v_next_type in ('wait', 'wait_reply') then
    v_wait_mode := coalesce(v_next_step ->> 'mode', 'duration');
    v_aw        := v_next_step -> 'advance_window';

    if v_wait_mode = 'until' then
      v_until_iso := v_next_step -> 'until' ->> 'datetime';
      if v_until_iso is null then
        v_run_at := now();
      else
        v_run_at := v_until_iso::timestamptz;
        if v_run_at <= now() then
          if v_next_type = 'wait' then
            v_on_passed := coalesce(v_next_step ->> 'on_passed', 'continue');
            v_on_passed_step := nullif(v_next_step ->> 'on_passed_step', '')::int;
            if v_on_passed = 'exit' then
              update leads set journey_status = 'completed', updated_at = now() where id = v_lead.id;
              return null;
            elsif v_on_passed = 'goto' and v_on_passed_step is not null then
              select s into v_next_step from jsonb_array_elements(v_steps) s
               where (s ->> 'index')::int = v_on_passed_step;
              if v_next_step is null then
                update leads set journey_status = 'completed' where id = v_lead.id;
                return null;
              end if;
              v_next_index := v_on_passed_step;
              v_run_at := now();
            elsif v_on_passed = 'skip_outbound' then
              update leads set custom_fields = coalesce(custom_fields, '{}'::jsonb)
                                              || jsonb_build_object('_skip_outbound_until_wait', true)
                where id = v_lead.id;
              v_run_at := now();
            else
              v_run_at := now();
            end if;
          else
            v_run_at := now();
          end if;
        end if;
      end if;
    else
      v_delay_amount := coalesce(
        (v_next_step -> 'duration' ->> 'amount')::numeric,
        (v_next_step -> 'delay'    ->> 'amount')::numeric,
        case when v_next_type = 'wait_reply' then 12 else 0 end
      );
      v_delay_unit := coalesce(
        v_next_step -> 'duration' ->> 'unit',
        v_next_step -> 'delay'    ->> 'unit',
        case when v_next_type = 'wait_reply' then 'hours' else 'minutes' end
      );
      v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
    end if;

    if v_aw is not null and coalesce((v_aw ->> 'enabled')::bool, false) then
      v_run_at := clamp_to_advance_window(v_run_at, v_aw, v_clamp_tz);
    end if;
  else
    v_delay_amount := coalesce((v_next_step -> 'delay' ->> 'amount')::numeric, 0);
    v_delay_unit   := coalesce( v_next_step -> 'delay' ->> 'unit', 'minutes');
    v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
  end if;

  insert into actions (
    tenant_id, lead_id, action_type, step_index, template_key,
    run_at, status, idempotency_key, payload
  ) values (
    v_lead.tenant_id, v_lead.id,
    v_next_step ->> 'type',
    v_next_index,
    v_next_step ->> 'template_key',
    v_run_at,
    'pending',
    v_lead.id::text || ':' || v_journey.journey_key || ':' || v_next_index::text || ':' || p_action_id::text,
    jsonb_build_object('enrolled_via', v_journey.journey_key, 'step_spec', v_next_step)
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_new_action_id;

  update leads
    set current_step = v_next_index,
        next_action_at = v_run_at,
        updated_at = now()
    where id = v_lead.id;

  return v_new_action_id;
end;
$function$;


-- ########################################################
-- record_send_event
-- ########################################################
CREATE OR REPLACE FUNCTION public.record_send_event(p_action_id uuid, p_provider text, p_provider_id text, p_outcome text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_event_id uuid;
  v_thread_id text  := p_payload->>'thread_id';
  v_message_id text := p_payload->>'message_id';
begin
  select * into v_action from actions where id = p_action_id;
  if not found then raise exception 'action not found: %', p_action_id; end if;
  select * into v_lead from leads where id = v_action.lead_id;

  if v_action.status = 'completed' then
    select id into v_event_id
      from events
     where action_id = p_action_id and direction = 'outbound'
     order by created_at limit 1;
    return v_event_id;
  end if;

  insert into events (
    tenant_id, lead_id, action_id, channel, direction,
    provider, provider_id, to_address, subject, body, raw_payload
  ) values (
    v_action.tenant_id, v_action.lead_id, v_action.id,
    v_action.action_type, 'outbound',
    p_provider, p_provider_id,
    case v_action.action_type
      when 'email' then v_lead.email
      when 'sms'   then v_lead.phone_e164
      when 'call'  then v_lead.phone_e164
      else null end,
    p_payload->>'subject',
    p_payload->>'body',
    p_payload
  ) returning id into v_event_id;

  update actions
     set status       = case when p_outcome = 'failed' then 'failed' else 'completed' end,
         provider     = p_provider,
         provider_id  = p_provider_id,
         result       = jsonb_build_object('outcome', p_outcome) || p_payload,
         completed_at = now(),
         -- NEW: don't carry stale failure text into a successful completion.
         -- On a real failure outcome we keep it (or set to the failure reason
         -- if a richer message is available from the payload).
         error_message = case
           when p_outcome = 'failed'
             then coalesce(p_payload->>'error_message', error_message)
           else null
         end,
         locked_until = null,
         locked_by    = null
   where id = p_action_id;

  update leads
     set last_action_at = now(),
         journey_status = case
           when journey_status = 'new' and p_outcome <> 'failed' then 'active'
           else journey_status
         end,
         email_thread_id = case
           when v_action.action_type = 'email' and p_outcome = 'sent' and v_thread_id is not null
             then v_thread_id
           else email_thread_id
         end,
         last_email_message_id = case
           when v_action.action_type = 'email' and p_outcome = 'sent' and v_message_id is not null
             then v_message_id
           else last_email_message_id
         end
   where id = v_action.lead_id;

  if v_action.action_type = 'email' and p_outcome = 'sent' and v_lead.assigned_sender_id is not null then
    update senders
       set sent_today = sent_today + 1,
           total_sent = total_sent + 1,
           last_sent_at = now()
     where id = v_lead.assigned_sender_id;
  end if;

  return v_event_id;
end;
$function$;


-- ########################################################
-- process_wait_action
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_wait_action(p_action_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lead_id uuid;
  v_next_id uuid;
begin
  select lead_id into v_lead_id from actions where id = p_action_id;

  update actions
     set status = 'completed',
         completed_at = now(),
         updated_at   = now()
   where id = p_action_id
     and action_type = 'wait'
     and status = 'pending';

  if not found then
    return null;
  end if;

  update leads
     set custom_fields = (custom_fields - '_skip_outbound_until_wait')
   where id = v_lead_id
     and (custom_fields ? '_skip_outbound_until_wait');

  v_next_id := advance_journey(p_action_id, 'default');
  return v_next_id;
end;
$function$;


-- ########################################################
-- process_retell_call_result
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_retell_call_result(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_call jsonb;
  v_call_id text;
  v_disconnection_reason text;
  v_duration_seconds int;
  v_recording_url text;
  v_transcript text;
  v_summary text;
  v_call_disposition text;
  v_call_successful boolean;
  v_call_analysis jsonb;
  v_custom_analysis jsonb;
  v_event events%rowtype;
  v_lead leads%rowtype;
  v_action actions%rowtype;
  v_tenant tenants%rowtype;
  v_call_outcome text;
  v_custom_outcome text;
  v_custom_disposition text;
  v_callback_requested boolean := false;
  v_callback_at timestamptz;
  v_new_action_id uuid;
  v_extracted_merge jsonb := '{}'::jsonb;
  v_field_key text;
  v_field_val jsonb;
  v_registered_keys text[] := '{}';
begin
  v_call := coalesce(p_payload->'body'->'call', p_payload->'call', p_payload);
  v_call_id := v_call->>'call_id';
  if v_call_id is null then raise exception 'Missing call_id in Retell payload'; end if;

  select * into v_event from events
   where provider = 'retell' and provider_id = v_call_id limit 1;
  if not found then raise exception 'Retell call event not found for call_id: %', v_call_id; end if;

  select * into v_lead from leads where id = v_event.lead_id;
  if not found then raise exception 'Lead not found for event: %', v_event.id; end if;

  if v_event.action_id is not null then
    select * into v_action from actions where id = v_event.action_id;
  end if;
  select * into v_tenant from tenants where id = v_event.tenant_id;

  v_disconnection_reason := v_call->>'disconnection_reason';
  v_duration_seconds := coalesce(
    (v_call->>'duration_seconds')::int,
    (coalesce(v_call->>'duration_ms','0')::bigint / 1000)::int
  );
  v_recording_url := v_call->>'recording_url';
  v_transcript := v_call->>'transcript';
  v_call_analysis := v_call->'call_analysis';
  v_summary := coalesce(v_call_analysis->>'call_summary', v_call_analysis->>'summary', v_call->>'summary');
  v_call_successful := coalesce((v_call_analysis->>'call_successful')::boolean, false);
  v_custom_analysis := v_call_analysis->'custom_analysis_data';
  v_call_disposition := coalesce(v_call_analysis->>'call_disposition', v_call->>'call_disposition');

  -- Full Retell disconnection_reason → builder outcome mapping.
  v_call_outcome := case v_disconnection_reason
    when 'user_hangup'                       then 'answered'
    when 'agent_hangup'                      then 'answered'
    when 'call_transfer'                     then 'answered'
    when 'inactivity'                        then 'answered'
    when 'max_duration_reached'              then 'answered'
    when 'voicemail_reached'                 then 'voicemail'
    when 'ivr_reached'                       then 'voicemail'
    when 'dial_no_answer'                    then 'no_answer'
    when 'user_declined'                     then 'no_answer'
    when 'dial_busy'                         then 'busy'
    when 'invalid_destination'               then 'invalid_number'
    when 'dial_failed'                       then 'failed'
    when 'marked_as_spam'                    then 'failed'
    when 'telephony_provider_permission_denied' then 'failed'
    when 'telephony_provider_unavailable'    then 'failed'
    when 'sip_routing_error'                 then 'failed'
    when 'concurrency_limit_reached'         then 'failed'
    when 'no_valid_payment'                  then 'failed'
    when 'scam_detected'                     then 'failed'
    when 'registered_call_timeout'           then 'failed'
    else case
      when v_disconnection_reason like 'error\_%' escape '\' then 'failed'
      when coalesce((v_call_analysis->>'in_voicemail')::boolean, false) then 'voicemail'
      else 'failed'
    end
  end;

  v_custom_outcome := coalesce(
    v_custom_analysis->>'call_outcome', v_call_analysis->>'call_outcome', v_call->>'call_outcome'
  );
  v_custom_disposition := coalesce(
    v_custom_analysis->>'call_disposition', v_call_analysis->>'call_disposition', v_call->>'call_disposition'
  );
  if v_custom_outcome in ('answered','no_answer','voicemail','busy','failed','invalid_number','wrong_number') then
    v_call_outcome := v_custom_outcome;
  elsif v_custom_disposition in ('answered','no_answer','voicemail','busy','failed','invalid_number','wrong_number') then
    v_call_outcome := v_custom_disposition;
  end if;

  v_callback_requested := coalesce(
    (v_custom_analysis->>'callback_requested')::boolean,
    (v_call_analysis->>'callback_requested')::boolean, false);
  if v_callback_requested then
    v_callback_at := (coalesce(
      v_custom_analysis->>'callback_timestamp', v_custom_analysis->>'callback_at',
      v_call_analysis->>'callback_timestamp',   v_call_analysis->>'callback_at'
    ))::timestamptz;
  end if;

  update events
     set call_outcome = v_call_outcome,
         call_disposition = coalesce(v_call_disposition, v_custom_disposition, v_call_outcome),
         call_duration_seconds = v_duration_seconds,
         call_recording_url = v_recording_url,
         call_transcript = v_transcript,
         call_summary = v_summary,
         disconnection_reason = v_disconnection_reason,
         raw_payload = coalesce(raw_payload,'{}'::jsonb) || p_payload
   where id = v_event.id;

  if v_action.id is not null then
    update actions set result = coalesce(result,'{}'::jsonb) || p_payload where id = v_action.id;
  end if;

  if v_custom_analysis is not null and jsonb_typeof(v_custom_analysis) = 'object' then
    v_extracted_merge := v_custom_analysis;
  end if;
  v_extracted_merge := v_extracted_merge
    || jsonb_build_object(
         'last_call_summary',          coalesce(v_summary, ''),
         'last_call_recording_url',    coalesce(v_recording_url, ''),
         'last_call_duration_seconds', coalesce(v_duration_seconds, 0),
         'last_call_outcome',          v_call_outcome,
         'last_call_at',               now()
       );

  update leads
     set last_action_at      = now(),
         responded           = case when v_call_outcome = 'answered' then true else responded end,
         callback_requested  = case when v_callback_requested then true else callback_requested end,
         callback_at         = case when v_callback_requested
                                    then coalesce(v_callback_at, callback_at, now() + interval '1 day')
                                    else callback_at end,
         custom_fields       = coalesce(custom_fields,'{}'::jsonb) || v_extracted_merge,
         updated_at          = now()
   where id = v_lead.id;

  if v_custom_analysis is not null and jsonb_typeof(v_custom_analysis) = 'object' then
    for v_field_key, v_field_val in select * from jsonb_each(v_custom_analysis) loop
      perform ensure_tenant_custom_field(
        v_event.tenant_id, v_field_key, null,
        infer_custom_field_type(v_field_val), 'Auto from Retell'
      );
      v_registered_keys := v_registered_keys || v_field_key;
    end loop;
  end if;
  perform ensure_tenant_custom_field(v_event.tenant_id, 'last_call_summary',          'Last call summary',          'multi_line', 'Call History');
  perform ensure_tenant_custom_field(v_event.tenant_id, 'last_call_recording_url',    'Last call recording',        'url',        'Call History');
  perform ensure_tenant_custom_field(v_event.tenant_id, 'last_call_duration_seconds', 'Last call duration (s)',     'number',     'Call History');
  perform ensure_tenant_custom_field(v_event.tenant_id, 'last_call_outcome',          'Last call outcome',          'single_line','Call History');
  perform ensure_tenant_custom_field(v_event.tenant_id, 'last_call_at',               'Last call at',               'date',       'Call History');

  -- Engagement cancel for answered calls. Done BEFORE advance_journey so the
  -- step queued by the journey's on_outcome.answered branch survives.
  -- Callback-requested calls don't fire engagement cancel — the lead asked
  -- for a follow-up; killing everything else is wrong here.
  if v_call_outcome = 'answered' and not v_callback_requested then
    perform cancel_pending_on_engagement(
      v_lead.id, 'call_answered',
      'Lead answered call ' || v_call_id || ' for ' || coalesce(v_duration_seconds::text,'?') || 's',
      v_action.id
    );
  end if;

  if v_action.id is not null and v_action.step_index >= 0 then
    v_new_action_id := advance_journey(v_action.id, v_call_outcome);
  end if;

  if v_callback_requested then
    insert into actions (tenant_id, lead_id, action_type, step_index, template_key,
                         run_at, status, idempotency_key, payload)
         values (v_event.tenant_id, v_lead.id, 'team_alert', coalesce(v_action.step_index, -1),
                 'team_callback_alert', now(), 'pending',
                 v_lead.id::text || ':callback_requested:' || v_call_id,
                 jsonb_build_object('reason','callback_requested',
                                    'call_id', v_call_id,
                                    'callback_at', v_callback_at,
                                    'summary', v_summary));
  end if;

  return jsonb_build_object(
    'status','success',
    'call_outcome', v_call_outcome,
    'disconnection_reason', v_disconnection_reason,
    'callback_requested', v_callback_requested,
    'new_action_id', v_new_action_id,
    'auto_registered_keys', v_registered_keys
  );
end;
$function$;


-- ########################################################
-- process_action_set_lead_fields
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_action_set_lead_fields(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_journey journeys;
  v_step jsonb;
  v_fields jsonb;
  v_field jsonb;
  v_key text;
  v_val text;
  v_resolved text;
  v_mode text;
  v_applied int := 0;
  v_skipped int := 0;
  v_skipped_keys text[] := '{}';
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status = 'completed' then return jsonb_build_object('status','already_completed'); end if;

  select * into v_lead from leads where id = v_action.lead_id;

  select * into v_journey
    from journeys
   where tenant_id = v_action.tenant_id
     and journey_key = v_lead.journey_template
     and active
   order by version desc
   limit 1;
  if not found then
    update actions set status='failed', error_message='journey not found' where id = p_action_id;
    return jsonb_build_object('status','failed','reason','journey_not_found');
  end if;

  select s into v_step
    from jsonb_array_elements(v_journey.spec->'steps') s
   where (s->>'index')::int = v_action.step_index;

  v_mode := coalesce(v_step->>'mode', 'set');

  v_fields := v_step->'fields';
  if v_fields is null or jsonb_array_length(v_fields) = 0 then
    if v_step ? 'update_field' then
      v_fields := jsonb_build_array(
        jsonb_build_object('key', v_step->>'update_field', 'value', v_step->>'update_value')
      );
    else
      v_fields := '[]'::jsonb;
    end if;
  end if;

  for v_field in select * from jsonb_array_elements(v_fields) loop
    v_key := v_field->>'key';
    v_val := v_field->>'value';
    if v_key is null or v_key = '' then continue; end if;

    if v_mode = 'clear' then
      -- NULL-out nullable cols, remove custom keys from jsonb. NOT NULL columns are skipped.
      if v_key = 'first_name' then
        update leads set first_name = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'last_name' then
        update leads set last_name = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'email' then
        update leads set email = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'phone' then
        update leads set phone_raw = null, phone_e164 = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'campaign_type' then
        update leads set campaign_type = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'zip_code' then
        update leads set zip_code = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'address' then
        update leads set address_line1 = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'timezone' then
        update leads set timezone = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'responded' then
        update leads set responded = false, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'opt_out' then
        update leads set opt_out = false, opt_out_channel = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key = 'callback_requested' then
        update leads set callback_requested = false, callback_at = null, updated_at = now() where id = v_lead.id;
        v_applied := v_applied + 1;
      elsif v_key like 'custom.%' then
        update leads
           set custom_fields = coalesce(custom_fields,'{}'::jsonb) - substr(v_key, 8),
               updated_at = now()
         where id = v_lead.id;
        v_applied := v_applied + 1;
      else
        -- source / journey_status are NOT NULL — refuse to clear.
        v_skipped := v_skipped + 1;
        v_skipped_keys := v_skipped_keys || v_key;
      end if;

    else
      -- set mode: original behavior, coalesce-style.
      v_resolved := resolve_merge_tags(coalesce(v_val,''), v_lead);
      if v_resolved is null or v_resolved = '' then continue; end if;

      if v_key = 'first_name' then
        update leads set first_name = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'last_name' then
        update leads set last_name = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'email' then
        update leads set email = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'phone' then
        update leads set phone_raw = v_resolved, phone_e164 = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'campaign_type' then
        update leads set campaign_type = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'source' then
        update leads set source = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'zip_code' then
        update leads set zip_code = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'address' then
        update leads set address_line1 = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'timezone' then
        update leads set timezone = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'journey_status' then
        update leads set journey_status = v_resolved, updated_at = now() where id = v_lead.id;
      elsif v_key = 'responded' then
        update leads set responded = lower(v_resolved)::boolean, updated_at = now() where id = v_lead.id;
      elsif v_key = 'opt_out' then
        update leads set opt_out = lower(v_resolved)::boolean, updated_at = now() where id = v_lead.id;
      elsif v_key = 'callback_requested' then
        update leads set callback_requested = lower(v_resolved)::boolean, updated_at = now() where id = v_lead.id;
      elsif v_key like 'custom.%' then
        update leads
           set custom_fields = jsonb_set(coalesce(custom_fields,'{}'::jsonb), array[substr(v_key,8)], to_jsonb(v_resolved)),
               updated_at = now()
         where id = v_lead.id;
      else
        update leads
           set custom_fields = jsonb_set(coalesce(custom_fields,'{}'::jsonb), array[v_key], to_jsonb(v_resolved)),
               updated_at = now()
         where id = v_lead.id;
      end if;
      v_applied := v_applied + 1;
    end if;
  end loop;

  update actions
     set status = 'completed',
         result = jsonb_build_object(
           'outcome','default',
           'mode', v_mode,
           'fields_applied', v_applied,
           'fields_skipped', v_skipped,
           'skipped_keys', to_jsonb(v_skipped_keys)
         ),
         completed_at = now()
   where id = p_action_id;

  insert into events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object('step_type', v_action.action_type, 'mode', v_mode,
                             'fields_applied', v_applied, 'fields_skipped', v_skipped));

  perform advance_journey(p_action_id, 'default');

  return jsonb_build_object('status','success','mode', v_mode,
                            'fields_applied', v_applied, 'fields_skipped', v_skipped);
end;
$function$;


-- ########################################################
-- process_action_find_lead
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_action_find_lead(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_journey journeys;
  v_step jsonb;
  v_filters jsonb;
  v_strategy text;
  v_filter jsonb;
  v_key text;
  v_val text;
  v_resolved text;
  v_clause text;
  v_where text := '';
  v_joiner text;
  v_query text;
  v_found_id uuid;
  v_outcome text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status = 'completed' then return jsonb_build_object('status','already_completed'); end if;

  select * into v_lead from leads where id = v_action.lead_id;

  select * into v_journey
    from journeys
   where tenant_id = v_action.tenant_id
     and journey_key = v_lead.journey_template
     and active
   order by version desc
   limit 1;
  if not found then
    update actions set status='failed', error_message='journey not found' where id = p_action_id;
    return jsonb_build_object('status','failed','reason','journey_not_found');
  end if;

  select s into v_step
    from jsonb_array_elements(v_journey.spec->'steps') s
   where (s->>'index')::int = v_action.step_index;

  v_filters := coalesce(v_step->'filters', '[]'::jsonb);
  v_strategy := coalesce(v_step->>'match_strategy', 'all');
  v_joiner := case when v_strategy = 'any' then ' OR ' else ' AND ' end;

  for v_filter in select * from jsonb_array_elements(v_filters) loop
    v_key := v_filter->>'key';
    v_val := v_filter->>'value';
    if v_key is null or v_key = '' or v_val is null then continue; end if;
    v_resolved := resolve_merge_tags(v_val, v_lead);
    if v_resolved is null or v_resolved = '' then continue; end if;

    v_clause := null;
    if v_key = 'email' then
      v_clause := format('lower(coalesce(email,'''')) = lower(%L)', v_resolved);
    elsif v_key = 'phone' then
      v_clause := format('(phone_e164 = %L OR phone_raw = %L)', v_resolved, v_resolved);
    elsif v_key = 'first_name' then
      v_clause := format('lower(coalesce(first_name,'''')) = lower(%L)', v_resolved);
    elsif v_key = 'last_name' then
      v_clause := format('lower(coalesce(last_name,'''')) = lower(%L)', v_resolved);
    elsif v_key like 'custom.%' then
      v_clause := format('custom_fields ->> %L = %L', substr(v_key, 8), v_resolved);
    end if;

    if v_clause is not null then
      if v_where <> '' then v_where := v_where || v_joiner; end if;
      v_where := v_where || v_clause;
    end if;
  end loop;

  if v_where = '' then
    v_outcome := 'not_found';
  else
    v_query := format('select id from leads where tenant_id = %L and (%s) limit 1',
                      v_action.tenant_id, v_where);
    execute v_query into v_found_id;
    v_outcome := case when v_found_id is not null then 'found' else 'not_found' end;
  end if;

  update actions
     set status = 'completed',
         result = jsonb_build_object(
           'outcome', v_outcome, 'found_lead_id', v_found_id,
           'where_clause', v_where, 'strategy', v_strategy
         ),
         completed_at = now()
   where id = p_action_id;

  insert into events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object('step_type','find_lead','outcome',v_outcome,'found_lead_id',v_found_id));

  perform advance_journey(p_action_id, v_outcome);

  return jsonb_build_object('status','success','outcome', v_outcome, 'found_lead_id', v_found_id);
end;
$function$;


-- ########################################################
-- process_action_conditional_split
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_action_conditional_split(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_journey journeys;
  v_step jsonb;
  v_condition jsonb;
  v_outcome text;
  v_next_action_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('status', 'failed', 'reason', 'action_not_found');
  end if;
  if v_action.status = 'completed' then
    return jsonb_build_object('status', 'already_completed');
  end if;

  select * into v_lead from leads where id = v_action.lead_id;

  select * into v_journey
    from journeys
    where tenant_id = v_action.tenant_id
      and journey_key = v_lead.journey_template
      and active
    order by version desc
    limit 1;

  if not found then
    update actions set status = 'failed', error_message = 'journey not found' where id = p_action_id;
    return jsonb_build_object('status', 'failed', 'reason', 'journey_not_found');
  end if;

  select s into v_step
    from jsonb_array_elements(v_journey.spec->'steps') s
   where (s->>'index')::int = v_action.step_index;

  v_condition := v_step->'condition';

  if evaluate_condition(v_condition, v_lead.id) then
    v_outcome := 'yes';
  else
    v_outcome := 'no';
  end if;

  update actions
     set status = 'completed',
         result = jsonb_build_object('outcome', v_outcome, 'condition_evaluated', v_condition),
         completed_at = now()
   where id = p_action_id;

  insert into events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object('step_type', 'conditional_split', 'outcome', v_outcome, 'condition', v_condition));

  v_next_action_id := advance_journey(p_action_id, v_outcome);

  return jsonb_build_object(
    'status', 'success',
    'outcome', v_outcome,
    'next_action_id', v_next_action_id
  );
end;
$function$;


-- ########################################################
-- process_team_alert_action
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_team_alert_action(p_action_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return; end if;

  -- Log to error_logs so the operator sees the alert on the Errors/Ops page.
  insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
       values (
         v_action.tenant_id,
         'team_alert',
         'Team alert: ' || coalesce(v_action.payload->>'reason', 'unspecified'),
         v_action.payload,
         'info',
         'open'
       );

  -- Mark completed.
  update actions
     set status='completed',
         completed_at=now(),
         locked_until=null,
         locked_by=null,
         result=jsonb_build_object('processed_inline', true,
                                   'note', 'team_alert acknowledged + logged to error_logs')
   where id = p_action_id;
end;
$function$;


-- ########################################################
-- cancel_pending_on_engagement
-- ########################################################
CREATE OR REPLACE FUNCTION public.cancel_pending_on_engagement(p_lead_id uuid, p_engagement text, p_reason text DEFAULT NULL::text, p_source_action_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lead leads;
  v_msg text;
  v_cancelled_ids uuid[];
  v_cancelled_count int := 0;
begin
  select * into v_lead from leads where id = p_lead_id;
  if not found then
    return jsonb_build_object('status','lead_not_found');
  end if;

  v_msg := 'Cancelled by engagement: ' || p_engagement ||
           case when p_reason is not null then ' — ' || p_reason else '' end;

  with cancelled as (
    update actions
       set status        = 'cancelled',
           error_message = v_msg,
           locked_until  = null,
           locked_by     = null
     where lead_id    = p_lead_id
       and status     = 'pending'
       and action_type not in ('team_alert','wait_reply')
       and (p_source_action_id is null or id <> p_source_action_id)
     returning id
  )
  select array_agg(id), count(*)::int
    from cancelled
    into v_cancelled_ids, v_cancelled_count;

  if v_cancelled_count > 0 then
    insert into events (tenant_id, lead_id, channel, direction, provider, body, raw_payload)
    values (
      v_lead.tenant_id, p_lead_id, 'system', 'internal', 'engine',
      v_msg || ' (' || v_cancelled_count || ' action' ||
        case when v_cancelled_count = 1 then '' else 's' end || ' cancelled)',
      jsonb_build_object(
        'engagement',       p_engagement,
        'reason',           p_reason,
        'source_action_id', p_source_action_id,
        'cancelled_ids',    to_jsonb(v_cancelled_ids),
        'cancelled_count',  v_cancelled_count
      )
    );

    insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (
      v_lead.tenant_id,
      'engagement_cancel',
      v_msg || ' (' || v_cancelled_count || ' cancelled)',
      jsonb_build_object(
        'lead_id',          p_lead_id,
        'engagement',       p_engagement,
        'cancelled_ids',    to_jsonb(v_cancelled_ids),
        'cancelled_count',  v_cancelled_count
      ),
      'info', 'open'
    );
  end if;

  return jsonb_build_object(
    'status',           'success',
    'cancelled_count',  v_cancelled_count,
    'cancelled_ids',    to_jsonb(coalesce(v_cancelled_ids, '{}'::uuid[]))
  );
end;
$function$;


-- ########################################################
-- process_inbound_sms
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_inbound_sms(p_from text, p_to text, p_body text, p_message_sid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_lead leads;
  v_event_id uuid;
  v_max_ai_replies int := 5;
  v_history jsonb := '[]'::jsonb;
  v_credentials tenant_credentials;
  v_clean_body text := lower(trim(p_body));
  v_wait_reply_id uuid;
  v_is_opt_out boolean;
begin
  v_tenant_id := resolve_tenant_by_phone(p_to);
  if v_tenant_id is null then
    insert into events (tenant_id, channel, direction, provider, provider_id,
                        from_address, to_address, body, raw_payload)
         values ('00000000-0000-0000-0000-000000000001', 'sms', 'inbound', 'twilio',
                 p_message_sid, p_from, p_to, p_body,
                 jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid));
    return jsonb_build_object('status','unknown_tenant');
  end if;

  select * into v_lead
    from leads
   where tenant_id = v_tenant_id
     and (phone_e164 = p_from or phone_e164 = '+' || p_from or phone_e164 = replace(p_from, '+', ''))
   order by created_at desc
   limit 1
   for update;

  if not found then
    insert into events (tenant_id, channel, direction, provider, provider_id,
                        from_address, to_address, body, raw_payload)
         values (v_tenant_id, 'sms', 'inbound', 'twilio', p_message_sid, p_from, p_to, p_body,
                 jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid));
    return jsonb_build_object('status','unknown_lead','tenant_id', v_tenant_id);
  end if;

  insert into events (tenant_id, lead_id, channel, direction, provider, provider_id,
                      from_address, to_address, body, raw_payload)
       values (v_tenant_id, v_lead.id, 'sms', 'inbound', 'twilio', p_message_sid, p_from, p_to, p_body,
               jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid))
   returning id into v_event_id;

  update leads set responded=true, last_action_at=now(), updated_at=now() where id = v_lead.id;

  v_is_opt_out := v_clean_body in ('stop', 'unsubscribe', 'cancel', 'quit', 'end');

  -- Engagement cancel BEFORE consuming wait_reply, so the action created by
  -- advance_journey (called below) survives. Skipped on opt-out paths — those
  -- cancel everything (including team_alerts) via the explicit branch.
  if not v_is_opt_out then
    perform cancel_pending_on_engagement(v_lead.id, 'sms_reply',
      'Inbound SMS from ' || p_from, null);
  end if;

  -- Consume wait_reply and advance the journey on 'replied'.
  update actions
     set status = 'completed'
   where action_type = 'wait_reply'
     and status = 'pending'
     and lead_id = v_lead.id
   returning id into v_wait_reply_id;
  if v_wait_reply_id is not null then
    perform advance_journey(v_wait_reply_id, 'replied');
  end if;

  if v_is_opt_out then
    update leads set opt_out=true, journey_status='opted_out', opt_out_channel='sms', updated_at=now()
     where id = v_lead.id;
    perform add_suppression(v_tenant_id, 'sms', v_lead.phone_e164, 'opt_out',
                            v_lead.id, 'inbound_sms', 'User replied ' || p_body);
    update actions set status='cancelled' where lead_id = v_lead.id and status = 'pending';

    select * into v_credentials from tenant_credentials
     where tenant_id = v_tenant_id and provider = 'twilio' and active = true;

    return jsonb_build_object('status','opt_out','lead_id', v_lead.id, 'tenant_id', v_tenant_id,
                              'phone_to', v_lead.phone_e164,
                              'twilio_credential_name', v_credentials.n8n_credential_name,
                              'twilio_from_number', v_credentials.config->>'from_number');
  end if;

  select coalesce((config->>'max_ai_replies')::int, 5) into v_max_ai_replies
    from tenants where id = v_tenant_id;

  if v_lead.sms_conversation_count >= v_max_ai_replies then
    insert into actions (tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload)
         values (v_tenant_id, v_lead.id, 'team_alert', v_lead.current_step, now(), 'pending',
                 v_lead.id::text || ':sms_max_replies_alert',
                 jsonb_build_object('reason','max_ai_replies_exceeded','conversation_count', v_lead.sms_conversation_count));
    return jsonb_build_object('status','max_replies_exceeded','lead_id', v_lead.id, 'tenant_id', v_tenant_id);
  end if;

  update leads set sms_conversation_count = sms_conversation_count + 1 where id = v_lead.id;

  select * into v_credentials from tenant_credentials
   where tenant_id = v_tenant_id and provider = 'twilio' and active = true;
  if not found then
    return jsonb_build_object('status','credentials_missing','lead_id', v_lead.id, 'tenant_id', v_tenant_id);
  end if;

  select json_agg(t) into v_history
    from (
      select case when direction='inbound' then 'user' else 'assistant' end as role,
             body as content
        from (
          select direction, body, created_at
            from events
           where lead_id = v_lead.id and channel = 'sms'
           order by created_at desc limit 10
        ) sub2
       order by created_at asc
    ) t;

  return jsonb_build_object(
    'status','success',
    'lead_id', v_lead.id,
    'tenant_id', v_tenant_id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'twilio_credential_name', v_credentials.n8n_credential_name,
    'twilio_from_number', v_credentials.config->>'from_number',
    'history', coalesce(v_history, '[]'::jsonb)
  );
end;
$function$;


-- ########################################################
-- process_inbound_email
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_inbound_email(p_from_email text, p_to_email text, p_subject text, p_body text, p_message_id text, p_thread_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_lead leads;
  v_event_id uuid;
  v_history jsonb := '[]'::jsonb;
  v_sender senders;
  v_wait_reply_id uuid;
  v_clean_body text := lower(trim(p_body));
  v_clean_subject text := lower(coalesce(p_subject,''));
  v_clean_from text := lower(coalesce(p_from_email,''));
  v_is_bounce bool := false;
  v_failed_addr text;
  v_smtp_code text;
  v_is_hard_bounce bool := false;
  v_original_event events;
  v_orig_action actions;
  v_canceled int;
  v_is_opt_out boolean;
  v_match_strategy text;
  v_agent ai_agents;
  v_agent_id uuid;
  v_tenant_ai_on bool;
  v_journey_agent_id uuid;
  v_ai_action_id uuid;
begin
  select tenant_id into v_tenant_id
    from senders
   where lower(sender_email) = lower(p_to_email) and active = true
   limit 1;
  if v_tenant_id is null then
    v_tenant_id := '00000000-0000-0000-0000-000000000001';
  end if;

  v_is_bounce :=
       v_clean_from like '%mailer-daemon%'
    or v_clean_from like '%postmaster@%'
    or v_clean_from like 'bounce-%@%'
    or v_clean_subject like '%delivery status notification%'
    or v_clean_subject like '%undelivered mail%'
    or v_clean_subject like '%mail delivery failed%'
    or v_clean_subject like '%returned mail%';

  -- BOUNCE PATH (unchanged) --
  if v_is_bounce then
    v_failed_addr := (regexp_match(coalesce(p_body,''), 'X-Failed-Recipients:\s*([^\s,;]+)', 'i'))[1];
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), 'Final-Recipient:\s*[A-Za-z0-9-]+;\s*([^\s]+)', 'i'))[1];
    end if;
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), 'delivered\s+to\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})', 'i'))[1];
    end if;
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), '<([^<>\s]+@[^<>\s]+)>', 'i'))[1];
    end if;
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})'))[1];
      if lower(coalesce(v_failed_addr,'')) = v_clean_from then v_failed_addr := null; end if;
    end if;

    v_smtp_code := (regexp_match(coalesce(p_body,''), '\y(5\d{2}|4\d{2})\y', 'i'))[1];
    v_is_hard_bounce := coalesce(v_smtp_code like '5%', false)
                     or v_clean_body like '%address not found%'
                     or v_clean_body like '%no such user%'
                     or v_clean_body like '%user unknown%'
                     or v_clean_body like '%mailbox unavailable%'
                     or v_clean_body like '%recipient address rejected%'
                     or v_clean_body like '%message blocked%';

    insert into events (tenant_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload)
         values (v_tenant_id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
                 jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id, 'bounce', true,
                                    'bounce_hard', v_is_hard_bounce, 'smtp_code', v_smtp_code,
                                    'failed_recipient', v_failed_addr));

    if v_failed_addr is null then
      insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
           values (v_tenant_id, 'email_bounce', 'Bounce detected but no recipient extracted',
                   jsonb_build_object('from', p_from_email, 'subject', p_subject, 'body_preview', left(p_body, 500)),
                   'warning', 'open');
      return jsonb_build_object('status','bounce_recorded_no_recipient', 'tenant_id', v_tenant_id);
    end if;

    select * into v_lead from leads where tenant_id = v_tenant_id and lower(email) = lower(v_failed_addr) order by created_at desc limit 1;
    select e.* into v_original_event from events e
      where e.tenant_id = v_tenant_id and e.channel='email' and e.direction='outbound' and e.provider='gmail'
        and lower(e.to_address) = lower(v_failed_addr) and e.created_at > now() - interval '72 hours'
      order by e.created_at desc limit 1;

    if v_original_event.action_id is not null then
      select * into v_orig_action from actions where id = v_original_event.action_id;
      if v_orig_action.id is not null and v_orig_action.status = 'completed' then
        update actions
           set status='failed',
               error_message = 'Email bounced. SMTP ' || coalesce(v_smtp_code, 'unknown') || ' from ' || coalesce(p_from_email,'') || '. Subject: ' || coalesce(p_subject,''),
               result = coalesce(result,'{}'::jsonb) || jsonb_build_object('bounce', true, 'bounce_hard', v_is_hard_bounce, 'smtp_code', v_smtp_code, 'bounce_event_id', p_message_id)
         where id = v_orig_action.id;
      end if;
    end if;

    perform add_suppression(v_tenant_id, 'email', v_failed_addr,
      case when v_is_hard_bounce then 'bounce_hard' else 'bounce_soft' end,
      v_lead.id, 'inbound_email_bounce',
      'SMTP ' || coalesce(v_smtp_code,'?') || ' — ' || left(coalesce(p_subject,''), 180));

    if v_lead.id is not null and v_is_hard_bounce then
      update leads set opt_out=true, opt_out_channel='email',
                       journey_status = case when journey_status='active' then 'opted_out' else journey_status end,
                       updated_at=now()
       where id = v_lead.id;
      update actions set status='cancelled', error_message='Cancelled: lead email hard-bounced'
       where lead_id = v_lead.id and status='pending';
      get diagnostics v_canceled = row_count;
    end if;

    insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
         values (v_tenant_id, 'email_bounce',
                 'Email bounced for ' || v_failed_addr || ' (' || (case when v_is_hard_bounce then 'hard' else 'soft' end) || ', SMTP ' || coalesce(v_smtp_code,'?') || ')',
                 jsonb_build_object('failed_recipient', v_failed_addr, 'lead_id', v_lead.id,
                                    'original_event_id', v_original_event.id,
                                    'original_action_id', v_original_event.action_id,
                                    'smtp_code', v_smtp_code, 'hard', v_is_hard_bounce, 'subject', p_subject),
                 case when v_is_hard_bounce then 'error' else 'warning' end, 'open');

    return jsonb_build_object('status', case when v_is_hard_bounce then 'bounce_hard' else 'bounce_soft' end,
                              'tenant_id', v_tenant_id, 'failed_recipient', v_failed_addr,
                              'smtp_code', v_smtp_code, 'lead_id', v_lead.id,
                              'original_action_id', v_original_event.action_id, 'cancelled_pending', v_canceled);
  end if;

  -- NON-BOUNCE PATH --
  v_match_strategy := 'none';
  if p_thread_id is not null and length(p_thread_id) > 0 then
    select * into v_lead from leads
     where tenant_id = v_tenant_id and email_thread_id = p_thread_id
     order by last_action_at desc nulls last, created_at desc limit 1 for update;
    if found then v_match_strategy := 'thread'; end if;
  end if;
  if not found then
    select * into v_lead from leads
     where tenant_id = v_tenant_id and lower(email) = lower(p_from_email)
     order by created_at desc limit 1 for update;
    if found then v_match_strategy := 'from_address'; end if;
  end if;

  if not found then
    insert into events (tenant_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload)
         values (v_tenant_id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
                 jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id, 'match_strategy', 'unmatched'));
    return jsonb_build_object('status','unknown_lead','tenant_id', v_tenant_id);
  end if;

  insert into events (tenant_id, lead_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload)
       values (v_tenant_id, v_lead.id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
               jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id, 'match_strategy', v_match_strategy))
   returning id into v_event_id;

  update leads set responded=true, email_thread_id=p_thread_id, last_email_message_id=p_message_id,
                   last_action_at=now(), updated_at=now()
   where id = v_lead.id;

  v_is_opt_out := v_clean_body like '%stop%' or v_clean_body like '%unsubscribe%' or v_clean_body like '%cancel%';

  if not v_is_opt_out then
    perform cancel_pending_on_engagement(v_lead.id, 'email_reply', 'Inbound email from ' || p_from_email, null);
  end if;

  update actions set status='completed'
   where action_type='wait_reply' and status='pending' and lead_id = v_lead.id
   returning id into v_wait_reply_id;
  if v_wait_reply_id is not null then perform advance_journey(v_wait_reply_id, 'replied'); end if;

  if v_is_opt_out then
    update leads set opt_out=true, journey_status='opted_out', opt_out_channel='email', updated_at=now() where id = v_lead.id;
    perform add_suppression(v_tenant_id, 'email', v_lead.email, 'opt_out', v_lead.id, 'inbound_email',
                            'User replied STOP/UNSUBSCRIBE/CANCEL');
    update actions set status='cancelled' where lead_id = v_lead.id and status='pending';
    return jsonb_build_object('status','opt_out','lead_id', v_lead.id, 'tenant_id', v_tenant_id);
  end if;

  -- AI REPLY ENQUEUE (Phase 2) --
  -- Resolve which agent (if any) handles this lead:
  --   * Tenant master switch must be on
  --   * Per-journey override > tenant default
  --   * Agent must exist + be enabled
  --   * Lead's email_conversation_count must be under agent.max_replies_per_lead
  -- Anything failing → skip AI, return success normally (the inbound is
  -- recorded; operator sees it in the conversation view).

  select ai_replies_enabled into v_tenant_ai_on from tenants where id = v_tenant_id;
  if v_lead.journey_template is not null then
    select j.ai_agent_id into v_journey_agent_id
      from journeys j
     where j.tenant_id = v_tenant_id and j.journey_key = v_lead.journey_template and j.active = true
     order by j.version desc limit 1;
  end if;
  if v_journey_agent_id is not null then
    v_agent_id := v_journey_agent_id;
  else
    select default_ai_agent_id into v_agent_id from tenants where id = v_tenant_id;
  end if;

  if coalesce(v_tenant_ai_on, false) and v_agent_id is not null then
    select * into v_agent from ai_agents where id = v_agent_id and enabled = true;
    if v_agent.id is not null then
      if v_lead.email_conversation_count >= v_agent.max_replies_per_lead then
        -- Cap hit: escalate immediately instead of asking the LLM.
        insert into actions (tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload)
             values (v_tenant_id, v_lead.id, 'team_alert', v_lead.current_step, now(), 'pending',
                     'ai_cap_alert:' || v_event_id::text,
                     jsonb_build_object('reason','ai_max_replies_exceeded',
                                        'agent_id', v_agent.id,
                                        'inbound_event_id', v_event_id,
                                        'conversation_count', v_lead.email_conversation_count))
        on conflict (tenant_id, idempotency_key) do nothing;
      else
        -- Enqueue the AI reply action. The dispatcher will hand it to
        -- generate-ai-reply via pg_net on the next tick.
        insert into actions (tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload)
             values (v_tenant_id, v_lead.id, 'ai_reply', v_lead.current_step, now(), 'pending',
                     'ai_reply:' || v_event_id::text,
                     jsonb_build_object('source','inbound_email_reply',
                                        'agent_id', v_agent.id,
                                        'inbound_event_id', v_event_id,
                                        'inbound_from', p_from_email,
                                        'inbound_subject', p_subject,
                                        'inbound_thread_id', p_thread_id))
        on conflict (tenant_id, idempotency_key) do nothing
        returning id into v_ai_action_id;
      end if;
    end if;
  end if;

  update leads set email_conversation_count = email_conversation_count + 1 where id = v_lead.id;

  select json_agg(t) into v_history
    from (
      select case when direction='inbound' then 'user' else 'assistant' end as role, body as content
        from (
          select direction, body, created_at from events
           where lead_id = v_lead.id and channel = 'email'
           order by created_at desc limit 10
        ) sub2
       order by created_at asc
    ) t;

  select * into v_sender from senders where id = v_lead.assigned_sender_id;
  if v_sender.id is null then
    select * into v_sender from senders where tenant_id = v_tenant_id and active = true limit 1;
  end if;

  return jsonb_build_object(
    'status','success',
    'lead_id', v_lead.id,
    'tenant_id', v_tenant_id,
    'match_strategy', v_match_strategy,
    'ai_reply_enqueued', v_ai_action_id,
    'sender_id', v_sender.id,
    'sender_email', v_sender.sender_email,
    'sender_name', v_sender.sender_name,
    'history', coalesce(v_history, '[]'::jsonb)
  );
end;
$function$;


-- ########################################################
-- process_journey_webhook
-- ########################################################
CREATE OR REPLACE FUNCTION public.process_journey_webhook(p_token text, p_payload jsonb, p_headers jsonb DEFAULT '{}'::jsonb, p_auth_header text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_journey journeys;
  v_mapping jsonb;
  v_lead_field text;
  v_map_entry  jsonb;
  v_lead_first text;
  v_lead_last  text;
  v_lead_email text;
  v_lead_phone text;
  v_lead_id    uuid;
  v_existing_lead leads;
  v_step0      jsonb;
  v_run_at     timestamptz;
  v_action_id  uuid;
  v_custom_fields jsonb := '{}'::jsonb;
  v_path text;
  v_val  text;
  v_provided_token text;
  v_sample_id uuid;
  v_result jsonb;

  v_stamped_lead_id_text text;
  v_stamped_lead_id      uuid;
begin
  select * into v_journey from journeys where webhook_token = p_token and active = true;
  if not found then
    return jsonb_build_object('status','failed','reason','journey_not_found_for_token');
  end if;

  if v_journey.webhook_auth_mode = 'bearer' then
    if p_auth_header is null then
      return jsonb_build_object('status','auth_failed','reason','missing_authorization_header');
    end if;
    v_provided_token := trim(regexp_replace(p_auth_header, '^[Bb]earer\s+', ''));
    if v_provided_token is null or v_provided_token = ''
       or v_provided_token <> coalesce(v_journey.webhook_secret, '') then
      return jsonb_build_object('status','auth_failed','reason','invalid_secret');
    end if;
  end if;

  insert into journey_webhook_samples (journey_id, payload, headers)
       values (v_journey.id, p_payload, p_headers) returning id into v_sample_id;
  delete from journey_webhook_samples
   where id in (
     select id from journey_webhook_samples
      where journey_id = v_journey.id
      order by received_at desc offset 20);

  -- followup_lead_id fixed-path lookup wins outright.
  v_stamped_lead_id_text := coalesce(
    _extract_json_path(p_payload, 'metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'followup_lead_id'),
    _extract_json_path(p_payload, 'body.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'body.call.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'body.call.dynamic_variables.followup_lead_id'),
    _extract_json_path(p_payload, 'call.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'call.dynamic_variables.followup_lead_id')
  );

  if v_stamped_lead_id_text is not null and v_stamped_lead_id_text <> '' then
    begin
      v_stamped_lead_id := v_stamped_lead_id_text::uuid;
    exception when others then
      v_stamped_lead_id := null;
    end;

    if v_stamped_lead_id is not null then
      select * into v_existing_lead
        from leads
       where id = v_stamped_lead_id and tenant_id = v_journey.tenant_id;

      if found then
        v_lead_id := v_existing_lead.id;
        update leads
           set journey_template = v_journey.journey_key,
               journey_status   = case when journey_status in ('completed','error') then 'active' else journey_status end,
               raw_payload      = p_payload,
               updated_at       = now()
         where id = v_lead_id;

        select s into v_step0 from jsonb_array_elements(v_journey.spec->'steps') s where (s->>'index')::int = 0;
        if v_step0 is not null then
          insert into actions (
            tenant_id, lead_id, action_type, step_index, template_key,
            run_at, status, idempotency_key, payload
          ) values (
            v_journey.tenant_id, v_lead_id, v_step0->>'type', 0, v_step0->>'template_key',
            now(), 'pending',
            v_lead_id::text || ':' || v_journey.journey_key || ':0:stamped:' || extract(epoch from now())::text,
            jsonb_build_object('enrolled_via','webhook','step_spec', v_step0)
          )
          on conflict (tenant_id, idempotency_key) do nothing
          returning id into v_action_id;
        end if;

        v_result := jsonb_build_object(
          'status','success', 'lead_id', v_lead_id, 'action_id', v_action_id,
          'journey_key', v_journey.journey_key, 'matched_via','followup_lead_id'
        );
        update journey_webhook_samples
           set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
               result_message='Lead matched via followup_lead_id, step 0 queued.'
         where id = v_sample_id;
        return v_result;
      end if;
      v_result := jsonb_build_object(
        'status','sample_captured_no_lead', 'reason','stamped_lead_id_not_found',
        'message','followup_lead_id=' || v_stamped_lead_id_text || ' did not match any lead in this tenant.'
      );
      update journey_webhook_samples
         set result_status='sample_captured_no_lead', result_reason='stamped_lead_id_not_found',
             result_message=v_result->>'message'
       where id = v_sample_id;
      return v_result;
    end if;
  end if;

  v_mapping := coalesce(v_journey.spec->'webhook_mapping', '{}'::jsonb);

  for v_lead_field, v_map_entry in select * from jsonb_each(v_mapping) loop
    if jsonb_typeof(v_map_entry) = 'string' then v_path := v_map_entry #>> '{}';
    else v_path := v_map_entry->>'from'; end if;
    v_val := _extract_json_path(p_payload, v_path);
    if v_val is null then continue; end if;

    if v_lead_field = 'first_name' then v_lead_first := v_val;
    elsif v_lead_field = 'last_name' then v_lead_last := v_val;
    elsif v_lead_field = 'email' then v_lead_email := lower(v_val);
    elsif v_lead_field in ('phone','phone_e164','phone_raw') then v_lead_phone := v_val;
    elsif v_lead_field like 'custom.%' then
      v_custom_fields := v_custom_fields || jsonb_build_object(substring(v_lead_field from 8), v_val);
    end if;
  end loop;

  if v_lead_email is null then v_lead_email := lower(coalesce(p_payload->>'email','')); end if;
  if v_lead_first is null then v_lead_first := coalesce(p_payload->>'first_name', p_payload->>'firstName',''); end if;
  if v_lead_last  is null then v_lead_last  := coalesce(p_payload->>'last_name',  p_payload->>'lastName',''); end if;
  if v_lead_phone is null then v_lead_phone := coalesce(p_payload->>'phone',      p_payload->>'phoneNumber',''); end if;
  if v_lead_email = '' then v_lead_email := null; end if;
  if v_lead_first = '' then v_lead_first := null; end if;
  if v_lead_last  = '' then v_lead_last  := null; end if;
  if v_lead_phone = '' then v_lead_phone := null; end if;

  if v_lead_email is null and v_lead_phone is null then
    v_result := jsonb_build_object('status','sample_captured_no_lead','reason','no_identifier',
      'message','Sample captured but no identifier was resolved. Stamp followup_lead_id on outbound, or configure webhook_mapping for new-lead intake.');
    update journey_webhook_samples
       set result_status='sample_captured_no_lead', result_reason='no_identifier',
           result_message=v_result->>'message'
     where id = v_sample_id;
    return v_result;
  end if;

  if v_lead_email is not null then
    select * into v_existing_lead from leads
     where tenant_id = v_journey.tenant_id and lower(email) = v_lead_email
     order by created_at desc limit 1;
  end if;
  if v_existing_lead.id is null and v_lead_phone is not null then
    select * into v_existing_lead from leads
     where tenant_id = v_journey.tenant_id and phone_e164 = v_lead_phone
     order by created_at desc limit 1;
  end if;

  if v_existing_lead.id is null then
    insert into leads (
      tenant_id, source, first_name, last_name, email, phone_raw, phone_e164,
      journey_template, journey_status, custom_fields, raw_payload
    ) values (
      v_journey.tenant_id, 'webhook', v_lead_first, v_lead_last, v_lead_email,
      v_lead_phone, v_lead_phone, v_journey.journey_key, 'active', v_custom_fields, p_payload
    ) returning id into v_lead_id;
  else
    update leads set
      first_name = coalesce(v_lead_first, first_name),
      last_name  = coalesce(v_lead_last,  last_name),
      -- NEW: refresh email when the incoming submission carries a non-empty one.
      -- Match by phone now corrects stale emails instead of silently keeping them.
      email      = coalesce(nullif(v_lead_email, ''), email),
      phone_raw  = coalesce(v_lead_phone, phone_raw),
      phone_e164 = coalesce(v_lead_phone, phone_e164),
      journey_template = v_journey.journey_key,
      journey_status   = case when journey_status = 'completed' then 'active' else journey_status end,
      custom_fields = coalesce(custom_fields,'{}'::jsonb) || v_custom_fields,
      raw_payload = p_payload,
      updated_at = now()
     where id = v_existing_lead.id
     returning id into v_lead_id;
  end if;

  select s into v_step0 from jsonb_array_elements(v_journey.spec->'steps') s where (s->>'index')::int = 0;

  if v_step0 is not null then
    v_run_at := now();
    insert into actions (
      tenant_id, lead_id, action_type, step_index, template_key,
      run_at, status, idempotency_key, payload
    ) values (
      v_journey.tenant_id, v_lead_id, v_step0->>'type', 0, v_step0->>'template_key',
      v_run_at, 'pending',
      v_lead_id::text || ':' || v_journey.journey_key || ':0:webhook:' || extract(epoch from now())::text,
      jsonb_build_object('enrolled_via','webhook','step_spec', v_step0)
    )
    on conflict (tenant_id, idempotency_key) do nothing
    returning id into v_action_id;
  end if;

  v_result := jsonb_build_object('status','success','lead_id', v_lead_id,
                                 'action_id', v_action_id, 'journey_key', v_journey.journey_key);
  update journey_webhook_samples
     set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
         result_message='Lead created/updated, step 0 action queued.'
   where id = v_sample_id;
  return v_result;
end;
$function$;


-- ########################################################
-- journey_funnel
-- ########################################################
CREATE OR REPLACE FUNCTION public.journey_funnel(p_journey_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_j journeys;
  v_steps jsonb;
  v_step_summary jsonb;
  v_total int;
begin
  select * into v_j from journeys where id = p_journey_id;
  if not found then return jsonb_build_object('error','journey_not_found'); end if;
  v_steps := coalesce(v_j.spec->'steps','[]'::jsonb);

  select count(*) into v_total
    from leads
   where tenant_id = v_j.tenant_id and journey_template = v_j.journey_key;

  with steps_arr as (
    select (s->>'index')::int as idx,
           s->>'type' as step_type,
           coalesce(s->>'action_name', s->>'template_key', s->>'type') as label
      from jsonb_array_elements(v_steps) s
  ),
  per_lead_step as (
    select a.lead_id,
           a.step_index,
           min(a.created_at) as reached_at
      from actions a
      join leads l on l.id = a.lead_id
     where l.tenant_id = v_j.tenant_id
       and l.journey_template = v_j.journey_key
     group by a.lead_id, a.step_index
  ),
  per_step_counts as (
    select step_index, count(*)::int as reached_count
      from per_lead_step
     group by step_index
  ),
  outcomes as (
    select a.step_index,
           a.status,
           count(*)::int as n
      from actions a
      join leads l on l.id = a.lead_id
     where l.tenant_id = v_j.tenant_id
       and l.journey_template = v_j.journey_key
     group by a.step_index, a.status
  ),
  outcome_agg as (
    select step_index,
           jsonb_object_agg(status, n) as by_status,
           coalesce(sum(n) filter (where status='completed'), 0)::int as completed_count,
           coalesce(sum(n) filter (where status in ('failed','failed_permanent')), 0)::int as failed_count,
           coalesce(sum(n) filter (where status='cancelled'), 0)::int as cancelled_count,
           coalesce(sum(n) filter (where status='pending'), 0)::int as pending_count
      from outcomes group by step_index
  ),
  time_per_lead as (
    select lead_id, step_index, reached_at,
           lag(reached_at) over (partition by lead_id order by step_index) as prev_at
      from per_lead_step
  ),
  median_time as (
    select step_index,
           percentile_cont(0.5) within group (
             order by extract(epoch from (reached_at - prev_at))
           ) as median_seconds_from_prev
      from time_per_lead
     where prev_at is not null
     group by step_index
  )
  select jsonb_agg(
           jsonb_build_object(
             'step_index',                 s.idx,
             'type',                       s.step_type,
             'label',                      s.label,
             'reached_count',              coalesce(pc.reached_count, 0),
             'completed_count',            coalesce(oa.completed_count, 0),
             'failed_count',               coalesce(oa.failed_count, 0),
             'cancelled_count',            coalesce(oa.cancelled_count, 0),
             'pending_count',              coalesce(oa.pending_count, 0),
             'by_status',                  coalesce(oa.by_status, '{}'::jsonb),
             'median_seconds_from_prev',   mt.median_seconds_from_prev
           ) order by s.idx
         )
    into v_step_summary
    from steps_arr s
    left join per_step_counts pc on pc.step_index = s.idx
    left join outcome_agg     oa on oa.step_index = s.idx
    left join median_time     mt on mt.step_index = s.idx;

  return jsonb_build_object(
    'journey_key', v_j.journey_key,
    'name',        v_j.name,
    'total_leads', coalesce(v_total, 0),
    'steps',       coalesce(v_step_summary, '[]'::jsonb)
  );
end;
$function$;


-- ########################################################
-- dashboard_summary
-- ########################################################
CREATE OR REPLACE FUNCTION public.dashboard_summary(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pipeline       jsonb;
  v_channels       jsonb;
  v_call_outcomes  jsonb;
  v_recent_replies jsonb;
begin
  select jsonb_object_agg(journey_status, n)
    into v_pipeline
    from (
      select journey_status, count(*) n
        from leads
       where tenant_id = p_tenant_id
       group by journey_status
    ) p;

  with last30 as (
    select * from events
     where tenant_id = p_tenant_id
       and created_at > now() - interval '30 days'
  ), by_channel as (
    select channel,
           count(*) filter (where direction = 'outbound') as sent,
           count(*) filter (where direction = 'inbound')  as replied,
           count(*) filter (
             where direction = 'outbound'
               and (
                    (channel = 'email' and (raw_payload->>'bounce')::bool = true)
                 or (channel = 'sms'   and sms_status = 'failed')
                 or (channel = 'call'  and call_outcome in ('failed','no_answer','busy','invalid_number'))
               )
           ) as failed
      from last30
     where channel in ('email','sms','call')
     group by channel
  )
  select jsonb_object_agg(channel, jsonb_build_object('sent', sent, 'replied', replied, 'failed', failed))
    into v_channels
    from by_channel;

  select jsonb_object_agg(coalesce(call_outcome,'unknown'), n)
    into v_call_outcomes
    from (
      select call_outcome, count(*) n
        from events
       where tenant_id = p_tenant_id
         and channel = 'call'
         and created_at > now() - interval '30 days'
       group by call_outcome
    ) c;

  select jsonb_agg(j order by at desc)
    into v_recent_replies
    from (
      select jsonb_build_object(
        'id',        e.id,
        'lead_id',   e.lead_id,
        'lead_name', trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')),
        'channel',   e.channel,
        'body',      left(coalesce(e.body,''), 280),
        'from',      e.from_address,
        'at',        e.created_at
      ) as j, e.created_at as at
        from events e
        join leads  l on l.id = e.lead_id   -- INNER join: must be a lead in our system
       where e.tenant_id = p_tenant_id
         and e.direction = 'inbound'
         and coalesce((e.raw_payload->>'bounce')::bool, false) = false
       order by e.created_at desc
       limit 10
    ) sub;

  return jsonb_build_object(
    'pipeline',       coalesce(v_pipeline,        '{}'::jsonb),
    'channels_30d',   coalesce(v_channels,        '{}'::jsonb),
    'call_outcomes',  coalesce(v_call_outcomes,   '{}'::jsonb),
    'recent_replies', coalesce(v_recent_replies,  '[]'::jsonb)
  );
end;
$function$;


-- ########################################################
-- error_groups
-- ########################################################
CREATE OR REPLACE FUNCTION public.error_groups(p_tenant_id uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(signature text, workflow_name text, count integer, first_seen timestamp with time zone, last_seen timestamp with time zone, severity text, sample_id uuid, sample_message text, sample_raw jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with normalized as (
    select id, workflow_name, severity, error_message, raw_error, created_at,
           left(
             regexp_replace(
               regexp_replace(
                 regexp_replace(coalesce(error_message,'(no message)'),
                   '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 'UUID', 'g'),
                 '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*', 'TS', 'g'),
               '\d{4,}', 'N', 'g'),
             120
           ) as sig
      from error_logs
     where tenant_id = p_tenant_id
       and created_at > now() - interval '90 days'
  ),
  grouped as (
    select sig, workflow_name, count(*) as cnt,
           min(created_at) as first_seen, max(created_at) as last_seen,
           max(severity) as severity,
           (array_agg(id order by created_at desc))[1] as sample_id,
           (array_agg(error_message order by created_at desc))[1] as sample_message,
           (array_agg(raw_error order by created_at desc))[1] as sample_raw
      from normalized
     group by sig, workflow_name
  )
  select sig, workflow_name, cnt, first_seen, last_seen, severity,
         sample_id, sample_message, sample_raw
    from grouped
   order by last_seen desc
   limit p_limit;
$function$;

