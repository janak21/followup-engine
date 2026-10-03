-- Migration: native handlers for conditional_split, exit_flow, add_tag,
-- remove_tag, http_request, and wait_reply timeout. Moves these action types
-- out of the n8n W-DISPATCH fallback batch and into inline Postgres execution.
--
-- Pre-existing deployed RPC `process_action_conditional_split` was already
-- implemented but never wired into `dispatch_pending_actions` — builder-created
-- conditional_split actions silently fell through to the n8n batch, which has
-- no branch for them, so they sat `in_progress` until stale-recovery marked
-- them `failed`. Same gap existed for exit_flow, add_tag, remove_tag.
-- http_request and wait_reply timeout were handled by n8n W-DISPATCH — this
-- migration frees those from the n8n dependency as well.
--
-- http_request limitation: pg_net (Supabase's bundled HTTP extension) only
-- exposes http_get / http_post / http_delete helpers. PUT and PATCH are not
-- supportable natively without an Edge Function wrapper; GET/POST/DELETE
-- cover the overwhelming majority of webhook receiver use cases. PUT/PATCH
-- attempts are recorded to error_logs rather than being silently misrouted
-- through POST.
--
-- Existing per-action completion semantics preserved: the inline handlers
-- mark the action completed, log a `system/internal` event, then call
-- advance_journey (which now stamps the atomic advanced_at claim).

-- ----------------------------------------------------------
-- 1. process_action_exit_flow
--    Terminal node. No outcomes, no advance. Per-step exit_status override
--    supported (step.exit_status); defaults to 'completed'. Cancels any
--    pending sibling actions for this lead so a parallel in-flight action
--    doesn't keep running after exit.
-- ----------------------------------------------------------
create or replace function process_action_exit_flow(p_action_id uuid)
returns jsonb
language plpgsql security definer set search_path to public as $$
declare
  v_action actions;
  v_lead   leads;
  v_journey journeys;
  v_step   jsonb;
  v_exit_status text;
  v_cancelled int := 0;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status = 'completed' then return jsonb_build_object('status','already_completed'); end if;

  select * into v_lead from leads where id = v_action.lead_id for update;

  -- Resolve the optional step.exit_status override (defaults to 'completed').
  select * into v_journey
    from journeys
   where tenant_id = v_action.tenant_id
     and journey_key = v_lead.journey_template
     and active
   order by version desc limit 1;
  if v_journey.id is not null then
    select s into v_step
      from jsonb_array_elements(v_journey.spec->'steps') s
     where (s->>'index')::int = v_action.step_index;
    v_exit_status := coalesce(v_step->>'exit_status', 'completed');
  else
    v_exit_status := 'completed';
  end if;

  -- Cancel any other pending actions for this lead (e.g. a parallel wait_reply
  -- sibling) so the journey actually halts.
  update actions
     set status = 'cancelled', completed_at = now()
   where lead_id = v_lead.id
     and status = 'pending'
     and id <> p_action_id;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  -- Mark this action completed.
  update actions
     set status = 'completed',
         completed_at = now(),
         result = jsonb_build_object('outcome','exit', 'exit_status', v_exit_status,
                                     'cancelled_siblings', v_cancelled)
   where id = p_action_id;

  -- Terminate the lead's journey.
  update leads
     set journey_status = v_exit_status,
         next_action_at = null,
         updated_at = now()
   where id = v_lead.id;

  insert into events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object('step_type','exit_flow','exit_status',v_exit_status,
                             'cancelled_siblings', v_cancelled));

  return jsonb_build_object('status','success','exit_status',v_exit_status,
                            'cancelled_siblings', v_cancelled);
end;
$$;

