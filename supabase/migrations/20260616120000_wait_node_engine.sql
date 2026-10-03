-- Migration: Wait node engine (GHL parity)
-- Adds clamp_to_advance_window, process_wait_action, and extends advance_journey
-- so wait nodes become a first-class step type with:
--   - duration mode (seconds | minutes | hours | days)
--   - until mode (absolute datetime with on_passed branching)
--   - advance_window (day-of-week × hour window + optional date filter)
--
-- Storage stays the same: actions rows with status='pending' and a future run_at.
-- The dispatcher polls; rows in the future are simply not returned. No queue.
--
-- Created at: 2026-06-16T12:00:00Z

------------------------------------------------------------
-- 1) clamp_to_advance_window
--   Given a candidate UTC timestamp + a window spec + a tenant timezone,
--   return the next UTC timestamp >= candidate that lies inside the window.
--
-- Window spec shape (jsonb):
-- {
--   "enabled": true,
--   "days":    ["Mon","Tue","Wed","Thu","Fri"],   -- to_char Dy keys
--   "window":  { "start": "09:00", "end": "17:00" },
--   "additional_filter": {
--     "type":  "current_day_of_month" | "current_month" | "current_year",
--     "op":    "is" | "is_not",
--     "value": text  -- e.g. "15", "July", "2026"
--   }
-- }
------------------------------------------------------------
create or replace function clamp_to_advance_window(
  p_run_at    timestamptz,
  p_window    jsonb,
  p_timezone  text
) returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_enabled   bool := coalesce((p_window->>'enabled')::bool, false);
  v_days      jsonb;
  v_start     time;
  v_end       time;
  v_filter    jsonb;
  v_local     timestamp;
  v_date      date;
  v_time      time;
  v_dow       text;
  v_iters     int := 0;
  v_filter_ok bool;
  v_op        text;
  v_value     text;
  v_ftype     text;
begin
  if not v_enabled or p_window is null then
    return p_run_at;
  end if;

  v_days  := coalesce(p_window->'days', '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]'::jsonb);
  v_start := nullif(p_window->'window'->>'start', '')::time;
  v_end   := nullif(p_window->'window'->>'end',   '')::time;
  if v_start is null then v_start := time '00:00'; end if;
  if v_end   is null then v_end   := time '23:59'; end if;
  v_filter := p_window->'additional_filter';
  v_ftype  := v_filter->>'type';
  v_op     := coalesce(v_filter->>'op', 'is');
  v_value  := v_filter->>'value';

  -- Convert candidate to local tenant time.
  v_local := (p_run_at at time zone p_timezone);
  v_date  := v_local::date;
  v_time  := v_local::time;

  loop
    v_dow := to_char(v_date, 'Dy'); -- "Mon", "Tue", ...

    -- Day-of-week mask
    if v_days @> to_jsonb(v_dow) then

      -- Additional filter check (single-slot for now; multi-slot can be added later)
      v_filter_ok := true;
      if v_ftype is not null and v_value is not null and v_value <> '' then
        if v_ftype = 'current_day_of_month' then
          v_filter_ok := (extract(day from v_date)::int = v_value::int);
        elsif v_ftype = 'current_month' then
          v_filter_ok := (lower(to_char(v_date, 'FMMonth')) = lower(v_value));
        elsif v_ftype = 'current_year' then
          v_filter_ok := (extract(year from v_date)::int = v_value::int);
        end if;
        if v_op = 'is_not' then
          v_filter_ok := not v_filter_ok;
        end if;
      end if;

      if v_filter_ok then
        -- Decide where in the day to land.
        if v_date > v_local::date then
          -- A later date — land at start-of-window.
          return ((v_date::text || ' ' || v_start::text)::timestamp) at time zone p_timezone;
        elsif v_time < v_start then
          -- Same day but too early — advance to window start.
          return ((v_date::text || ' ' || v_start::text)::timestamp) at time zone p_timezone;
        elsif v_time <= v_end then
          -- Inside window — keep candidate as-is.
          return p_run_at;
        end if;
        -- Too late today; fall through and advance to next day.
      end if;
    end if;

    -- Advance to next day at the window start.
    v_date := v_date + 1;
    v_time := v_start; -- reset time so subsequent iterations land at start
    v_iters := v_iters + 1;
    if v_iters > 366 then
      -- Pathological config (no day ever matches). Bail out at 24h from candidate
      -- so the lead doesn't sit forever — surfaced to ops via the dispatcher.
      return p_run_at + interval '24 hours';
    end if;
  end loop;
end;
$$;

