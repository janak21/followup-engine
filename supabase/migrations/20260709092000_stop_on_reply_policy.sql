-- Phase 6: per-journey stop-on-reply policy.
-- spec.stop_on_reply: 'stop' (default, current behavior) | 'continue'
-- Enforced in cancel_pending_on_engagement (continue-runs retain their
-- pending actions) and should_dispatch's lead_responded block (continue-runs
-- keep sending). opt_out/suppression/callback remain absolute.
-- Bases: cancel = Task 0 reconciled body; should_dispatch = Task 2 committed body.

-- (1) cancel_pending_on_engagement — exclude continue-runs from the cancel.
create or replace function public.cancel_pending_on_engagement(
  p_lead_id uuid,
  p_engagement text,
  p_reason text default null,
  p_source_action_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lead leads%rowtype;
  v_msg text;
  v_cancelled_ids uuid[];
  v_cancelled_count int := 0;
begin
  select * into v_lead from leads where id = p_lead_id;
  if not found then
    return jsonb_build_object('status','lead_not_found');
  end if;

  v_msg := 'Cancelled by engagement: ' || p_engagement ||
           case when p_reason is not null then ' — ' || p_reason else '' end;

  with cancelled as (
    update actions
       set status        = 'cancelled',
           error_message = v_msg,
           locked_until  = null,
           locked_by     = null
     where lead_id    = p_lead_id
       and status     = 'pending'
       and action_type not in ('team_alert','wait_reply')
       and (p_source_action_id is null or id <> p_source_action_id)
       -- PHASE6: runs whose journey opts out of stop-on-reply keep their work.
       and not exists (
         select 1
           from journey_runs r
           join journeys j on j.id = r.journey_id
          where r.id = actions.run_id
            and coalesce(j.spec ->> 'stop_on_reply', 'stop') = 'continue'
       )
     returning id
  )
  select array_agg(id), count(*)::int
    from cancelled
    into v_cancelled_ids, v_cancelled_count;

  -- PHASE1: runs whose pending work was cancelled by engagement are
  -- 'responded', not silently stuck 'running'.
  update journey_runs jr
     set status = 'responded',
         responded = true,
         completed_at = coalesce(jr.completed_at, now())
   where jr.status = 'running'
     and jr.id in (
       select distinct a.run_id
         from actions a
        where a.id = any(coalesce(v_cancelled_ids, '{}'::uuid[]))
          and a.run_id is not null
     );

  if v_cancelled_count > 0 then
    insert into events (tenant_id, lead_id, channel, direction, provider, body, raw_payload)
    values (
      v_lead.tenant_id, p_lead_id, 'system', 'internal', 'engine',
      v_msg || ' (' || v_cancelled_count || ' action' ||
        case when v_cancelled_count = 1 then '' else 's' end || ' cancelled)',
      jsonb_build_object(
        'engagement',       p_engagement,
        'reason',           p_reason,
        'source_action_id', p_source_action_id,
        'cancelled_ids',    to_jsonb(v_cancelled_ids),
        'cancelled_count',  v_cancelled_count
      )
    );

    insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (
      v_lead.tenant_id,
      'engagement_cancel',
      v_msg || ' (' || v_cancelled_count || ' cancelled)',
      jsonb_build_object(
        'lead_id',          p_lead_id,
        'engagement',       p_engagement,
        'cancelled_ids',    to_jsonb(v_cancelled_ids),
        'cancelled_count',  v_cancelled_count
      ),
      'info', 'open'
    );
  end if;

  return jsonb_build_object(
    'status',           'success',
    'cancelled_count',  v_cancelled_count,
    'cancelled_ids',    to_jsonb(coalesce(v_cancelled_ids, '{}'::uuid[]))
  );
end;
$$;

-- (2) should_dispatch — lead_responded block becomes policy-aware.
-- Base = 20260709091000_guard_held_runs.sql committed body.
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

  -- PHASE6: held-vs-dead split.
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
    -- PHASE6: journeys with stop_on_reply='continue' keep sending after a
    -- reply. opt_out/suppression/callback checks below remain absolute.
    if not (
      v_action.run_id is not null and exists (
        select 1 from journey_runs r
          join journeys j on j.id = r.journey_id
         where r.id = v_action.run_id
           and coalesce(j.spec ->> 'stop_on_reply', 'stop') = 'continue'
      )
    ) then
      return query select false, 'lead_responded', null::timestamptz;
      return;
    end if;
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

revoke execute on function public.cancel_pending_on_engagement(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_pending_on_engagement(uuid, text, text, uuid)
  to service_role;

revoke execute on function public.should_dispatch(uuid)
  from public, anon, authenticated;
grant execute on function public.should_dispatch(uuid)
  to service_role;