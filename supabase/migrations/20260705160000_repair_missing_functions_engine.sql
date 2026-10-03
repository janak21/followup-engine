-- Launch repair 5/n: the 20260626 function-body backfill was recorded as a
-- no-op on prod (migration transport limit), leaving 25 functions missing.
-- This file restores the ENGINE-CRITICAL subset; bodies verbatim from dev
-- (pg_get_functiondef, 2026-07-05). Parts 6-8 restore trigger functions,
-- tenant RPCs, and dashboard RPCs.
--
-- Applied to follow-up-prod via Supabase MCP on 2026-07-05.

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

CREATE OR REPLACE FUNCTION public.execute_conditional_split(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return process_action_conditional_split(p_action_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.process_action_lead_tag(p_action_id uuid)
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
  v_tag text;
  v_current_tags jsonb;
  v_new_tags jsonb;
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

  v_tag := v_step->>'tag_name';
  if v_tag is null or trim(v_tag) = '' then
    update actions set status = 'failed', error_message = 'tag_name not configured on step' where id = p_action_id;
    return jsonb_build_object('status', 'failed', 'reason', 'tag_name_missing');
  end if;

  v_current_tags := coalesce(v_lead.custom_fields->'tags', '[]'::jsonb);

  if v_action.action_type = 'add_tag' then
    if v_current_tags ? v_tag then
      v_new_tags := v_current_tags;
    else
      v_new_tags := v_current_tags || jsonb_build_array(v_tag);
    end if;
  elsif v_action.action_type = 'remove_tag' then
    v_new_tags := coalesce((
      select jsonb_agg(t)
      from jsonb_array_elements_text(v_current_tags) t(value)
      where value <> v_tag
    ), '[]'::jsonb);
  else
    update actions set status = 'failed', error_message = 'unexpected action_type: ' || v_action.action_type where id = p_action_id;
    return jsonb_build_object('status', 'failed', 'reason', 'wrong_action_type');
  end if;

  update leads
     set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), '{tags}', v_new_tags),
         updated_at = now()
   where id = v_lead.id;

  update actions
     set status = 'completed',
         result = jsonb_build_object('outcome', 'completed', 'tag', v_tag, 'tags_after', v_new_tags),
         completed_at = now()
   where id = p_action_id;

  insert into events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object('step_type', v_action.action_type, 'tag', v_tag, 'tags_after', v_new_tags));

  v_next_action_id := advance_journey(p_action_id, 'default');

  return jsonb_build_object(
    'status', 'success',
    'tag', v_tag,
    'tags_after', v_new_tags,
    'next_action_id', v_next_action_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.process_sms_status_error(p_provider_sid text, p_to_phone text, p_error_code integer, p_error_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event events;
  v_tenant_id uuid;
  v_perm_codes int[] := array[21610, 21614, 30005, 30006, 30007];
  v_reason text;
begin
  -- Find the original outbound event by provider_id to recover tenant + lead.
  select * into v_event from events
   where provider_id = p_provider_sid and provider = 'twilio'
   order by created_at desc limit 1;

  v_tenant_id := v_event.tenant_id;
  if v_tenant_id is null then
    return jsonb_build_object('status','no_matching_event','provider_sid', p_provider_sid);
  end if;

  if p_error_code = any(v_perm_codes) then
    v_reason := case p_error_code
      when 21610 then 'opt_out'
      when 21614 then 'invalid_number'
      when 30005 then 'unknown_destination'
      when 30006 then 'landline_unreachable'
      when 30007 then 'carrier_filter'
      else 'permanent_failure' end;
    perform add_suppression(v_tenant_id, 'sms', p_to_phone, v_reason,
                            v_event.lead_id, 'twilio_status_error',
                            'code ' || p_error_code || ': ' || coalesce(p_error_message,''));
    return jsonb_build_object('status','suppressed','reason', v_reason);
  end if;

  return jsonb_build_object('status','non_permanent','code', p_error_code);
end;
$function$;

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('compare_values','evaluate_condition','execute_conditional_split',
                         'get_sms_send_payload','process_action_find_lead',
                         'process_action_lead_tag','process_sms_status_error')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