------------------------------------------------------------
-- 2) advance_journey
--   Rewritten to treat wait as a first-class compiled step:
--     - For action steps the previous behavior is preserved.
--     - For wait steps we compute run_at from duration | until,
--       apply on_passed branching when "until" is in the past,
--       clamp to advance_window if enabled, and insert an action
--       with action_type='wait' that the dispatcher will auto-advance.
------------------------------------------------------------
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

  -- wait-step locals
  v_wait_mode    text;
  v_until_iso    text;
  v_on_passed    text;
  v_on_passed_step int;
  v_aw           jsonb;
begin
  select * into v_action from actions where id = p_action_id;
  select * into v_lead   from leads   where id = v_action.lead_id;
  select * into v_tenant from tenants where id = v_action.tenant_id;

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

  -- Find current step
  select s into v_current_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::int = v_action.step_index;

  -- Branch by outcome
  v_exit := v_current_step -> 'on_outcome' -> p_outcome ->> 'exit';
  if v_exit is not null then
    update leads
      set journey_status = v_exit,
          updated_at = now()
      where id = v_lead.id;
    return null;
  end if;

  v_next_index := (v_current_step -> 'on_outcome' -> p_outcome ->> 'next_step')::int;
  if v_next_index is null then
    update leads set journey_status = 'completed' where id = v_lead.id;
    return null;
  end if;

  select s into v_next_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::int = v_next_index;

  if v_next_step is null then
    update leads set journey_status = 'completed' where id = v_lead.id;
    return null;
  end if;

  -- ----------------------------------------------------------
  -- Compute v_run_at for the NEXT step.
  -- ----------------------------------------------------------
  if (v_next_step ->> 'type') = 'wait' then
    -- Wait nodes carry their own scheduling config.
    v_wait_mode := coalesce(v_next_step ->> 'mode', 'duration');
    v_aw        := v_next_step -> 'advance_window';

    if v_wait_mode = 'until' then
      v_until_iso := v_next_step -> 'until' ->> 'datetime';
      v_on_passed := coalesce(v_next_step ->> 'on_passed', 'continue');
      v_on_passed_step := nullif(v_next_step ->> 'on_passed_step', '')::int;

      if v_until_iso is null then
        -- Misconfigured wait — treat as immediate continue.
        v_run_at := now();
      else
        v_run_at := v_until_iso::timestamptz;
        if v_run_at <= now() then
          -- Already passed.
          if v_on_passed = 'exit' then
            update leads set journey_status = 'completed', updated_at = now()
              where id = v_lead.id;
            return null;
          elsif v_on_passed = 'goto' and v_on_passed_step is not null then
            -- Redirect to a different step. Re-select v_next_step at goto index.
            select s into v_next_step
              from jsonb_array_elements(v_steps) s
             where (s ->> 'index')::int = v_on_passed_step;
            if v_next_step is null then
              update leads set journey_status = 'completed' where id = v_lead.id;
              return null;
            end if;
            v_next_index := v_on_passed_step;
            v_run_at := now();
          elsif v_on_passed = 'skip_outbound' then
            -- Mark a flag so dispatcher skips outbound-channel actions until
            -- the next wait. Stored on the lead for downstream reads.
            update leads set custom_fields = coalesce(custom_fields, '{}'::jsonb)
                                            || jsonb_build_object('_skip_outbound_until_wait', true)
              where id = v_lead.id;
            v_run_at := now();
          else
            -- continue
            v_run_at := now();
          end if;
        end if;
      end if;
    else
      -- duration mode
      v_delay_amount := coalesce((v_next_step -> 'duration' ->> 'amount')::numeric,
                                 (v_next_step -> 'delay'    ->> 'amount')::numeric, 0);
      v_delay_unit   := coalesce( v_next_step -> 'duration' ->> 'unit',
                                  v_next_step -> 'delay'    ->> 'unit', 'minutes');
      v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
    end if;

    -- Apply advance_window clamp if enabled.
    if v_aw is not null and coalesce((v_aw ->> 'enabled')::bool, false) then
      v_run_at := clamp_to_advance_window(v_run_at, v_aw, v_tenant.timezone);
    end if;

  else
    -- Non-wait step: legacy collapsed-delay behavior.
    v_delay_amount := coalesce((v_next_step -> 'delay' ->> 'amount')::numeric, 0);
    v_delay_unit   := coalesce( v_next_step -> 'delay' ->> 'unit', 'minutes');
    v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
  end if;

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
    v_lead.id::text || ':' || v_journey.journey_key || ':' || v_next_index::text || ':1',
    jsonb_build_object('enrolled_via', v_journey.journey_key, 'step_spec', v_next_step)
  ) returning id into v_new_action_id;

  update leads
    set current_step = v_next_index,
        next_action_at = v_run_at,
        updated_at = now()
    where id = v_lead.id;

  return v_new_action_id;
end;
$$;

