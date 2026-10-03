-- Phase 1: advance_journey is run-centric. Runs own step state; lead columns
-- are a compat mirror written only when the run matches lead.journey_template
-- (or the action predates runs). Behavior for legacy run-less actions is
-- unchanged.

create or replace function public.advance_journey(
  p_action_id uuid,
  p_outcome text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_lead public.leads%rowtype;
  v_tenant public.tenants%rowtype;
  v_run public.journey_runs%rowtype;
  v_journey public.journeys%rowtype;
  v_steps jsonb;
  v_current_step jsonb;
  v_next_step jsonb;
  v_exit text;
  v_next_index integer;
  v_delay_amount numeric;
  v_delay_unit text;
  v_run_at timestamptz;
  v_new_action_id uuid;
  v_wait_mode text;
  v_until_iso text;
  v_on_passed text;
  v_on_passed_step integer;
  v_aw jsonb;
  v_clamp_tz text;
  v_next_type text;
  v_has_event_run boolean := false;
  v_terminal_status text;
  v_mirror boolean := true;  -- PHASE1: whether lead columns mirror this run
begin
  update public.actions
     set result = coalesce(result, '{}'::jsonb)
                  || jsonb_build_object(
                    'advanced_at', now(),
                    'advanced_outcome', p_outcome
                  )
   where id = p_action_id
     and not (coalesce(result, '{}'::jsonb) ? 'advanced_at')
  returning * into v_action;

  if not found then
    return null;
  end if;

  select * into v_lead
    from public.leads
   where id = v_action.lead_id
   for update;

  if not found then
    update public.actions
       set status = 'failed_permanent',
           error_message = 'lead not found',
           last_error = 'lead not found',
           locked_until = null,
           locked_by = null
     where id = v_action.id;
    return null;
  end if;

  select * into v_tenant
    from public.tenants
   where id = v_action.tenant_id;

  v_clamp_tz := coalesce(nullif(v_lead.timezone, ''), v_tenant.timezone);

  if v_action.run_id is not null then
    select * into v_run
      from public.journey_runs
     where id = v_action.run_id
       and tenant_id = v_action.tenant_id
     for update;

    if found then
      v_has_event_run := true;

      if v_run.journey_id is not null then
        select * into v_journey
          from public.journeys
         where id = v_run.journey_id
           and tenant_id = v_run.tenant_id
         limit 1;
      end if;

      if v_journey.id is null and nullif(trim(coalesce(v_run.journey_key, '')), '') is not null then
        select * into v_journey
          from public.journeys
         where tenant_id = v_run.tenant_id
           and journey_key = v_run.journey_key
           and active
         order by version desc
         limit 1;
      end if;
    end if;
  end if;

  if v_journey.id is null then
    select * into v_journey
      from public.journeys
     where tenant_id = v_lead.tenant_id
       and journey_key = v_lead.journey_template
       and active
     order by version desc
     limit 1;
  end if;

  -- PHASE1: mirror lead columns only for the lead's primary journey.
  if v_has_event_run and v_journey.id is not null
     and coalesce(v_journey.journey_key, '') <> coalesce(v_lead.journey_template, '') then
    v_mirror := false;
  end if;

  if v_journey.id is null then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'failed',
             failed_at = coalesce(failed_at, now()),
             last_error = 'journey_not_found'
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_steps := coalesce(v_journey.spec -> 'steps', '[]'::jsonb);

  select s into v_current_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::integer = v_action.step_index
   limit 1;

  if v_current_step is null and v_action.payload ? 'step_spec' then
    v_current_step := v_action.payload -> 'step_spec';
  end if;

  if v_current_step is null or v_current_step = 'null'::jsonb then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'failed',
             failed_at = coalesce(failed_at, now()),
             last_error = 'current_step_not_found'
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_exit := v_current_step -> 'on_outcome' -> p_outcome ->> 'exit';
  if v_exit is not null then
    v_terminal_status := case when v_exit in ('finished') then 'completed' else v_exit end;

    if v_mirror then
      update public.leads
         set journey_status = v_exit,
             next_action_at = null,
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = v_terminal_status,
             responded = responded or (v_terminal_status = 'responded'),  -- PHASE1
             completed_at = case when v_terminal_status = 'completed' then coalesce(completed_at, now()) else completed_at end,
             failed_at = case when v_terminal_status = 'failed' then coalesce(failed_at, now()) else failed_at end,
             last_error = case when v_terminal_status = 'failed' then coalesce(last_error, 'Journey exited with failed status.') else null end
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_next_index := nullif(v_current_step -> 'on_outcome' -> p_outcome ->> 'next_step', '')::integer;
  if v_next_index is null then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             next_action_at = null,
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'completed',
             completed_at = coalesce(completed_at, now()),
             last_error = null
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  select s into v_next_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::integer = v_next_index
   limit 1;

  if v_next_step is null or v_next_step = 'null'::jsonb then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             next_action_at = null,
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'completed',
             completed_at = coalesce(completed_at, now()),
             last_error = null
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_next_type := v_next_step ->> 'type';

  if v_next_type in ('wait', 'wait_reply') then
    v_wait_mode := coalesce(v_next_step ->> 'mode', 'duration');
    v_aw := v_next_step -> 'advance_window';

    if v_wait_mode = 'until' then
      v_until_iso := v_next_step -> 'until' ->> 'datetime';

      if v_until_iso is null then
        v_run_at := now();
      else
        v_run_at := v_until_iso::timestamptz;

        if v_run_at <= now() then
          if v_next_type = 'wait' then
            v_on_passed := coalesce(v_next_step ->> 'on_passed', 'continue');
            v_on_passed_step := nullif(v_next_step ->> 'on_passed_step', '')::integer;

            if v_on_passed = 'exit' then
              if v_mirror then
                update public.leads
                   set journey_status = 'completed',
                       next_action_at = null,
                       updated_at = now()
                 where id = v_lead.id;
              end if;

              if v_has_event_run then
                update public.journey_runs
                   set status = 'completed',
                       completed_at = coalesce(completed_at, now()),
                       last_error = null
                 where id = v_run.id
                   and status not in ('completed', 'failed', 'cancelled');
              end if;

              return null;
            elsif v_on_passed = 'goto' and v_on_passed_step is not null then
              select s into v_next_step
                from jsonb_array_elements(v_steps) s
               where (s ->> 'index')::integer = v_on_passed_step
               limit 1;

              if v_next_step is null then
                if v_mirror then
                  update public.leads
                     set journey_status = 'completed',
                         next_action_at = null,
                         updated_at = now()
                   where id = v_lead.id;
                end if;

                if v_has_event_run then
                  update public.journey_runs
                     set status = 'completed',
                         completed_at = coalesce(completed_at, now()),
                         last_error = null
                   where id = v_run.id
                     and status not in ('completed', 'failed', 'cancelled');
                end if;

                return null;
              end if;

              v_next_index := v_on_passed_step;
              v_next_type := v_next_step ->> 'type';
              v_run_at := now();
            elsif v_on_passed = 'skip_outbound' then
              update public.leads
                 set custom_fields = coalesce(custom_fields, '{}'::jsonb)
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
        (v_next_step -> 'delay' ->> 'amount')::numeric,
        case when v_next_type = 'wait_reply' then 12 else 0 end
      );
      v_delay_unit := coalesce(
        v_next_step -> 'duration' ->> 'unit',
        v_next_step -> 'delay' ->> 'unit',
        case when v_next_type = 'wait_reply' then 'hours' else 'minutes' end
      );
      v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
    end if;

    if v_aw is not null and coalesce((v_aw ->> 'enabled')::boolean, false) then
      v_run_at := public.clamp_to_advance_window(v_run_at, v_aw, v_clamp_tz);
    end if;
  else
    v_delay_amount := coalesce((v_next_step -> 'delay' ->> 'amount')::numeric, 0);
    v_delay_unit := coalesce(v_next_step -> 'delay' ->> 'unit', 'minutes');
    v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
  end if;

  insert into public.actions (
    tenant_id,
    lead_id,
    action_type,
    step_index,
    template_key,
    run_at,
    status,
    idempotency_key,
    payload,
    run_id
  ) values (
    v_lead.tenant_id,
    v_lead.id,
    v_next_step ->> 'type',
    v_next_index,
    v_next_step ->> 'template_key',
    v_run_at,
    'pending',
    v_lead.id::text || ':' || v_journey.journey_key || ':' || v_next_index::text || ':' || p_action_id::text,
    jsonb_build_object(
      'enrolled_via', v_journey.journey_key,
      'step_spec', v_next_step,
      'continued_from_run_id', v_action.run_id
    ),
    v_action.run_id
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_new_action_id;

  if v_mirror then
    update public.leads
       set current_step = v_next_index,
           next_action_at = v_run_at,
           updated_at = now()
     where id = v_lead.id;
  end if;

  if v_has_event_run then
    update public.journey_runs
       set current_step = v_next_index,      -- PHASE1
           next_action_at = v_run_at,        -- PHASE1
           last_error = null
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');
  end if;

  return v_new_action_id;
end;
$$;

revoke execute on function public.advance_journey(uuid, text)
  from public, anon, authenticated;
grant execute on function public.advance_journey(uuid, text)
  to service_role;
