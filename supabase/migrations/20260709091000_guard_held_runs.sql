-- Phase 6: dispatch guard distinguishes held (paused) runs from dead
-- (terminal) runs. A held run defers (reschedule +15min); a terminal run
-- permanently cancels (run_not_active). A paused journey also defers.
-- Base = Task 0 reconciled body (Phase 1 run-aware guard).

create or replace function public.should_dispatch(p_action_id uuid)
returns table(can_dispatch boolean, reason text, reschedule_to timestamp with time zone)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action actions%rowtype;
  v_lead leads%rowtype;
  v_tenant tenants%rowtype;
  v_run_status text;
  v_journey_paused boolean;
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

  -- PHASE6: held-vs-dead split. Paused run/journey defers; terminal run
  -- permanently cancels via the existing run_not_active permanent reason.
  if v_action.run_id is not null then
    select r.status, coalesce(j.paused, false)
      into v_run_status, v_journey_paused
      from journey_runs r
      left join journeys j on j.id = r.journey_id
     where r.id = v_action.run_id;
    if v_run_status is not null then
      if v_run_status = 'paused' then
        return query select false, 'run_paused', now() + interval '15 minutes';
        return;
      elsif v_run_status <> 'running' then
        return query select false, 'run_not_active', null::timestamptz;
        return;
      elsif v_journey_paused then
        return query select false, 'journey_paused', now() + interval '15 minutes';
        return;
      end if;
    end if;
  end if;

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

  if coalesce((v_lead.custom_fields ->> '_skip_outbound_until_wait')::bool, false)
     and v_action.action_type in ('email','sms','call') then
    return query select false, 'skip_outbound_until_wait', null::timestamptz;
    return;
  end if;

  if coalesce((v_tenant.channel_pauses ->> v_action.action_type)::bool, false) then
    return query select false, 'channel_paused', null::timestamptz;
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

revoke execute on function public.should_dispatch(uuid)
  from public, anon, authenticated;
grant execute on function public.should_dispatch(uuid)
  to service_role;