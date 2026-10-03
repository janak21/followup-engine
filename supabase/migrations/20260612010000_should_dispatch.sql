-- Migration: should_dispatch RPC
-- Created at: 2026-06-12T09:50:40+05:30

create or replace function should_dispatch(p_action_id uuid)
returns table(can_dispatch boolean, reason text, reschedule_to timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_action actions;
  v_lead leads;
  v_tenant tenants;
  v_bh jsonb;
  v_now_tz timestamptz;
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

  -- Lead-level stops
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

  -- Suppression check
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

  -- Tenant pause
  if v_tenant.status <> 'active' then
    return query select false, 'tenant_inactive', null::timestamptz;
    return;
  end if;

  -- Business hours (only for call and sms; email may bypass per journey spec)
  if v_action.action_type in ('call', 'sms') then
    v_bh := v_tenant.business_hours;
    v_business_days := v_bh -> 'days';
    v_start := (v_bh ->> 'start')::time;
    v_end := (v_bh ->> 'end')::time;
    v_now_tz := timezone(v_tenant.timezone, now());
    v_local_time := v_now_tz::time;
    v_local_dow := to_char(v_now_tz, 'Dy'); -- 'Mon','Tue',...

    if not (v_business_days @> to_jsonb(v_local_dow)) or v_local_time < v_start or v_local_time > v_end then
      -- Compute next business-window start (next 15 min granularity to keep simple)
      return query select false, 'outside_business_hours',
        (timezone(v_tenant.timezone, now()) + interval '15 minutes')::timestamptz;
      return;
    end if;
  end if;

  return query select true, null::text, null::timestamptz;
end;
$$;
