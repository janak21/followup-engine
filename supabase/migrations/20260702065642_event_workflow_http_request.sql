-- Event workflow HTTP request runtime.
--
-- This enables webhook-triggered automations to call an outbound HTTP endpoint
-- before or after lead context exists. It is intentionally separate from the
-- legacy lead-journey process_action_http_request handler.
--
-- Safety:
-- - GET/POST/DELETE only, matching existing pg_net helper support.
-- - Blocks localhost, private IPv4 ranges, IPv6 literals, link-local hosts,
--   metadata hosts, credentialed URLs, and oversized URLs.
-- - Fires pg_net once and stores request id. A collector completes and advances
--   after net._http_response has the response, avoiding duplicate sends.

create or replace function public.resolve_workflow_template(
  p_template text,
  p_run_id uuid,
  p_lead_id uuid default null,
  p_action_result jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rendered text := p_template;
  v_match text[];
  v_value text;
begin
  if p_template is null then
    return null;
  end if;

  if position('{{' in p_template) = 0 then
    return public.resolve_workflow_expr(p_template, p_run_id, p_lead_id, p_action_result);
  end if;

  for v_match in
    select regexp_matches(p_template, '(\{\{\s*([^{}]+?)\s*\}\})', 'g')
  loop
    v_value := public.resolve_workflow_expr(v_match[2], p_run_id, p_lead_id, p_action_result);
    v_rendered := replace(v_rendered, v_match[1], coalesce(v_value, ''));
  end loop;

  return v_rendered;
end;
$$;

create or replace function public.workflow_http_url_check(
  p_url text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_host text;
begin
  if v_url = '' then
    return jsonb_build_object('allowed', false, 'reason', 'missing_url');
  end if;

  if length(v_url) > 2048 then
    return jsonb_build_object('allowed', false, 'reason', 'url_too_long');
  end if;

  if v_url !~* '^https?://' then
    return jsonb_build_object('allowed', false, 'reason', 'unsupported_url_scheme');
  end if;

  if v_url ~* '^https?://[^/?#]*@' then
    return jsonb_build_object('allowed', false, 'reason', 'url_credentials_not_allowed');
  end if;

  v_host := lower(regexp_replace(v_url, '^https?://([^/:?#]+).*$' , '\1', 'i'));
  v_host := trim(both '[]' from v_host);

  if v_host = '' or v_host = v_url then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_url_host');
  end if;

  if v_host in ('localhost', 'localhost.localdomain', 'metadata.google.internal') then
    return jsonb_build_object('allowed', false, 'reason', 'blocked_internal_host', 'host', v_host);
  end if;

  if v_host like '%.local' or v_host like '%.internal' then
    return jsonb_build_object('allowed', false, 'reason', 'blocked_internal_host', 'host', v_host);
  end if;

  if v_host ~ ':' then
    return jsonb_build_object('allowed', false, 'reason', 'ipv6_literal_not_allowed', 'host', v_host);
  end if;

  if v_host ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' then
    if v_host ~ '^(0|10|127)\.'
       or v_host ~ '^169\.254\.'
       or v_host ~ '^192\.168\.'
       or v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.'
       or v_host ~ '^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.'
       or v_host ~ '^198\.18\.'
       or v_host ~ '^198\.19\.' then
      return jsonb_build_object('allowed', false, 'reason', 'blocked_private_ip', 'host', v_host);
    end if;
  end if;

  return jsonb_build_object('allowed', true, 'host', v_host);
end;
$$;

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
  v_request_id bigint;
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

  if v_action.result ? 'pg_net_request_id' then
    return jsonb_build_object(
      'status', 'in_progress',
      'request_id', v_action.result ->> 'pg_net_request_id'
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

  begin
    if v_method = 'POST' then
      select net.http_post(
        url := v_url,
        body := coalesce(v_body_jsonb, '{}'::jsonb),
        headers := v_headers_out,
        timeout_milliseconds := 10000
      ) into v_request_id;
    elsif v_method = 'GET' then
      select net.http_get(
        url := v_url,
        headers := v_headers_out,
        timeout_milliseconds := 10000
      ) into v_request_id;
    else
      select net.http_delete(
        url := v_url,
        headers := v_headers_out,
        timeout_milliseconds := 10000
      ) into v_request_id;
    end if;
  exception
    when others then
      v_error := 'Failed to fire HTTP request: ' || left(sqlerrm, 1000);
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

      return jsonb_build_object('status', 'failed', 'reason', 'http_fire_failed');
  end;

  if v_request_id is null then
    v_error := 'pg_net returned null request_id.';
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

    return jsonb_build_object('status', 'failed', 'reason', 'pg_net_null_request_id');
  end if;

  update public.workflow_actions
     set status = 'in_progress',
         locked_by = null,
         locked_until = now() + interval '5 minutes',
         last_error = null,
         lead_id = coalesce(lead_id, v_run.lead_id),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'status', 'fired',
           'pg_net_request_id', v_request_id,
           'fired_at', now(),
           'http_method', v_method,
           'http_url', v_url,
           'response_var', v_response_var
         )
   where id = v_action.id;

  return jsonb_build_object(
    'status', 'fired',
    'request_id', v_request_id,
    'method', v_method,
    'url_host', v_url_check ->> 'host'
  );
end;
$$;

create or replace function public.process_workflow_http_response_collector(
  p_run_id uuid default null,
  p_batch_size integer default 50
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_request_id bigint;
  v_status_code integer;
  v_resp_body text;
  v_resp_headers jsonb;
  v_response_var text;
  v_context_key text;
  v_parsed jsonb;
  v_result jsonb;
  v_done integer := 0;
begin
  for v_action in
    select *
      from public.workflow_actions
     where action_type = 'http_request'
       and status = 'in_progress'
       and result ? 'pg_net_request_id'
       and not (result ? 'collected_at')
       and (p_run_id is null or run_id = p_run_id)
     order by run_at, created_at
     limit greatest(coalesce(p_batch_size, 50), 0)
     for update skip locked
  loop
    v_request_id := (v_action.result ->> 'pg_net_request_id')::bigint;

    select status_code, content, headers
      into v_status_code, v_resp_body, v_resp_headers
      from net._http_response
     where id = v_request_id;

    if not found then
      continue;
    end if;

    v_response_var := nullif(btrim(coalesce(v_action.result ->> 'response_var', '')), '');
    begin
      v_parsed := coalesce(v_resp_body, '')::jsonb;
    exception
      when others then
        v_parsed := jsonb_build_object('_raw', coalesce(left(v_resp_body, 10000), ''));
    end;

    v_result := coalesce(v_action.result, '{}'::jsonb) || jsonb_build_object(
      'status', 'completed',
      'outcome', 'default',
      'status_code', v_status_code,
      'response_body', left(coalesce(v_resp_body, ''), 10000),
      'response_headers', coalesce(v_resp_headers, '{}'::jsonb),
      'collected_at', now()
    );

    update public.workflow_actions
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = null,
           result = v_result
     where id = v_action.id;

    v_context_key := coalesce(v_response_var, 'http_request_' || coalesce(v_action.step_index::text, 'unknown'));

    update public.journey_runs
       set context = jsonb_set(
             jsonb_set(
               coalesce(context, '{}'::jsonb),
               array['steps', v_context_key],
               v_result,
               true
             ),
             array['http_responses', v_context_key],
             v_parsed,
             true
           ),
           last_error = null
     where id = v_action.run_id;

    perform public.advance_workflow_run(v_action.id, 'default');
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

create or replace function public.dispatch_pending_workflow_actions(
  p_worker_id text default 'workflow-worker',
  p_batch_size integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_result jsonb;
  v_processed integer := 0;
  v_completed integer := 0;
  v_failed integer := 0;
  v_unsupported integer := 0;
  v_stale_recovered integer := 0;
  v_http_collected integer := 0;
  v_batch_size integer := greatest(coalesce(p_batch_size, 50), 0);
  v_worker_id text := coalesce(nullif(btrim(p_worker_id), ''), 'workflow-worker');
begin
  v_http_collected := public.process_workflow_http_response_collector(null, v_batch_size);

  update public.workflow_actions
     set status = 'pending',
         locked_by = null,
         locked_until = null,
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'stale_recovered_at', now(),
           'stale_recovered_by', v_worker_id
         )
   where id in (
     select id
       from public.workflow_actions
      where status = 'in_progress'
        and locked_until is not null
        and locked_until < now()
        and action_type <> 'http_request'
      order by locked_until, created_at
      limit 100
      for update skip locked
   );
  get diagnostics v_stale_recovered = row_count;

  if v_batch_size = 0 then
    return jsonb_build_object(
      'processed', 0,
      'completed', 0,
      'failed', 0,
      'unsupported', 0,
      'stale_recovered', v_stale_recovered,
      'http_collected', v_http_collected
    );
  end if;

  for v_action in
    update public.workflow_actions
       set status = 'in_progress',
           locked_by = v_worker_id,
           locked_until = now() + interval '5 minutes'
     where id in (
       select id
         from public.workflow_actions
        where status = 'pending'
          and run_at <= now()
          and (next_retry_at is null or next_retry_at <= now())
          and (locked_until is null or locked_until < now())
        order by run_at, created_at
        limit v_batch_size
        for update skip locked
     )
     returning *
  loop
    v_processed := v_processed + 1;

    begin
      if v_action.action_type = 'create_lead_from_payload' then
        v_result := public.process_workflow_create_lead_action(v_action.id);
      elsif v_action.action_type = 'find_lead_from_payload' then
        v_result := public.process_workflow_find_lead_action(v_action.id);
      elsif v_action.action_type = 'conditional_split' then
        v_result := public.process_workflow_conditional_split_action(v_action.id);
      elsif v_action.action_type = 'wait' then
        v_result := public.process_workflow_wait_action(v_action.id);
      elsif v_action.action_type = 'http_request' then
        v_result := public.process_workflow_http_request_action(v_action.id);
      else
        update public.workflow_actions
           set status = 'failed_permanent',
               failed_at = coalesce(failed_at, now()),
               locked_by = null,
               locked_until = null,
               last_error = 'Unsupported workflow action type',
               result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                 'failed_permanent_at', now(),
                 'failure_message', 'Unsupported workflow action type',
                 'unsupported_action_type', v_action.action_type,
                 'failed_by', 'dispatch_pending_workflow_actions'
               )
         where id = v_action.id;

        v_failed := v_failed + 1;
        v_unsupported := v_unsupported + 1;
        continue;
      end if;

      if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
        v_completed := v_completed + 1;
      elsif coalesce(v_result ->> 'status', '') in ('fired', 'in_progress') then
        -- External HTTP has been fired once and will be completed by collector.
        null;
      else
        v_failed := v_failed + 1;
      end if;
    exception
      when others then
        update public.workflow_actions
           set status = 'failed_permanent',
               failed_at = coalesce(failed_at, now()),
               locked_by = null,
               locked_until = null,
               last_error = left(sqlerrm, 2000),
               result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                 'failed_permanent_at', now(),
                 'failure_message', left(sqlerrm, 2000),
                 'failed_by', 'dispatch_pending_workflow_actions'
               )
         where id = v_action.id;
        v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'completed', v_completed,
    'failed', v_failed,
    'unsupported', v_unsupported,
    'stale_recovered', v_stale_recovered,
    'http_collected', v_http_collected
  );