------------------------------------------------------------
-- 3) process_wait_action
--   Called by the dispatcher (or via SQL fast-path) when a wait action
--   falls due. Marks the wait completed and advances the journey to
--   the next step. Dispatcher does no I/O.
------------------------------------------------------------
create or replace function process_wait_action(p_action_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_next_id uuid;
begin
  -- Idempotent: only act on pending wait actions.
  update actions
     set status = 'completed',
         completed_at = now(),
         updated_at   = now()
   where id = p_action_id
     and action_type = 'wait'
     and status = 'pending';

  if not found then
    return null;
  end if;

  v_next_id := advance_journey(p_action_id, 'default');
  return v_next_id;
end;
$$;

------------------------------------------------------------
-- 4) should_dispatch
--   Patch to short-circuit wait actions: they bypass business hours
--   (the wait IS the schedule) and have no suppression/responded gates.
--   We patch via a small wrapper at the top.
------------------------------------------------------------
create or replace function should_dispatch(p_action_id uuid)
returns table(can_dispatch boolean, reason text, reschedule_to timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_tenant tenants;
  v_bh jsonb;
  v_now_local timestamp;
  v_local_time time;
  v_local_dow text;
  v_business_days jsonb;
  v_start time;
  v_end time;
  v_suppressed int;
begin
  select * into v_action from actions where id = p_action_id;
  select * into v_lead from leads where id = v_action.lead_id;
  select * into v_tenant from tenants where id = v_action.tenant_id;

  -- Wait actions are scheduling primitives — let them through unconditionally
  -- so the dispatcher can call process_wait_action.
  if v_action.action_type = 'wait' then
    return query select true, null::text, null::timestamptz;
    return;
  end if;

  if v_lead.opt_out then
    return query select false, 'lead_opt_out', null::timestamptz;
    return;
  end if;
  if v_lead.responded and v_action.action_type <> 'team_alert' then
    return query select false, 'lead_responded', null::timestamptz;
    return;
  end if;
  if v_lead.callback_requested and v_action.action_type <> 'team_alert' then
    return query select false, 'callback_requested', null::timestamptz;
    return;
  end if;

  -- Skip-outbound flag set by an "until" wait whose date passed.
  if coalesce((v_lead.custom_fields ->> '_skip_outbound_until_wait')::bool, false)
     and v_action.action_type in ('email','sms','call') then
    -- Mark this single action skipped; flag is cleared by the next wait dispatch.
    return query select false, 'skip_outbound_until_wait', null::timestamptz;
    return;
  end if;

  select count(*) into v_suppressed
    from suppressions
   where tenant_id = v_action.tenant_id
     and (channel is null or channel = v_action.action_type)
     and (
       (v_action.action_type = 'email' and email = v_lead.email)
       or (v_action.action_type in ('sms','call') and phone_e164 = v_lead.phone_e164)
     );
  if v_suppressed > 0 then
    return query select false, 'suppressed', null::timestamptz;
    return;
  end if;

  if v_tenant.status <> 'active' then
    return query select false, 'tenant_inactive', null::timestamptz;
    return;
  end if;

  if v_action.action_type in ('call', 'sms') then
    v_bh := v_tenant.business_hours;
    v_business_days := v_bh -> 'days';
    v_start := (v_bh ->> 'start')::time;
    v_end := (v_bh ->> 'end')::time;
    v_now_local := (now() at time zone v_tenant.timezone);
    v_local_time := v_now_local::time;
    v_local_dow := to_char(v_now_local, 'Dy');

    if not (v_business_days @> to_jsonb(v_local_dow))
       or v_local_time < v_start
       or v_local_time > v_end then
      return query select false, 'outside_business_hours',
        next_business_window(v_tenant.timezone, v_tenant.business_hours);
      return;
    end if;
  end if;

  return query select true, null::text, null::timestamptz;
end;
$$;

------------------------------------------------------------
-- 5) Clear the skip-outbound flag when a NEW wait action runs,
--    so the flag's effect ends at "the next wait" as the UI promises.
--    Implemented inside process_wait_action above as a side-effect:
------------------------------------------------------------
create or replace function process_wait_action(p_action_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_lead_id uuid;
  v_next_id uuid;
begin
  select lead_id into v_lead_id from actions where id = p_action_id;

  update actions
     set status = 'completed',
         completed_at = now(),
         updated_at   = now()
   where id = p_action_id
     and action_type = 'wait'
     and status = 'pending';

  if not found then
    return null;
  end if;

  -- Reset skip-outbound flag — we just hit the next wait.
  update leads
     set custom_fields = (custom_fields - '_skip_outbound_until_wait')
   where id = v_lead_id
     and (custom_fields ? '_skip_outbound_until_wait');

  v_next_id := advance_journey(p_action_id, 'default');
  return v_next_id;
end;
$$;
