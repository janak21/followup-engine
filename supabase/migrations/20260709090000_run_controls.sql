-- Phase 6: per-run pause/resume/cancel + journey-level pause.
-- Pause parks the run's pending actions (run_at += 100 years, original kept
-- in result.paused_from_run_at) AND sets status='paused'; the dispatch guard
-- (20260709091000) is the safety net. Resume restores run_at exactly;
-- past-due restores snap to now().

alter table public.journeys
  add column if not exists paused boolean not null default false;

create or replace function public.pause_journey_run(
  p_run_id uuid,
  p_tenant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_parked integer;
begin
  select * into v_run from public.journey_runs
   where id = p_run_id and tenant_id = p_tenant_id
   for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('status', 'not_running', 'run_status', v_run.status);
  end if;

  update public.journey_runs set status = 'paused' where id = p_run_id;

  with parked as (
    update public.actions
       set result = coalesce(result, '{}'::jsonb)
                    || jsonb_build_object('paused_from_run_at', run_at),
           run_at = run_at + interval '100 years',
           locked_until = null,
           locked_by = null
     where run_id = p_run_id
       and status = 'pending'
     returning id
  )
  select count(*)::integer into v_parked from parked;

  return jsonb_build_object('status', 'paused', 'parked_actions', v_parked);
end;
$$;

create or replace function public.resume_journey_run(
  p_run_id uuid,
  p_tenant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_restored integer;
begin
  select * into v_run from public.journey_runs
   where id = p_run_id and tenant_id = p_tenant_id
   for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_run.status <> 'paused' then
    return jsonb_build_object('status', 'not_paused', 'run_status', v_run.status);
  end if;

  update public.journey_runs set status = 'running' where id = p_run_id;

  with restored as (
    update public.actions
       set run_at = greatest(now(), (result ->> 'paused_from_run_at')::timestamptz),
           result = result - 'paused_from_run_at'
     where run_id = p_run_id
       and status = 'pending'
       and result ? 'paused_from_run_at'
     returning id
  )
  select count(*)::integer into v_restored from restored;

  return jsonb_build_object('status', 'running', 'restored_actions', v_restored);
end;
$$;

create or replace function public.cancel_journey_run(
  p_run_id uuid,
  p_tenant_id uuid,
  p_reason text default 'cancelled_by_operator'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_cancelled integer;
begin
  select * into v_run from public.journey_runs
   where id = p_run_id and tenant_id = p_tenant_id
   for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_run.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'already_terminal', 'run_status', v_run.status);
  end if;

  update public.journey_runs
     set status = 'cancelled',
         completed_at = coalesce(completed_at, now()),
         last_error = p_reason
   where id = p_run_id;

  with cancelled as (
    update public.actions
       set status = 'cancelled',
           error_message = p_reason,
           locked_until = null,
           locked_by = null
     where run_id = p_run_id
       and status in ('pending', 'in_progress')
     returning id
  )
  select count(*)::integer into v_cancelled from cancelled;

  return jsonb_build_object('status', 'cancelled', 'cancelled_actions', v_cancelled);
end;
$$;

-- Phase 6: enroll_lead_in_journey gains a journey-paused block. Full
-- replacement (base = Task 0 reconciled body, Phase 3 once_ever block in).
create or replace function public.enroll_lead_in_journey(
  p_tenant_id uuid,
  p_lead_id uuid,
  p_journey_key text,
  p_source text default 'manual',
  p_raw_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lead public.leads%rowtype;
  v_journey public.journeys%rowtype;
  v_step0 jsonb;
  v_run_id uuid;
  v_existing_run_id uuid;
  v_action_id uuid;
begin
  select * into v_lead
    from public.leads
   where id = p_lead_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'lead_not_found');
  end if;

  if v_lead.opt_out then
    return jsonb_build_object('status', 'lead_opted_out');
  end if;

  select * into v_journey
    from public.journeys
   where tenant_id = p_tenant_id
     and journey_key = p_journey_key
     and active
   order by version desc
   limit 1;
  if not found then
    return jsonb_build_object('status', 'journey_not_found');
  end if;

  if coalesce(v_journey.paused, false) then
    return jsonb_build_object('status', 'journey_paused');
  end if;

  select s into v_step0
    from jsonb_array_elements(coalesce(v_journey.spec -> 'steps', '[]'::jsonb)) s
   where (s ->> 'index')::integer = 0
   limit 1;
  if v_step0 is null then
    return jsonb_build_object('status', 'no_first_step');
  end if;

  -- PHASE3: per-journey re-enrollment policy.
  if coalesce(v_journey.spec ->> 'reenrollment', 'allow') = 'once_ever' then
    if exists (
      select 1 from public.journey_runs
       where tenant_id = p_tenant_id
         and lead_id = p_lead_id
         and journey_id = v_journey.id
    ) then
      return jsonb_build_object('status', 'blocked_once_ever');
    end if;
  end if;

  insert into public.journey_runs (
    tenant_id, journey_id, journey_key, journey_version,
    mode, trigger_type, status, lead_id,
    current_step, next_action_at, raw_payload
  ) values (
    p_tenant_id, v_journey.id, v_journey.journey_key, v_journey.version,
    'lead_journey', coalesce(nullif(trim(p_source), ''), 'manual'), 'running', p_lead_id,
    0, now(), coalesce(p_raw_payload, '{}'::jsonb)
  )
  on conflict (tenant_id, lead_id, journey_id) where status = 'running'
  do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select id into v_existing_run_id
      from public.journey_runs
     where tenant_id = p_tenant_id
       and lead_id = p_lead_id
       and journey_id = v_journey.id
       and status = 'running'
     limit 1;
    return jsonb_build_object(
      'status', 'already_active',
      'run_id', v_existing_run_id
    );
  end if;

  insert into public.actions (
    tenant_id, lead_id, run_id, action_type, step_index, template_key,
    run_at, status, idempotency_key, payload
  ) values (
    p_tenant_id, p_lead_id, v_run_id, v_step0 ->> 'type', 0, v_step0 ->> 'template_key',
    now(), 'pending',
    'run:' || v_run_id::text || ':0',
    jsonb_build_object(
      'enrolled_via', v_journey.journey_key,
      'enrolled_by', coalesce(nullif(trim(p_source), ''), 'manual'),
      'step_spec', v_step0
    )
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_action_id;

  update public.leads
     set journey_template = v_journey.journey_key,
         journey_status = 'active',
         current_step = 0,
         next_action_at = now(),
         updated_at = now()
   where id = p_lead_id;

  return jsonb_build_object(
    'status', 'enrolled',
    'run_id', v_run_id,
    'action_id', v_action_id,
    'journey_key', v_journey.journey_key
  );
end;
$$;

do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('pause_journey_run', 'resume_journey_run', 'cancel_journey_run', 'enroll_lead_in_journey')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;