-- ----------------------------------------------------------
-- 2. process_action_tag — handles BOTH add_tag and remove_tag
--    Tags stored as JSONB array on lead.custom_fields -> 'tags'.
--    add_tag: append if absent. remove_tag: filter out.
-- ----------------------------------------------------------
create or replace function process_action_tag(p_action_id uuid)
returns jsonb
language plpgsql security definer set search_path to public as $$
declare
  v_action actions;
  v_lead   leads;
  v_journey journeys;
  v_step   jsonb;
  v_tag    text;
  v_existing jsonb;
  v_next   jsonb;
  v_op     text;  -- 'add' or 'remove'
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status = 'completed' then return jsonb_build_object('status','already_completed'); end if;

  v_op := case when v_action.action_type = 'add_tag' then 'add'
               when v_action.action_type = 'remove_tag' then 'remove'
               else 'noop' end;
  if v_op = 'noop' then
    update actions set status='failed', error_message='process_action_tag called for non-tag action_type '||v_action.action_type
      where id = p_action_id;
    return jsonb_build_object('status','failed','reason','wrong_action_type');
  end if;

  select * into v_lead from leads where id = v_action.lead_id for update;

  -- Pull tag_name from the journey step spec (authoritative) and fall back
  -- to the action payload if a legacy/inline path stamped it there.
  select * into v_journey
    from journeys
   where tenant_id = v_action.tenant_id
     and journey_key = v_lead.journey_template
     and active
   order by version desc limit 1;
  if v_journey.id is not null then
    select s into v_step
      from jsonb_array_elements(v_journey.spec->'steps') s
     where (s->>'index')::int = v_action.step_index;
  end if;
  v_tag := coalesce(v_step->>'tag_name', v_action.payload->>'tag_name');
  if v_tag is null or btrim(v_tag) = '' then
    update actions set status='failed', error_message='tag_name missing on step spec and action payload'
      where id = p_action_id;
    return jsonb_build_object('status','failed','reason','tag_name_missing');
  end if;
  v_tag := btrim(v_tag);

  v_existing := coalesce(v_lead.custom_fields -> 'tags', '[]'::jsonb);

  if v_op = 'add' then
    if v_existing ? v_tag then
      -- already present; no-op
      v_next := v_existing;
    else
      v_next := v_existing || jsonb_build_array(v_tag);
    end if;
  else  -- remove
    v_next := (
      select jsonb_agg(elem)
        from jsonb_array_elements(v_existing) elem
       where elem #>> '{}' <> v_tag
    );
    if v_next is null then v_next := '[]'::jsonb; end if;
  end if;

  update leads
     set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), array['tags'], v_next),
         updated_at = now()
   where id = v_lead.id;

  update actions
     set status = 'completed',
         completed_at = now(),
         result = jsonb_build_object('outcome','default','op',v_op,'tag',v_tag,'tags_after',v_next)
   where id = p_action_id;

  insert into events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object('step_type', v_action.action_type, 'tag', v_tag,
                             'op', v_op, 'tags_after', v_next));

  perform advance_journey(p_action_id, 'default');
  return jsonb_build_object('status','success','op',v_op,'tag',v_tag,'tags_after',v_next);
end;
$$;

-- ----------------------------------------------------------
-- 3. process_action_wait_reply (timeout path)
--    Called by dispatch_pending_actions when a wait_reply action's run_at
--    is due AND the action is still pending (i.e. no inbound replied).
--    The inbound replied path still lives in process_inbound_sms/email
--    (they stamp the action completed + advance with 'replied' before
--    run_at is reached). This handler only fires on timeout.
--    Re-confirmed pending state to close the race: if an inbound reply
--    arrives during the dispatcher's lock-acquiring SELECT, this handler
--    re-checks status under row-lock and bails if not pending.
-- ----------------------------------------------------------
create or replace function process_action_wait_reply(p_action_id uuid)
returns jsonb
language plpgsql security definer set search_path to public as $$
declare
  v_action actions;
  v_lead   leads;
begin
  -- Atomic status check + lock. If an inbound handler raced us between the
  -- dispatcher's SELECT and this call, the row will no longer be pending.
  select * into v_action from actions where id = p_action_id for update;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status <> 'pending' then
    -- Inbound reply already consumed this action (status=completed) — no-op.
    return jsonb_build_object('status','already_handled','status_was',v_action.status);
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if v_lead.opt_out then
    -- Lead opted out during the wait window; no advance — lead journey is
    -- already in 'opted_out'. Just mark this action so dispatcher stops
    -- picking it up.
    update actions
       set status = 'cancelled', completed_at = now(),
           result = jsonb_build_object('outcome','opt_out_during_wait')
     where id = p_action_id;
    return jsonb_build_object('status','skipped','reason','opt_out_during_wait');
  end if;

  -- Mark completed, then advance with 'timeout'. advance_journey's atomic
  -- claim will ensure only one of {timeout, replied} wins even if a
  -- post-status-check race occurs.
  update actions
     set status = 'completed',
         completed_at = now(),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object('outcome','timeout')
   where id = p_action_id;

  perform advance_journey(p_action_id, 'timeout');
  return jsonb_build_object('status','success','outcome','timeout');
end;
$$;

