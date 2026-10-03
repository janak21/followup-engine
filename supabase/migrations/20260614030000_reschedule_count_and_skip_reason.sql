-- Migration: Add reschedule_count + last_skip_reason on actions, and have should_dispatch
-- persist them as a side effect. This avoids needing to change the n8n W-DISPATCH workflow.
-- Created at: 2026-06-14T03:00:00Z

alter table actions
  add column if not exists reschedule_count int not null default 0,
  add column if not exists last_skip_reason text;

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
  v_reason text;
  v_reschedule timestamptz;
begin
  select * into v_action from actions where id = p_action_id;
  select * into v_lead from leads where id = v_action.lead_id;
  select * into v_tenant from tenants where id = v_action.tenant_id;

  if v_lead.opt_out then
    v_reason := 'lead_opt_out';
  elsif v_lead.responded and v_action.action_type <> 'team_alert' then
    v_reason := 'lead_responded';
  elsif v_lead.callback_requested and v_action.action_type <> 'team_alert' then
    v_reason := 'callback_requested';
  else
    select count(*) into v_suppressed
      from suppressions
     where tenant_id = v_action.tenant_id
       and (channel is null or channel = v_action.action_type)
       and (
         (v_action.action_type = 'email' and email = v_lead.email)
         or (v_action.action_type in ('sms','call') and phone_e164 = v_lead.phone_e164)
       );
    if v_suppressed > 0 then
      v_reason := 'suppressed';
    elsif v_tenant.status <> 'active' then
      v_reason := 'tenant_inactive';
    elsif v_action.action_type in ('call', 'sms') then
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
        v_reason := 'outside_business_hours';
        v_reschedule := next_business_window(v_tenant.timezone, v_tenant.business_hours);
      end if;
    end if;
  end if;

  if v_reason is not null then
    update actions
       set last_skip_reason = v_reason,
           reschedule_count = case when v_reschedule is not null
                                   then coalesce(reschedule_count, 0) + 1
                                   else reschedule_count end
     where id = p_action_id;

    return query select false, v_reason, v_reschedule;
    return;
  end if;

  return query select true, null::text, null::timestamptz;
end;
$$;
