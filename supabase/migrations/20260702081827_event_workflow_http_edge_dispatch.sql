-- Route event workflow HTTP requests through an internal Edge Function.
--
-- The previous event HTTP runtime fired user-configured URLs directly from SQL
-- with pg_net. SQL can block obvious localhost/private IP literals, but it
-- cannot safely resolve DNS before egress. This version prepares the rendered
-- request in workflow_actions.result and calls only the internal
-- dispatch-workflow-http-request Edge Function. The Edge Function performs
-- DNS/IP validation, executes the request, records the response, and advances.

create or replace function public.process_workflow_http_request_action(
  p_workflow_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_run public.journey_runs%rowtype;
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
  v_edge_request_id bigint;
  v_edge_url text := 'https://your-project-ref.supabase.co/functions/v1/dispatch-workflow-http-request';
  v_dispatch_key text;
  v_error text;
begin
  if p_workflow_action_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select *
    into v_action
    from public.workflow_actions
   where id = p_workflow_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_action.status = 'completed' then
    return coalesce(v_action.result, '{}'::jsonb)
           || jsonb_build_object('status', 'already_completed');
  end if;

  if v_action.result ? 'edge_dispatch_request_id' then
    return jsonb_build_object(
      'status', 'in_progress',
      'request_id', v_action.result ->> 'edge_dispatch_request_id'
    );
  end if;

  if v_action.action_type <> 'http_request' then
    v_error := 'process_workflow_http_request_action only supports http_request actions.';
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = v_error,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'failure_message', v_error
           )
     where id = v_action.id;
    return jsonb_build_object('status', 'failed', 'reason', v_error);
  end if;

  select *
    into v_run
    from public.journey_runs
   where id = v_action.run_id
     and tenant_id = v_action.tenant_id
   for update;

  if not found then
    v_error := 'Associated journey run was not found.';
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = v_error,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'failure_message', v_error
           )
     where id = v_action.id;
    return jsonb_build_object('status', 'failed', 'reason', v_error);
  end if;

  v_step := coalesce(v_action.payload -> 'step_spec', '{}'::jsonb);
  v_method := upper(coalesce(nullif(v_step ->> 'http_method', ''), 'POST'));
  v_url := public.resolve_workflow_template(v_step ->> 'http_url', v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb));
  v_headers_raw := coalesce(v_step -> 'http_headers', '{}'::jsonb);
  v_body_raw := coalesce(v_step ->> 'http_body', '');
  v_response_var := nullif(btrim(coalesce(v_step ->> 'response_var', '')), '');

  if v_method not in ('GET', 'POST', 'DELETE') then
    v_error := 'Unsupported HTTP method: ' || v_method;
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = v_error,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'failure_message', v_error,
             'method', v_method
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = v_error
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object('status', 'failed', 'reason', 'unsupported_method', 'method', v_method);
  end if;

  -- Fast SQL-side precheck for obvious bad URLs. The Edge Function repeats this
  -- and also performs DNS/IP validation before the real outbound fetch.
  v_url_check := public.workflow_http_url_check(v_url);
  if coalesce((v_url_check ->> 'allowed')::boolean, false) is not true then
    v_error := 'Blocked HTTP request URL: ' || coalesce(v_url_check ->> 'reason', 'not_allowed');
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = v_error,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'failure_message', v_error,
             'url_check', v_url_check
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = v_error
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object('status', 'failed', 'reason', v_url_check ->> 'reason', 'url_check', v_url_check);
  end if;

  if jsonb_typeof(v_headers_raw) = 'object' then
    for v_hkey, v_hval in select key, value from jsonb_each_text(v_headers_raw) loop
      if lower(v_hkey) in ('host', 'content-length', 'connection', 'transfer-encoding') then
        continue;
      end if;
      v_headers_out := v_headers_out || jsonb_build_object(
        v_hkey,
        public.resolve_workflow_template(coalesce(v_hval, ''), v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb))
      );
    end loop;
  end if;

  if v_method = 'POST'
     and (v_headers_out ? 'Content-Type') = false
     and v_body_raw <> '' then
    v_headers_out := v_headers_out || jsonb_build_object('Content-Type', 'application/json');
  end if;

  v_body_text := public.resolve_workflow_template(v_body_raw, v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb));
  v_body_jsonb := null;
  if v_body_text is not null and v_body_text <> '' then
    begin
      v_body_jsonb := v_body_text::jsonb;
    exception
      when others then
        v_body_jsonb := to_jsonb(v_body_text);
    end;
  end if;

  v_dispatch_key := public.get_internal_dispatch_key();

  update public.workflow_actions
     set status = 'in_progress',
         locked_by = null,
         locked_until = now() + interval '5 minutes',
         last_error = null,
         lead_id = coalesce(lead_id, v_run.lead_id),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'status', 'prepared',
           'prepared_at', now(),
           'http_method', v_method,
           'http_url', v_url,
           'response_var', v_response_var,
           'prepared_request', jsonb_build_object(
             'method', v_method,
             'url', v_url,
             'headers', v_headers_out,
             'body', v_body_jsonb
           )
         )
   where id = v_action.id;

  begin
    select net.http_post(
      url := v_edge_url,
      body := jsonb_build_object('workflow_action_id', v_action.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_dispatch_key
      ),
      timeout_milliseconds := 10000
    ) into v_edge_request_id;
  exception
    when others then
      v_error := 'Failed to dispatch workflow HTTP Edge Function: ' || left(sqlerrm, 1000);
      update public.workflow_actions
         set status = 'failed_permanent',
             failed_at = coalesce(failed_at, now()),
             locked_by = null,
             locked_until = null,
             last_error = v_error,
             result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
               'status', 'failed',
               'failure_message', v_error
             )
       where id = v_action.id;

      update public.journey_runs
         set status = 'failed',
             failed_at = coalesce(failed_at, now()),
             last_error = v_error
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');

      return jsonb_build_object('status', 'failed', 'reason', 'edge_dispatch_failed');
  end;

  if v_edge_request_id is null then
    v_error := 'pg_net returned null request_id for workflow HTTP Edge Function.';
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = v_error,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'failure_message', v_error
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = v_error
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object('status', 'failed', 'reason', 'edge_dispatch_null_request_id');
  end if;

  update public.workflow_actions
     set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'status', 'fired',
           'edge_dispatch_request_id', v_edge_request_id,
           'edge_dispatched_at', now()
         )
   where id = v_action.id;

  return jsonb_build_object(
    'status', 'fired',
    'request_id', v_edge_request_id,
    'method', v_method,
    'edge_function', 'dispatch-workflow-http-request',
    'url_host', v_url_check ->> 'host'
  );
end;
$$;