-- ----------------------------------------------------------
-- 4. process_action_http_request — fire-and-forget via pg_net.
--    The pg_cron dispatcher is single-threaded; calling net.http_collect_response
--    with async:=false inside it would block the ENTIRE engine on a single
--    hung external HTTP. Instead this handler fires the request, marks the
--    action in_progress, and stamps result.pg_net_request_id. A separate
--    non-blocking collector (process_action_http_collector, called by the
--    dispatcher each subsequent tick) polls net._http_response for the result.
--    Supports POST/GET/DELETE. PUT/PATCH are unsupported by pg_net helpers and
--    are logged as errors (don't silently misroute through POST).
--    URL/headers/body are run through resolve_merge_tags so {{first_name}} etc.
--    resolve against the lead. Response is persisted on actions.result and,
--    if step.response_var is set, on lead.custom_fields[<response_var>] so
--    subsequent steps can reference the response via {{<response_var>.field}}.
--    Stale-recovery (mark_action_failed) intentionally does NOT retry
--    http_request — duplicate sends to external endpoints would be unsafe.
-- ----------------------------------------------------------
create or replace function process_action_http_request(p_action_id uuid)
returns jsonb
language plpgsql security definer set search_path to public as $$
declare
  v_action actions;
  v_lead   leads;
  v_journey journeys;
  v_step   jsonb;
  v_method text;
  v_url    text;
  v_headers_raw jsonb;
  v_headers_out jsonb := '{}'::jsonb;
  v_hkey   text;
  v_hval   text;
  v_body_raw text;
  v_body_text text;
  v_body_jsonb jsonb;
  v_response_var text;
  v_request_id bigint;
begin
  select * into v_action from actions where id = p_action_id for update;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status <> 'pending' then
    return jsonb_build_object('status','already_handled','status_was',v_action.status);
  end if;
  -- If we already fired pg_net for this action (previous interruptions),
  -- let the collector complete it — do NOT re-fire (would double-send).
  if v_action.result ? 'pg_net_request_id' then
    return jsonb_build_object('status','already_fired','request_id',v_action.result->>'pg_net_request_id');
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  select * into v_journey
    from journeys
   where tenant_id = v_action.tenant_id
     and journey_key = v_lead.journey_template
     and active
   order by version desc limit 1;
  if not found then
    update actions set status='failed', error_message='journey not found', completed_at=now()
      where id = p_action_id;
    return jsonb_build_object('status','failed','reason','journey_not_found');
  end if;

  select s into v_step
    from jsonb_array_elements(v_journey.spec->'steps') s
   where (s->>'index')::int = v_action.step_index;

  v_method := upper(coalesce(v_step->>'http_method', 'POST'));
  v_url    := coalesce(v_step->>'http_url', '');
  v_headers_raw := coalesce(v_step->'http_headers', '{}'::jsonb);
  v_body_raw    := coalesce(v_step->>'http_body', '');
  v_response_var := v_step->>'response_var';

  v_url := resolve_merge_tags(v_url, v_lead);
  if v_url is null or v_url = '' then
    update actions set status='failed', error_message='http_request step has no http_url', completed_at=now()
      where id = p_action_id;
    return jsonb_build_object('status','failed','reason','missing_url');
  end if;

  for v_hkey, v_hval in select key, value from jsonb_each_text(v_headers_raw) loop
    v_headers_out := v_headers_out || jsonb_build_object(v_hkey, resolve_merge_tags(coalesce(v_hval,''), v_lead));
  end loop;
  if v_method in ('POST','PUT','PATCH')
     and (v_headers_out ? 'Content-Type') = false
     and v_body_raw <> '' then
    v_headers_out := v_headers_out || jsonb_build_object('Content-Type','application/json');
  end if;

  v_body_text := resolve_merge_tags(v_body_raw, v_lead);
  v_body_jsonb := null;
  if v_body_text is not null and v_body_text <> '' then
    begin
      v_body_jsonb := v_body_text::jsonb;
    exception when others then
      v_body_jsonb := to_jsonb(v_body_text);
    end;
  end if;

  -- Method dispatch. PUT/PATCH not supported by pg_net helpers.
  if v_method = 'POST' then
    select net.http_post(url:=v_url, body:=coalesce(v_body_jsonb,'{}'::jsonb),
                         headers:=v_headers_out, timeout_milliseconds:=10000)
      into v_request_id;
  elsif v_method = 'GET' then
    select net.http_get(url:=v_url, headers:=v_headers_out, timeout_milliseconds:=10000)
      into v_request_id;
  elsif v_method = 'DELETE' then
    select net.http_delete(url:=v_url, headers:=v_headers_out, timeout_milliseconds:=10000)
      into v_request_id;
  else
    insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, created_at)
    values (v_action.tenant_id, 'process_action_http_request',
            'pg_net has no native helper for HTTP method '||v_method||'; only POST/GET/DELETE supported natively.',
            jsonb_build_object('action_id',p_action_id,'method',v_method,'url',v_url),
            'error', now());
    update actions
       set status='failed',
           error_message='unsupported_http_method: '||v_method,
           completed_at=now(),
           result=jsonb_build_object('outcome','failed','reason','unsupported_method','method',v_method)
     where id = p_action_id;
    perform advance_journey(p_action_id, 'default');
    return jsonb_build_object('status','failed','reason','unsupported_method','method',v_method);
  end if;

  if v_request_id is null then
    update actions set status='failed',
           error_message='pg_net returned null request_id', completed_at=now()
      where id = p_action_id;
    perform advance_journey(p_action_id, 'default');
    return jsonb_build_object('status','failed','reason','pg_net_null_request_id');
  end if;

  -- Mark in_progress + stamp request_id. NO blocking. The dispatcher's
  -- collector loop (process_action_http_collector) will check net._http_response
  -- on subsequent ticks and complete the action. Set locked_until far enough
  -- out (5 min) so stale-recovery doesn't double-fire before the worker has
  -- a chance to fulfil the request.
  update actions
     set status      = 'in_progress',
         locked_until = now() + interval '5 minutes',
         result = jsonb_build_object(
                    'pg_net_request_id', v_request_id,
                    'fired_at', now(),
                    'http_method', v_method,
                    'http_url', v_url,
                    'response_var', v_response_var
                  )
   where id = p_action_id;

  return jsonb_build_object('status','fired','request_id',v_request_id);
