-- Make Wait an event-native workflow action for webhook-triggered automations.
--
-- This keeps legacy lead journey waits unchanged. In event workflows, Wait is
-- processed through workflow_actions, can run before a lead exists, and then
-- advances to the next workflow step without calling providers.

create or replace function public.workflow_step_run_at(
  p_step jsonb,
  p_base timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_step_type text := coalesce(p_step ->> 'type', '');
  v_wait_mode text := coalesce(p_step ->> 'mode', 'duration');
  v_until_iso text;
  v_delay_amount_text text;
  v_delay_amount numeric;
  v_delay_unit text;
begin
  if v_step_type = 'wait' and v_wait_mode = 'until' then
    v_until_iso := p_step -> 'until' ->> 'datetime';
    if nullif(v_until_iso, '') is not null then
      begin
        return greatest(v_until_iso::timestamptz, p_base);
      exception
        when others then
          return p_base;
      end;
    end if;

    return p_base;
  end if;

  v_delay_amount_text := coalesce(
    p_step -> 'duration' ->> 'amount',
    p_step -> 'delay' ->> 'amount',
    case when v_step_type = 'wait_reply' then '12' else null end,
    '0'
  );
  v_delay_unit := lower(coalesce(
    p_step -> 'duration' ->> 'unit',
    p_step -> 'delay' ->> 'unit',
    case when v_step_type = 'wait_reply' then 'hours' else null end,
    'minutes'
  ));

  if coalesce(v_delay_amount_text, '') ~ '^[0-9]+(\.[0-9]+)?$'
     and v_delay_unit in ('second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days') then
    v_delay_amount := v_delay_amount_text::numeric;
    return p_base + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
  end if;

  return p_base;
end;
$$;

create or replace function public.process_workflow_wait_action(
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
  v_outcome text := 'default';
  v_summary jsonb;
  v_advance jsonb;
  v_context_key text;
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

  if v_action.action_type <> 'wait' then
    v_summary := jsonb_build_object(
      'status', 'failed',
      'error', 'process_workflow_wait_action only supports wait actions.'
    );

    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = v_summary ->> 'error',
           result = coalesce(result, '{}'::jsonb) || v_summary
     where id = v_action.id;

    return v_summary;
  end if;

  select *
    into v_run
    from public.journey_runs
   where id = v_action.run_id
     and tenant_id = v_action.tenant_id
   for update;

  if not found then
    v_summary := jsonb_build_object(
      'status', 'failed',
      'error', 'Associated journey run was not found.'
    );

    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_by = null,
           locked_until = null,
           last_error = v_summary ->> 'error',
           result = coalesce(result, '{}'::jsonb) || v_summary
     where id = v_action.id;

    return v_summary;
  end if;

  v_step := v_action.payload -> 'step_spec';
  if v_step is not null and v_step <> 'null'::jsonb then
    if coalesce(v_step -> 'on_outcome', '{}'::jsonb) ? 'default' then
      v_outcome := 'default';
    elsif coalesce(v_step -> 'on_outcome', '{}'::jsonb) ? 'completed' then
      v_outcome := 'completed';
    end if;
  end if;

  v_context_key := 'wait_' || coalesce(v_action.step_index::text, 'unknown');
  v_summary := jsonb_build_object(
    'status', 'completed',
    'outcome', v_outcome,
    'wait_completed_at', now(),
    'step_index', v_action.step_index
  );

  update public.workflow_actions
     set status = 'completed',
         completed_at = coalesce(completed_at, now()),
         locked_by = null,
         locked_until = null,
         last_error = null,
         lead_id = coalesce(lead_id, v_run.lead_id),
         result = coalesce(result, '{}'::jsonb) || v_summary
   where id = v_action.id;

  update public.journey_runs
     set context = jsonb_set(
           coalesce(context, '{}'::jsonb),
           array['steps', v_context_key],
           v_summary,
           true
         ),
         last_error = null
   where id = v_run.id;

  v_advance := public.advance_workflow_run(v_action.id, v_outcome);

  return v_summary || jsonb_build_object('advance', coalesce(v_advance, '{}'::jsonb));
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
  v_batch_size integer := greatest(coalesce(p_batch_size, 50), 0);
  v_worker_id text := coalesce(nullif(btrim(p_worker_id), ''), 'workflow-worker');
begin
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
      'stale_recovered', v_stale_recovered
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
    'stale_recovered', v_stale_recovered
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
    'unsupported', v_unsupported
  );
end;
$$;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.advance_workflow_run(uuid,text)'::regprocedure)
    into v_sql;

  v_sql := replace(
    v_sql,
    $needle$    'call',
    'wait',
    'wait_reply',$needle$,
    $replace$    'call',
    'wait_reply',$replace$
  );

  if position($needle$       'conditional_split',
       'wait'$needle$ in v_sql) = 0 then
    if position($needle$       'conditional_split'$needle$ in v_sql) > 0 then
      v_sql := replace(
        v_sql,
        $needle$       'conditional_split'$needle$,
        $replace$       'conditional_split',
       'wait'$replace$
      );
    elsif position($needle$       'find_lead_from_payload'$needle$ in v_sql) > 0 then
      v_sql := replace(
        v_sql,
        $needle$       'find_lead_from_payload'$needle$,
        $replace$       'find_lead_from_payload',
       'wait'$replace$
      );
    else
      raise exception 'Could not patch advance_workflow_run native allowlist for wait';
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
    $needle$not in ('create_lead_from_payload', 'find_lead_from_payload', 'conditional_split')$needle$,
    $replace$not in ('create_lead_from_payload', 'find_lead_from_payload', 'conditional_split', 'wait')$replace$
  );

  v_sql := replace(
    v_sql,
    $needle$not in ('create_lead_from_payload', 'find_lead_from_payload')$needle$,
    $replace$not in ('create_lead_from_payload', 'find_lead_from_payload', 'wait')$replace$
  );

  v_sql := replace(
    v_sql,
    'Event workflow webhook start only supports create_lead_from_payload, find_lead_from_payload, or conditional_split.',
    'Event workflow webhook start only supports create_lead_from_payload, find_lead_from_payload, conditional_split, or wait.'
  );

  v_sql := replace(
    v_sql,
    'Event workflow webhook start only supports create_lead_from_payload or find_lead_from_payload.',
    'Event workflow webhook start only supports create_lead_from_payload, find_lead_from_payload, or wait.'
  );

  v_sql := replace(
    v_sql,
    $needle$      v_trigger_step_index,
      now(),
      'pending',$needle$,
    $replace$      v_trigger_step_index,
      public.workflow_step_run_at(v_step0),
      'pending',$replace$
  );

  execute v_sql;
end $$;
