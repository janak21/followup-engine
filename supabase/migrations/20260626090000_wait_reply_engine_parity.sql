-- Migration: wait_reply engine parity + advancement idempotency
--
-- Background
-- ----------
-- wait_reply was wired into the palette and inbound handlers but its scheduling
-- was treated like any other non-wait step: a single `delay: {amount, unit}`
-- field read by the collapsed-delay branch of advance_journey. That branch:
--   1. Offered no feature parity with wait (no `mode: until`, no `advance_window`).
--   2. Defaulted to 0 when `delay` was missing/zero, collapsing wait_reply into
--      an instant timeout on the next dispatch tick — the lead had no real
--      window to reply.
--
-- Additionally, advance_journey had no guard against being called twice on the
-- same action. The inbound-replied path and the dispatcher-timeout path can
-- race (replied marks the action completed THEN advances; timeout advances
-- THEN marks completed). Without a guard the two outcomes can both fire,
-- producing an inconsistent lead state (journey_status set by one outcome
-- while a next-action for the other outcome is inserted).
--
-- Changes
-- -------
-- 1. advance_journey now routes wait_reply through the same scheduling branch
--    as wait (duration + until + advance_window). wait_reply does not use
--    on_passed branching — if an `until` datetime already passed, the
--    wait_reply times out immediately (run_at = now()). When no delay is
--    configured, wait_reply defaults to 12 hours (wait keeps its 0 default).
-- 2. advance_journey now atomically claims the advancement by stamping
--    `advanced_at` + `advanced_outcome` on actions.result. The first caller
--    wins; concurrent callers (the replied/timeout race, or duplicate
--    record_send_event→advance retries) no-op. This is safe for the legacy
--    n8n path (record_send_event sets result first, then advance adds the
--    claim) and for wait_reply (whose source action has an empty result).
--
-- All previously-deployed improvements (FOR UPDATE locks, lead-timezone clamp,
-- idempotency key including p_action_id, on-conflict-do-nothing) are preserved.

create or replace function advance_journey(
  p_action_id uuid,
  p_outcome   text
) returns uuid
language plpgsql security definer set search_path = public as $$
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
    -- Either the action does not exist or it was already advanced.
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

  -- ----------------------------------------------------------
  -- Compute run_at for the NEXT step.
  -- wait_reply shares the scheduling engine with wait (duration, until,
  -- advance_window) but has its own outcomes (replied/timeout) and does not
  -- use on_passed branching — if an `until` datetime already passed, the
  -- wait_reply times out immediately (run_at = now()).
  -- ----------------------------------------------------------
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
            -- wait_reply with a passed `until` datetime: time out immediately.
            v_run_at := now();
          end if;
        end if;
      end if;
    else
      -- duration mode (shared by wait and wait_reply).
      -- Fallback chain: duration -> delay -> type-specific default
      -- (wait_reply defaults to 12 hours so a misconfigured/empty wait_reply
      --  still gives the lead a real window to reply; wait keeps 0 = run now).
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
    -- Non-wait step: legacy collapsed-delay behavior.
    v_delay_amount := coalesce((v_next_step -> 'delay' ->> 'amount')::numeric, 0);
    v_delay_unit   := coalesce( v_next_step -> 'delay' ->> 'unit', 'minutes');
    v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
  end if;

  -- Idempotency key includes the parent action id so re-enrollments (same
  -- lead + journey + step, different enrollment instance) queue fresh actions
  -- instead of being silently swallowed by on-conflict-do-nothing.
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
$$;

-- ----------------------------------------------------------
-- Data fix: existing wait_reply steps with delay.amount = 0 (or missing
-- delay) collapse to an instant timeout. Bump them to a 12-hour window so
-- current journeys give leads a real opportunity to reply. Only touches
-- wait_reply steps; leaves all other step types untouched.
-- ----------------------------------------------------------
update journeys j
   set spec = jsonb_set(
        j.spec,
        '{steps}',
        (
          select jsonb_agg(
                   case
                     when (s ->> 'type') = 'wait_reply'
                          and coalesce((s -> 'delay' ->> 'amount')::int, 0) = 0
                     then s || jsonb_build_object(
                            'delay', jsonb_build_object('amount', 12, 'unit', 'hours')
                          )
                     else s
                   end
                 )
            from jsonb_array_elements(j.spec -> 'steps') s
        )
      )
 where exists (
         select 1
           from jsonb_array_elements(j.spec -> 'steps') s
          where s ->> 'type' = 'wait_reply'
            and coalesce((s -> 'delay' ->> 'amount')::int, 0) = 0
       );