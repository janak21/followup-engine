-- Phase 1: dispatch guards know about runs.
-- 1) should_dispatch blocks actions whose journey_run is no longer running.
-- 2) dispatch_guard_external_action cancels (not retries) those actions.
-- 3) cancel_pending_on_engagement marks affected runs responded instead of
--    leaving them running forever.

create or replace function public.should_dispatch(p_action_id uuid)
returns table(can_dispatch boolean, reason text, reschedule_to timestamp with time zone)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action actions;
  v_lead leads;
  v_tenant tenants;
  v_run_status text;
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

  -- PHASE1: an action belonging to a non-running run never dispatches.
  if v_action.run_id is not null then
    select status into v_run_status from journey_runs where id = v_action.run_id;
    if v_run_status is not null and v_run_status <> 'running' then
      return query select false, 'run_not_active', null::timestamptz;
      return;
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

create or replace function public.dispatch_guard_external_action(
  p_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard record;
  v_reason text;
  v_reschedule_to timestamptz;
  v_permanent_reasons text[] := array[
    'lead_opt_out',
    'lead_responded',
    'callback_requested',
    'skip_outbound_until_wait',
    'suppressed',
    'tenant_inactive',
    'run_not_active'  -- PHASE1
  ];
begin
  select can_dispatch, reason, reschedule_to
    into v_guard
    from public.should_dispatch(p_action_id)
   limit 1;

  if not found or coalesce(v_guard.can_dispatch, false) then
    return jsonb_build_object('can_dispatch', true);
  end if;

  v_reason := coalesce(v_guard.reason, 'should_dispatch_blocked');
  v_reschedule_to := v_guard.reschedule_to;

  if v_reschedule_to is not null then
    update public.actions
       set status = 'pending',
           run_at = v_reschedule_to,
           next_retry_at = null,
           locked_until = null,
           locked_by = null,
           last_skip_reason = v_reason,
           reschedule_count = coalesce(reschedule_count, 0) + 1,
           error_message = left(v_reason, 2000),
           last_error = left(v_reason, 2000)
     where id = p_action_id;

    insert into public.error_logs (
      tenant_id, workflow_name, error_message, raw_error, severity, status
    )
    select tenant_id, 'dispatch_pending_actions:guard_rescheduled',
           'Dispatch deferred by should_dispatch: ' || v_reason,
           jsonb_build_object(
             'action_id', p_action_id,
             'reason', v_reason,
             'reschedule_to', v_reschedule_to
           ),
           'info', 'open'
      from public.actions
     where id = p_action_id;

    return jsonb_build_object(
      'can_dispatch', false,
      'status', 'rescheduled',
      'reason', v_reason,
      'reschedule_to', v_reschedule_to
    );
  end if;

  update public.actions
     set status = case when v_reason = any(v_permanent_reasons)
                       then 'cancelled'
                       else 'pending'
                  end,
         run_at = case when v_reason = any(v_permanent_reasons)
                       then run_at
                       else now() + interval '15 minutes'
                  end,
         locked_until = null,
         locked_by = null,
         last_skip_reason = v_reason,
         reschedule_count = case when v_reason = any(v_permanent_reasons)
                                 then reschedule_count
                                 else coalesce(reschedule_count, 0) + 1
                            end,
         error_message = left(v_reason, 2000),
         last_error = left(v_reason, 2000)
   where id = p_action_id;

  insert into public.error_logs (
    tenant_id, workflow_name, error_message, raw_error, severity, status
  )
  select tenant_id,
         case when v_reason = any(v_permanent_reasons)
              then 'dispatch_pending_actions:guard_cancelled'
              else 'dispatch_pending_actions:guard_deferred'
         end,
         'Dispatch blocked by should_dispatch: ' || v_reason,
         jsonb_build_object('action_id', p_action_id, 'reason', v_reason),
         'info', 'open'
    from public.actions
   where id = p_action_id;

  return jsonb_build_object(
    'can_dispatch', false,
    'status', case when v_reason = any(v_permanent_reasons) then 'cancelled' else 'deferred' end,
    'reason', v_reason
  );
end;
$$;

create or replace function public.cancel_pending_on_engagement(
  p_lead_id uuid,
  p_engagement text,
  p_reason text default null::text,
  p_source_action_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lead leads;
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

do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('should_dispatch', 'dispatch_guard_external_action', 'cancel_pending_on_engagement')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
