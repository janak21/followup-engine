-- HTTP request step: configurable timeout.
--
-- The builder's Send webhook / HTTP request node gains a timeout setting
-- (step.http_timeout_ms). Previously pg_net calls were hardcoded to 10s.
-- The value is clamped to 1s..30s; missing/invalid values keep the old 10s
-- default, so existing journeys behave identically.
--
-- Only change vs the prior function body: v_timeout_ms declaration, its
-- clamped read from the step spec, and timeout_milliseconds := v_timeout_ms
-- in the three net.* calls.

CREATE OR REPLACE FUNCTION public.process_action_http_request(p_action_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action public.actions%rowtype;
  v_lead public.leads%rowtype;
  v_run public.journey_runs%rowtype;
  v_journey public.journeys%rowtype;
  v_step jsonb;
  v_method text;
  v_url text;
  v_url_check jsonb;
  v_headers_raw jsonb;
  v_headers_out jsonb := '{}'::jsonb;
  v_hkey text;
  v_hval text;
  v_body_raw text;
  v_body_text text;
  v_body_jsonb jsonb;
  v_response_var text;
  v_request_id bigint;
  v_event_mode boolean := false;
  v_timeout_ms integer := 10000;
begin
  select * into v_action from public.actions where id = p_action_id for update;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status <> 'pending' then
    return jsonb_build_object('status','already_handled','status_was',v_action.status);
  end if;
  if v_action.result ? 'pg_net_request_id' then
    return jsonb_build_object('status','already_fired','request_id',v_action.result->>'pg_net_request_id');
  end if;

  if v_action.run_id is not null then
    select * into v_run from public.journey_runs where id = v_action.run_id;
    v_event_mode := found and v_run.mode = 'event_workflow';
  end if;

  if v_event_mode then
    if coalesce(v_action.lead_id, v_run.lead_id) is not null then
      select * into v_lead from public.leads where id = coalesce(v_action.lead_id, v_run.lead_id);
    end if;
    v_step := coalesce(v_action.payload -> 'step_spec', '{}'::jsonb);
    v_method := upper(coalesce(nullif(v_step ->> 'http_method', ''), 'POST'));
    v_url := public.resolve_workflow_template(v_step ->> 'http_url', v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb));
    v_headers_raw := coalesce(v_step -> 'http_headers', '{}'::jsonb);
    v_body_raw := coalesce(v_step ->> 'http_body', '');
    v_response_var := nullif(btrim(coalesce(v_step ->> 'response_var', '')), '');
  else
    select * into v_lead from public.leads where id = v_action.lead_id;
    if not found then
      perform public.mark_action_failed_permanent(p_action_id, 'lead not found');
      return jsonb_build_object('status','failed','reason','lead_not_found');
    end if;

    select * into v_journey
      from public.journeys
     where tenant_id = v_action.tenant_id
       and journey_key = v_lead.journey_template
       and active
     order by version desc limit 1;
    if not found then
      perform public.mark_action_failed_permanent(p_action_id, 'journey not found');
      return jsonb_build_object('status','failed','reason','journey_not_found');
    end if;

    select s into v_step
      from jsonb_array_elements(v_journey.spec->'steps') s
     where (s->>'index')::int = v_action.step_index;

    v_method := upper(coalesce(v_step->>'http_method', 'POST'));
    v_url := public.resolve_merge_tags(coalesce(v_step->>'http_url', ''), v_lead);
    v_headers_raw := coalesce(v_step->'http_headers', '{}'::jsonb);
    v_body_raw := coalesce(v_step->>'http_body', '');
    v_response_var := v_step->>'response_var';
  end if;

  -- Configurable timeout: 1s..30s, defaulting to the historical 10s.
  begin
    v_timeout_ms := greatest(1000, least(30000, coalesce(nullif(v_step->>'http_timeout_ms','')::integer, 10000)));
  exception when others then
    v_timeout_ms := 10000;
  end;

  if v_url is null or v_url = '' then
    perform public.mark_action_failed_permanent(p_action_id, 'http_request step has no http_url');
    return jsonb_build_object('status','failed','reason','missing_url');
  end if;

  v_url_check := public.workflow_http_url_check(v_url);
  if coalesce((v_url_check ->> 'allowed')::boolean, false) is not true then
    perform public.mark_action_failed_permanent(p_action_id, 'blocked_url:' || coalesce(v_url_check ->> 'reason', 'not_allowed'));
    return jsonb_build_object('status','failed','reason','blocked_url:' || coalesce(v_url_check ->> 'reason', 'not_allowed'), 'url_check', v_url_check);
  end if;

  for v_hkey, v_hval in select key, value from jsonb_each_text(v_headers_raw) loop
    if lower(v_hkey) in ('host', 'content-length', 'connection', 'transfer-encoding') then
      continue;
    end if;
    if v_event_mode then
      v_headers_out := v_headers_out || jsonb_build_object(v_hkey, public.resolve_workflow_template(coalesce(v_hval,''), v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb)));
    else
      v_headers_out := v_headers_out || jsonb_build_object(v_hkey, public.resolve_merge_tags(coalesce(v_hval,''), v_lead));
    end if;
  end loop;

  if v_method in ('POST','PUT','PATCH')
     and (v_headers_out ? 'Content-Type') = false
     and v_body_raw <> '' then
    v_headers_out := v_headers_out || jsonb_build_object('Content-Type','application/json');
  end if;

  if v_event_mode then
    v_body_text := public.resolve_workflow_template(v_body_raw, v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb));
  else
    v_body_text := public.resolve_merge_tags(v_body_raw, v_lead);
  end if;

  v_body_jsonb := null;
  if v_body_text is not null and v_body_text <> '' then
    begin
      v_body_jsonb := v_body_text::jsonb;
    exception when others then
      v_body_jsonb := to_jsonb(v_body_text);
    end;
  end if;

  if v_method = 'POST' then
    select net.http_post(url:=v_url, body:=coalesce(v_body_jsonb,'{}'::jsonb), headers:=v_headers_out, timeout_milliseconds:=v_timeout_ms) into v_request_id;
  elsif v_method = 'GET' then
    select net.http_get(url:=v_url, headers:=v_headers_out, timeout_milliseconds:=v_timeout_ms) into v_request_id;
  elsif v_method = 'DELETE' then
    select net.http_delete(url:=v_url, headers:=v_headers_out, timeout_milliseconds:=v_timeout_ms) into v_request_id;
  else
    perform public.mark_action_failed_permanent(p_action_id, 'unsupported_http_method: ' || v_method);
    perform public.advance_journey(p_action_id, 'default');
    return jsonb_build_object('status','failed','reason','unsupported_method','method',v_method);
  end if;

  if v_request_id is null then
    perform public.mark_action_failed_permanent(p_action_id, 'pg_net returned null request_id');
    perform public.advance_journey(p_action_id, 'default');
    return jsonb_build_object('status','failed','reason','pg_net_null_request_id');
  end if;

  update public.actions
     set status = 'in_progress',
         locked_until = now() + interval '5 minutes',
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                    'pg_net_request_id', v_request_id,
                    'fired_at', now(),
                    'http_method', v_method,
                    'http_url', v_url,
                    'http_timeout_ms', v_timeout_ms,
                    'response_var', v_response_var
                  )
   where id = p_action_id;

  return jsonb_build_object('status','fired','request_id',v_request_id);
exception
  when others then
    perform public.mark_action_failed_permanent(p_action_id, left(sqlerrm, 2000));
    return jsonb_build_object('status','failed','reason',left(sqlerrm, 2000));
end;
$function$;
