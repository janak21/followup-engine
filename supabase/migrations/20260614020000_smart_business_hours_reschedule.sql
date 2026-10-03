-- Migration: Smart business-hours rescheduling
-- Fixes two bugs:
--   A. should_dispatch's reschedule_to was using buggy timezone math that produced
--      timestamps in the PAST instead of the FUTURE, causing the dispatcher to
--      pick up the same action every minute.
--   B. Even when math worked, rescheduling +15 minutes outside business hours is
--      wasteful — it would re-evaluate every quarter hour for the entire off-window.
--      We now jump straight to the next valid business-window opening.
-- Created at: 2026-06-14T02:00:00Z

create or replace function next_business_window(
  p_timezone text,
  p_business_hours jsonb
) returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_local_now timestamp := (now() at time zone p_timezone);
  v_local_date date := v_local_now::date;
  v_start_time time := (p_business_hours->>'start')::time;
  v_end_time time := (p_business_hours->>'end')::time;
  v_days jsonb := p_business_hours->'days';
  v_dow text;
  v_candidate_local timestamp;
  v_iters int := 0;
begin
  loop
    v_dow := to_char(v_local_date, 'Dy');

    if v_days @> to_jsonb(v_dow) then
      if v_local_date = v_local_now::date and v_local_now::time < v_start_time then
        v_candidate_local := (v_local_date::text || ' ' || v_start_time::text)::timestamp;
        return v_candidate_local at time zone p_timezone;
      elsif v_local_date > v_local_now::date then
        v_candidate_local := (v_local_date::text || ' ' || v_start_time::text)::timestamp;
        return v_candidate_local at time zone p_timezone;
      end if;
    end if;

    v_local_date := v_local_date + 1;
    v_iters := v_iters + 1;
    if v_iters > 14 then
      return now() + interval '24 hours';
    end if;
  end loop;
end;
$$;

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