end;
$$;

-- ----------------------------------------------------------
-- 4b. process_action_http_collector — non-blocking.
--    Called by dispatch_pending_actions each tick. For every in_progress
--    http_request whose pg_net_request_id has a row in net._http_response,
--    completes the action with status_code/body/headers, persists the
--    response_var onto lead.custom_fields if configured, and advances.
--    Non-blocking: pure SELECT against pg_net's responses table.
-- ----------------------------------------------------------
create or replace function process_action_http_collector(p_batch int default 50)
returns int
language plpgsql security definer set search_path to public as $$
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
       and a.result ? 'collected_at' = false
     order by a.run_at limit p_batch
  loop
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
         set custom_fields = jsonb_set(coalesce(custom_fields,'{}'::jsonb), array[v_response_var], v_parsed),
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
$$;

-- ----------------------------------------------------------
-- 4c. mark_action_failed — extend the no-retry list so http_request and
--     wait_reply fail-permanent on stale-lock instead of re-firing.
--     http_request re-fire would double-send to external endpoints.
--     wait_reply timeout re-fire could race with a late inbound replied.
-- ----------------------------------------------------------
create or replace function mark_action_failed(
  p_action_id uuid,
  p_error_message text,
  p_max_retries integer default null
)
returns jsonb
language plpgsql security definer set search_path to public as $$
declare
  v_action actions;
  v_max   int;
  v_next  timestamptz;
  v_db_only_types text[] := array[
    'wait','find_lead','create_lead','update_lead',
    'conditional_split','add_tag','remove_tag',
    'http_request','wait_reply'
  ];
  v_should_retry bool;
  v_new_count int;
begin
  select * into v_action from actions where id = p_action_id for update;
  if not found then
    return jsonb_build_object('status','not_found');
  end if;
  if v_action.status = 'completed' or v_action.status = 'failed_permanent' then
    return jsonb_build_object('status','already_terminal','existing_status', v_action.status);
  end if;

  v_max := coalesce(p_max_retries, v_action.max_retries, 3);
  v_new_count := v_action.retry_count + 1;
  v_should_retry := (v_action.action_type <> all(v_db_only_types))
                    and v_new_count <= v_max;

  if v_should_retry then
    v_next := case v_new_count
      when 1 then now() + interval '1 minute'
      when 2 then now() + interval '5 minutes'
      when 3 then now() + interval '30 minutes'
      else        now() + interval '2 hours'
    end;
    update actions
       set status        = 'pending',
           retry_count   = v_new_count,
           next_retry_at = v_next,
           run_at        = v_next,
           locked_until  = null,
           locked_by     = null,
           error_message = left(p_error_message, 2000)
     where id = p_action_id;
    return jsonb_build_object('status','rescheduled',
                              'retry_count', v_new_count,
                              'next_retry_at', v_next);
  end if;

  update actions
     set status        = 'failed_permanent',
         retry_count   = v_new_count,
         locked_until  = null,
         locked_by     = null,
         error_message = left(p_error_message, 2000)
   where id = p_action_id;

  insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, created_at)
       values (v_action.tenant_id, 'action_failed_permanent',
               coalesce(p_error_message,'unspecified'),
               jsonb_build_object('action_id', p_action_id,
                                  'action_type', v_action.action_type,
                                  'retry_count', v_new_count,
                                  'step_index', v_action.step_index,
                                  'lead_id', v_action.lead_id),
               'error', now());

  return jsonb_build_object('status','failed_permanent',
                            'retry_count', v_new_count);
