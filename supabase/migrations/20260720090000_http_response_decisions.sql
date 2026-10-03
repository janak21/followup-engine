-- HTTP response → decisions.
--
-- The HTTP node stores its response body on the lead as
-- custom_fields[<response_var>]. Two gaps kept that data from driving
-- decisions:
--
--   1. Lead-journey If/Else (evaluate_condition) read the text after
--      'custom.' as ONE literal key, so nested lookups like
--      custom.api_response.status silently returned null. (The webhook /
--      event-workflow evaluator already supported nested paths.)
--   2. The HTTP status code was only recorded on the action row, not
--      anywhere a condition could reach.
--
-- This migration makes evaluate_condition walk nested custom paths
-- (top-level keys behave exactly as before — a one-element path), and makes
-- the collector store the status code as a sibling custom field
-- <response_var>_status.

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
      -- Nested path support: custom.api_response.data.plan walks the stored
      -- JSON. A single key (no dots) is a one-element path — same as before.
      v_actual := v_lead.custom_fields #> string_to_array(substring(v_field from 8), '.');
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

CREATE OR REPLACE FUNCTION public.process_action_http_collector(p_batch integer DEFAULT 50)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action_id uuid;
  v_request_id bigint;
  v_response_var text;
  v_status_code int;
  v_resp_body text;
  v_resp_headers jsonb;
  v_lead_id uuid;
  v_parsed jsonb;
  v_done int := 0;
begin
  for v_action_id, v_request_id, v_response_var, v_lead_id in
    select a.id, (a.result->>'pg_net_request_id')::bigint, a.result->>'response_var', a.lead_id
      from actions a
     where a.action_type='http_request'
       and a.status='in_progress'
       and a.result ? 'pg_net_request_id'
       and a.result ? 'completed_at' = false   -- guard against double-completion
     order by a.run_at limit p_batch
  loop
    -- Does the pg_net worker have the response yet?
    select status_code, content, headers
      into v_status_code, v_resp_body, v_resp_headers
      from net._http_response
     where id = v_request_id;
    if not found then
      continue;  -- not ready; try again next tick
    end if;

    update actions
       set status = 'completed',
           completed_at = now(),
           result = result || jsonb_build_object(
                            'outcome','default',
                            'status_code', v_status_code,
                            'response_body', v_resp_body,
                            'response_headers', v_resp_headers,
                            'collected_at', now()
                          )
     where id = v_action_id;

    if v_response_var is not null and btrim(v_response_var) <> '' then
      v_parsed := null;
      begin
        v_parsed := v_resp_body::jsonb;
      exception when others then
        v_parsed := jsonb_build_object('_raw', coalesce(v_resp_body,''));
      end;
      if v_parsed is null then
        v_parsed := jsonb_build_object('_raw', coalesce(v_resp_body,''));
      end if;
      update leads
         set custom_fields = jsonb_set(
               jsonb_set(coalesce(custom_fields,'{}'::jsonb), array[v_response_var], v_parsed),
               array[v_response_var || '_status'], to_jsonb(coalesce(v_status_code, 0))
             ),
             updated_at = now()
       where id = v_lead_id;
    end if;

    insert into events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
    select tenant_id, v_lead_id, v_action_id, 'system','internal','engine',
           jsonb_build_object('step_type','http_request','status_code',v_status_code,
                              'response_var',v_response_var)
      from actions where id = v_action_id;

    perform advance_journey(v_action_id, 'default');
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$function$;