end;
$$;

create or replace function public.dispatch_workflow_run_actions(
  p_run_id uuid,
  p_worker_id text default 'workflow-webhook',
  p_batch_size integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_result jsonb;
  v_processed integer := 0;
  v_completed integer := 0;
  v_failed integer := 0;
  v_unsupported integer := 0;
  v_http_collected integer := 0;
  v_batch_size integer := greatest(coalesce(p_batch_size, 10), 0);
  v_worker_id text := coalesce(nullif(btrim(p_worker_id), ''), 'workflow-webhook');
begin
  if p_run_id is null then
    return jsonb_build_object(
      'processed', 0,
      'completed', 0,
      'failed', 1,
      'unsupported', 0,
      'reason', 'run_id_required'
    );
  end if;

  v_http_collected := public.process_workflow_http_response_collector(p_run_id, v_batch_size);

  while v_processed < v_batch_size loop
    select *
      into v_action
      from public.workflow_actions
     where run_id = p_run_id
       and status = 'pending'
       and run_at <= now()
       and (next_retry_at is null or next_retry_at <= now())
       and (locked_until is null or locked_until < now())
     order by run_at, created_at
     limit 1
     for update skip locked;

    exit when not found;

    update public.workflow_actions
       set status = 'in_progress',
           locked_by = v_worker_id,
           locked_until = now() + interval '5 minutes'
     where id = v_action.id
     returning * into v_action;

    v_processed := v_processed + 1;

    begin
      if v_action.action_type = 'create_lead_from_payload' then
        v_result := public.process_workflow_create_lead_action(v_action.id);
      elsif v_action.action_type = 'find_lead_from_payload' then
        v_result := public.process_workflow_find_lead_action(v_action.id);
      elsif v_action.action_type = 'conditional_split' then
        v_result := public.process_workflow_conditional_split_action(v_action.id);
      elsif v_action.action_type = 'wait' then
        v_result := public.process_workflow_wait_action(v_action.id);
      elsif v_action.action_type = 'http_request' then
        v_result := public.process_workflow_http_request_action(v_action.id);
      else
        update public.workflow_actions
           set status = 'failed_permanent',
               failed_at = coalesce(failed_at, now()),
               locked_by = null,
               locked_until = null,
               last_error = 'Unsupported workflow action type for immediate webhook dispatch',
               result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                 'failed_permanent_at', now(),
                 'failure_message', 'Unsupported workflow action type for immediate webhook dispatch',
                 'unsupported_action_type', v_action.action_type,
                 'failed_by', 'dispatch_workflow_run_actions'
               )
         where id = v_action.id;

        v_failed := v_failed + 1;
        v_unsupported := v_unsupported + 1;
        continue;
      end if;

      if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
        v_completed := v_completed + 1;
      elsif coalesce(v_result ->> 'status', '') in ('fired', 'in_progress') then
        null;
      else
        v_failed := v_failed + 1;
      end if;
    exception
      when others then
        update public.workflow_actions
           set status = 'failed_permanent',
               failed_at = coalesce(failed_at, now()),
               locked_by = null,
               locked_until = null,
               last_error = left(sqlerrm, 2000),
               result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                 'failed_permanent_at', now(),
                 'failure_message', left(sqlerrm, 2000),
                 'failed_by', 'dispatch_workflow_run_actions'
               )
         where id = v_action.id;
        v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'completed', v_completed,
    'failed', v_failed,
    'unsupported', v_unsupported,
    'http_collected', v_http_collected
  );
end;
$$;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.advance_workflow_run(uuid,text)'::regprocedure)
    into v_sql;

  if position($needle$       'http_request'$needle$ in v_sql) = 0 then
    if position($needle$       'wait'$needle$ in v_sql) > 0 then
      v_sql := replace(
        v_sql,
        $needle$       'wait'$needle$,
        $replace$       'wait',
       'http_request'$replace$
      );
    else
      raise exception 'Could not patch advance_workflow_run native allowlist for http_request';
    end if;
  end if;

  execute v_sql;
end $$;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.process_journey_webhook(text,jsonb,jsonb,text)'::regprocedure)
    into v_sql;

  v_sql := replace(
    v_sql,
    $needle$not in ('create_lead_from_payload', 'find_lead_from_payload', 'conditional_split', 'wait')$needle$,
    $replace$not in ('create_lead_from_payload', 'find_lead_from_payload', 'conditional_split', 'wait', 'http_request')$replace$
  );

  v_sql := replace(
    v_sql,
    'Event workflow webhook start only supports create_lead_from_payload, find_lead_from_payload, conditional_split, or wait.',
    'Event workflow webhook start only supports create_lead_from_payload, find_lead_from_payload, conditional_split, wait, or http_request.'
  );

  execute v_sql;
end $$;