end;
$$;

-- ----------------------------------------------------------
-- 5. Rewrite dispatch_pending_actions to route all native handlers inline
--    and exclude them from the n8n-fallback batch. All previously-deployed
--    behavior (stale recovery, call/sms/email/ai_reply pg_net dispatch,
--    per-batch limit, error capture) is preserved verbatim.
-- ----------------------------------------------------------
create or replace function dispatch_pending_actions(
  worker_id text,
  batch_size integer default 20
)
returns setof actions
language plpgsql
as $$
declare
  v_inline_id uuid; v_inline_type text;
  v_stale_id uuid;  v_stale_type text;
  v_call_action     actions;
  v_sms_action      actions;
  v_email_action    actions;
  v_ai_reply_action actions;
  v_dispatch_key text;
  v_call_url     text := 'https://your-project-ref.supabase.co/functions/v1/dispatch-retell-call';
  v_sms_url      text := 'https://your-project-ref.supabase.co/functions/v1/dispatch-twilio-sms';
  v_email_url    text := 'https://your-project-ref.supabase.co/functions/v1/dispatch-gmail-email';
  v_ai_reply_url text := 'https://your-project-ref.supabase.co/functions/v1/generate-ai-reply';
  v_net_request_id bigint;
begin
  -- Stale-action recovery
  for v_stale_id, v_stale_type in
    select id, action_type from actions
     where status='in_progress' and locked_until is not null and locked_until < now() - interval '60 seconds'
     order by locked_until limit 100 for update skip locked
  loop
    begin
      perform mark_action_failed(v_stale_id,
        'dispatcher_lock_expired: action ' || v_stale_id::text || ' (' || v_stale_type ||
        ') was locked but never completed; retrying per mark_action_failed policy.');
    exception when others then
      insert into error_logs (workflow_name, error_message, raw_error, severity, created_at)
        values ('dispatcher_stale_recovery', sqlerrm,
                jsonb_build_object('action_id', v_stale_id, 'sqlstate', sqlstate), 'error', now());
    end;
  end loop;

  v_dispatch_key := get_internal_dispatch_key();
  if v_dispatch_key is null then
    insert into error_logs (workflow_name, error_message, severity, created_at)
      values ('dispatcher_inline', 'internal_dispatch_key not set in Vault', 'error', now());
  end if;

  if v_dispatch_key is not null then
    -- Call dispatch
    for v_call_action in
      update actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from actions where action_type='call' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        select net.http_post(url:=v_call_url,
          body:=jsonb_build_object('action_id', v_call_action.id),
          headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
          timeout_milliseconds:=30000) into v_net_request_id;
      exception when others then
        perform mark_action_failed(v_call_action.id, 'dispatcher: failed dispatch-retell-call via pg_net: '||sqlerrm);
      end;
    end loop;

    -- SMS dispatch
    for v_sms_action in
      update actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from actions where action_type='sms' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        select net.http_post(url:=v_sms_url,
          body:=jsonb_build_object('action_id', v_sms_action.id),
          headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
          timeout_milliseconds:=30000) into v_net_request_id;
      exception when others then
        perform mark_action_failed(v_sms_action.id, 'dispatcher: failed dispatch-twilio-sms via pg_net: '||sqlerrm);
      end;
    end loop;

    -- Email dispatch
    for v_email_action in
      update actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from actions where action_type='email' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        select net.http_post(url:=v_email_url,
          body:=jsonb_build_object('action_id', v_email_action.id),
          headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
          timeout_milliseconds:=30000) into v_net_request_id;
      exception when others then
        perform mark_action_failed(v_email_action.id, 'dispatcher: failed dispatch-gmail-email via pg_net: '||sqlerrm);
      end;
    end loop;

    -- AI Reply dispatch
    for v_ai_reply_action in
      update actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from actions where action_type='ai_reply' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        select net.http_post(url:=v_ai_reply_url,
          body:=jsonb_build_object('action_id', v_ai_reply_action.id),
          headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
          timeout_milliseconds:=60000) into v_net_request_id;
      exception when others then
        perform mark_action_failed(v_ai_reply_action.id, 'dispatcher: failed generate-ai-reply via pg_net: '||sqlerrm);
      end;
    end loop;
  end if;

  -- Fast inline-processed types (pure Postgres, sub-millisecond).
  -- Now includes: wait, create_lead, update_lead, find_lead, team_alert
  -- plus the newly-native: conditional_split, exit_flow, add_tag,
  -- remove_tag, wait_reply (timeout).
  for v_inline_id, v_inline_type in
    select id, action_type from actions
     where action_type in (
             'wait','create_lead','update_lead','find_lead','team_alert',
             'conditional_split','exit_flow','add_tag','remove_tag','wait_reply'
           )
       and status='pending' and run_at<=now()
     order by run_at limit 500 for update skip locked
  loop
    begin
      if v_inline_type='wait' then perform process_wait_action(v_inline_id);
      elsif v_inline_type in ('create_lead','update_lead') then perform process_action_set_lead_fields(v_inline_id);
      elsif v_inline_type='find_lead' then perform process_action_find_lead(v_inline_id);
      elsif v_inline_type='team_alert' then perform process_team_alert_action(v_inline_id);
      elsif v_inline_type='conditional_split' then perform process_action_conditional_split(v_inline_id);
      elsif v_inline_type='exit_flow' then perform process_action_exit_flow(v_inline_id);
      elsif v_inline_type in ('add_tag','remove_tag') then perform process_action_tag(v_inline_id);
      elsif v_inline_type='wait_reply' then perform process_action_wait_reply(v_inline_id);
      end if;
    exception when others then
      insert into error_logs (tenant_id, workflow_name, error_message, raw_error, created_at)
        select tenant_id, 'dispatch_pending_actions:inline:'||v_inline_type, sqlerrm,
               jsonb_build_object('action_id', v_inline_id, 'sqlstate', sqlstate), now()
          from actions where id = v_inline_id;
    end;
  end loop;

  -- http_request: fire-and-forget pg_net call. process_action_http_request
  -- marks the action in_progress with result.pg_net_request_id (no blocking).
  for v_inline_id, v_inline_type in
    select id, action_type from actions
     where action_type='http_request'
       and status='pending' and run_at<=now()
     order by run_at limit 20 for update skip locked
  loop
    begin
      perform process_action_http_request(v_inline_id);
    exception when others then
      insert into error_logs (tenant_id, workflow_name, error_message, raw_error, created_at)
        select tenant_id, 'dispatch_pending_actions:inline:http_request_fire', sqlerrm,
               jsonb_build_object('action_id', v_inline_id, 'sqlstate', sqlstate), now()
          from actions where id = v_inline_id;
    end;
  end loop;

  -- http_request: collector — non-blocking poll of net._http_response for fired
  -- requests whose response has materialized. Completes the action + advances.
  -- http_request failure is permanent (no retry) to avoid double external sends
  -- (mark_action_failed's v_db_only_types includes http_request).
  begin
    perform process_action_http_collector(50);
  exception when others then
    insert into error_logs (workflow_name, error_message, raw_error, severity, created_at)
      values ('dispatch_pending_actions:http_collector', sqlerrm,
              jsonb_build_object('sqlstate', sqlstate), 'error', now());
  end;

  -- Remaining n8n fallback: none left after this migration — all known action
  -- types are now handled inline. The return-query is kept for forward-compat
  -- (any future action_type that isn't in the lists above still surfaces for
  -- the dispatcher to lock+return, so a new type doesn't silently no-op).
  return query
    update actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
     where id in (
       select id from actions where run_at<=now() and status='pending'
          and action_type not in (
                'wait','create_lead','update_lead','find_lead','team_alert',
                'conditional_split','exit_flow','add_tag','remove_tag',
                'http_request','wait_reply',
                'call','sms','email','ai_reply'
          )
          and (locked_until is null or locked_until<now())
        order by run_at limit batch_size for update skip locked
     ) returning *;
end;
$$;