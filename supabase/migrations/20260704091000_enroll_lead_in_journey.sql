-- Single enrollment entry point for lead journeys. Used by: manual lead
-- create, bulk enroll, process_journey_webhook (and anything future).
-- Creates a journey_run + the step-0 action (run-scoped idempotency),
-- mirrors legacy lead columns, and enforces one running run per journey
-- via the partial unique index from 20260704090000.

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

  select s into v_step0
    from jsonb_array_elements(coalesce(v_journey.spec -> 'steps', '[]'::jsonb)) s
   where (s ->> 'index')::integer = 0
   limit 1;
  if v_step0 is null then
    return jsonb_build_object('status', 'no_first_step');
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

  -- Legacy mirror: keep the lead columns pointing at this (most recent)
  -- enrollment so the existing dashboard keeps working during Phase 1.
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

revoke execute on function public.enroll_lead_in_journey(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.enroll_lead_in_journey(uuid, uuid, text, text, jsonb)
  to service_role;
