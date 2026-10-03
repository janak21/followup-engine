-- Event workflow advancement for workflow_actions.
--
-- This function intentionally queues only workflow_actions. It does not touch
-- legacy action advancement, schedulers, or providers.
--
-- Leadless event workflows are conservative for now: only payload-native step
-- types are queued without a lead. Lead-required steps fail the run with a
-- clear error until the event dispatcher/bridging runtime exists.

create or replace function public.advance_workflow_run(
  p_workflow_action_id uuid,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_run public.journey_runs%rowtype;
  v_journey public.journeys%rowtype;
  v_steps jsonb;
  v_current_step jsonb;
  v_next_step jsonb;
  v_outcome_spec jsonb;
  v_exit text;
  v_next_index integer;
  v_next_type text;
  v_run_at timestamptz := now();
  v_delay_amount_text text;
  v_delay_amount numeric;
  v_delay_unit text;
  v_idempotency_key text;
  v_next_action_id uuid;
  v_reason text;
  v_existing_advanced boolean := false;
begin
  if p_workflow_action_id is null then
    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'status', 'not_found',
      'run_status', null
    );
  end if;

  select *
    into v_action
    from public.workflow_actions
   where id = p_workflow_action_id
   for update;

  if not found then
    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'status', 'not_found',
      'run_status', null
    );
  end if;

  v_existing_advanced := coalesce(v_action.result, '{}'::jsonb) ? 'advanced_at';

  select *
    into v_run
    from public.journey_runs
   where id = v_action.run_id
   for update;

  if not found then
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           last_error = 'Associated journey run was not found.',
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'failed_permanent_at', now(),
             'failure_message', 'Associated journey run was not found.'
           )
     where id = v_action.id;

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'status', 'failed',
      'reason', 'Associated journey run was not found.',
      'run_status', null
    );
  end if;

  if v_run.journey_id is not null then
    select *
      into v_journey
      from public.journeys
     where id = v_run.journey_id
       and tenant_id = v_run.tenant_id
     limit 1;
  end if;

  if v_journey.id is null
     and nullif(trim(coalesce(v_run.journey_key, '')), '') is not null then
    select *
      into v_journey
      from public.journeys
     where tenant_id = v_run.tenant_id
       and journey_key = v_run.journey_key
       and active
     order by version desc
     limit 1;
  end if;

  if v_journey.id is null then
    update public.workflow_actions
       set status = case when status in ('completed', 'failed_permanent', 'cancelled') then status else 'completed' end,
           completed_at = coalesce(completed_at, now()),
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'advanced_at', coalesce(result ->> 'advanced_at', now()::text),
             'advanced_outcome', p_outcome,
             'advance_terminal_reason', 'journey_not_found'
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           last_error = null
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'next_action_id', null,
      'next_step_index', null,
      'run_status', 'completed',
      'reason', 'journey_not_found'
    );
  end if;

  v_steps := coalesce(v_journey.spec -> 'steps', '[]'::jsonb);
  v_current_step := v_action.payload -> 'step_spec';

  if v_current_step is null or v_current_step = 'null'::jsonb then
    select s
      into v_current_step
      from jsonb_array_elements(v_steps) s
     where (s ->> 'index') ~ '^-?[0-9]+$'
       and (s ->> 'index')::integer = v_action.step_index
     limit 1;
  end if;

  if v_current_step is null or v_current_step = 'null'::jsonb then
    v_reason := 'Current workflow step was not found.';

    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           last_error = v_reason,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'failed_permanent_at', now(),
             'failure_message', v_reason,
             'advanced_outcome', p_outcome
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = v_reason
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'next_action_id', null,
      'next_step_index', null,
      'run_status', 'failed',
      'reason', v_reason
    );
  end if;

  v_outcome_spec := v_current_step -> 'on_outcome' -> p_outcome;
  v_exit := v_outcome_spec ->> 'exit';

  if v_exit is not null then
    update public.workflow_actions
       set status = case when status in ('completed', 'failed_permanent', 'cancelled') then status else 'completed' end,
           completed_at = coalesce(completed_at, now()),
           locked_until = null,
           locked_by = null,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'advanced_at', coalesce(result ->> 'advanced_at', now()::text),
             'advanced_outcome', p_outcome,
             'advance_exit', v_exit
           )
     where id = v_action.id;

    update public.journey_runs
       set status = v_exit,
           completed_at = case when v_exit in ('completed', 'finished') then coalesce(completed_at, now()) else completed_at end,
           failed_at = case when v_exit = 'failed' then coalesce(failed_at, now()) else failed_at end,
           last_error = case when v_exit = 'failed' then coalesce(last_error, 'Workflow exited with failed status.') else null end
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'next_action_id', null,
      'next_step_index', null,
      'run_status', v_exit
    );
  end if;

  if v_outcome_spec is null
     or v_outcome_spec = 'null'::jsonb
     or not (v_outcome_spec ? 'next_step')
     or nullif(v_outcome_spec ->> 'next_step', '') is null then
    update public.workflow_actions
       set status = case when status in ('completed', 'failed_permanent', 'cancelled') then status else 'completed' end,
           completed_at = coalesce(completed_at, now()),
           locked_until = null,
           locked_by = null,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'advanced_at', coalesce(result ->> 'advanced_at', now()::text),
             'advanced_outcome', p_outcome,
             'advance_terminal_reason', 'no_next_step'
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           last_error = null
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'next_action_id', null,
      'next_step_index', null,
      'run_status', 'completed',
      'reason', 'no_next_step'
    );
  end if;

  if not ((v_outcome_spec ->> 'next_step') ~ '^-?[0-9]+$') then
    v_reason := 'Next workflow step index is invalid.';

    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           last_error = v_reason,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'failed_permanent_at', now(),
             'failure_message', v_reason,
             'advanced_outcome', p_outcome
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = v_reason
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'next_action_id', null,
      'next_step_index', null,
      'run_status', 'failed',
      'reason', v_reason
    );
  end if;

  v_next_index := (v_outcome_spec ->> 'next_step')::integer;

  select s
    into v_next_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index') ~ '^-?[0-9]+$'
     and (s ->> 'index')::integer = v_next_index
   limit 1;

  if v_next_step is null or v_next_step = 'null'::jsonb then
    update public.workflow_actions
       set status = case when status in ('completed', 'failed_permanent', 'cancelled') then status else 'completed' end,
           completed_at = coalesce(completed_at, now()),
           locked_until = null,
           locked_by = null,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'advanced_at', coalesce(result ->> 'advanced_at', now()::text),
             'advanced_outcome', p_outcome,
             'advance_terminal_reason', 'next_step_not_found'
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           last_error = null
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'next_action_id', null,
      'next_step_index', v_next_index,
      'run_status', 'completed',
      'reason', 'next_step_not_found'
    );
  end if;

  v_next_type := coalesce(nullif(trim(v_next_step ->> 'type'), ''), 'unknown');

  if v_run.lead_id is null
     and v_next_type not in (
       'create_lead_from_payload',
       'find_lead_from_payload',
       'wait',
       'exit_flow'
     ) then
    v_reason := 'Step requires a lead before it can run.';

    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_until = null,
           locked_by = null,
           last_error = v_reason,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'failed_permanent_at', now(),
             'failure_message', v_reason,
             'advanced_outcome', p_outcome,
             'blocked_next_step_index', v_next_index,
             'blocked_next_step_type', v_next_type
           )
     where id = v_action.id;

    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = v_reason
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'advanced', false,
      'outcome', p_outcome,
      'next_action_id', null,
      'next_step_index', v_next_index,
      'run_status', 'failed',
      'reason', v_reason
    );
  end if;

  if v_next_type = 'wait' then
    v_delay_amount_text := coalesce(
      v_next_step -> 'duration' ->> 'amount',
      v_next_step -> 'delay' ->> 'amount'
    );
    v_delay_unit := lower(coalesce(
      v_next_step -> 'duration' ->> 'unit',
      v_next_step -> 'delay' ->> 'unit',
      'minutes'
    ));

    if coalesce(v_delay_amount_text, '') ~ '^[0-9]+(\.[0-9]+)?$'
       and v_delay_unit in ('second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days') then
      v_delay_amount := v_delay_amount_text::numeric;
      v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
    else
      v_run_at := now();
    end if;
  else
    v_delay_amount_text := v_next_step -> 'delay' ->> 'amount';
    v_delay_unit := lower(coalesce(v_next_step -> 'delay' ->> 'unit', 'minutes'));

    if coalesce(v_delay_amount_text, '') ~ '^[0-9]+(\.[0-9]+)?$'
       and v_delay_unit in ('second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days') then
      v_delay_amount := v_delay_amount_text::numeric;
      v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
    else
      v_run_at := now();
    end if;
  end if;

  v_idempotency_key := v_run.id::text || ':' || v_action.id::text || ':' || v_next_index::text || ':' || coalesce(p_outcome, '');

  insert into public.workflow_actions (
    tenant_id,
    run_id,
    lead_id,
    action_type,
    step_index,
    run_at,
    status,
    idempotency_key,
    payload
  ) values (
    v_action.tenant_id,
    v_action.run_id,
    v_run.lead_id,
    v_next_type,
    v_next_index,
    v_run_at,
    'pending',
    v_idempotency_key,
    jsonb_build_object(
      'step_spec', v_next_step,
      'parent_workflow_action_id', v_action.id,
      'advanced_from_outcome', p_outcome,
      'enrolled_via', coalesce(v_journey.journey_key, v_run.journey_key)
    )
  )
  on conflict (tenant_id, idempotency_key) do update
     set idempotency_key = excluded.idempotency_key
  returning id into v_next_action_id;

  update public.workflow_actions
     set status = case when status in ('completed', 'failed_permanent', 'cancelled') then status else 'completed' end,
         completed_at = coalesce(completed_at, now()),
         locked_until = null,
         locked_by = null,
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'advanced_at', case when v_existing_advanced then result ->> 'advanced_at' else now()::text end,
           'advanced_outcome', p_outcome,
           'next_action_id', v_next_action_id,
           'next_step_index', v_next_index
         )
   where id = v_action.id;

  update public.journey_runs
     set status = case when status = 'running' then 'running' else status end,
         last_error = null
   where id = v_run.id
     and status not in ('completed', 'failed', 'cancelled');

  return jsonb_build_object(
    'advanced', not v_existing_advanced,
    'outcome', p_outcome,
    'next_action_id', v_next_action_id,
    'next_step_index', v_next_index,
    'run_status', (
      select status from public.journey_runs where id = v_run.id
    )
  );
end;
$$;
