-- Migration: Auto-transition journey_status from 'new' to 'active' as soon as the lead
-- starts being processed. Mid-journey leads should never stay 'new'.
-- Created at: 2026-06-14T00:00:00Z

-- 1. record_send_event: if the lead is still 'new' when its first action completes, flip to 'active'
create or replace function record_send_event(
  p_action_id uuid,
  p_provider text,
  p_provider_id text,
  p_outcome text,
  p_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_event_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then raise exception 'action not found: %', p_action_id; end if;
  select * into v_lead from leads where id = v_action.lead_id;

  if v_action.status = 'completed' then
    raise exception 'action % already completed', p_action_id using errcode = 'unique_violation';
  end if;

  insert into events (
    tenant_id, lead_id, action_id, channel, direction,
    provider, provider_id, to_address, subject, body, raw_payload
  ) values (
    v_action.tenant_id, v_action.lead_id, v_action.id,
    v_action.action_type, 'outbound',
    p_provider, p_provider_id,
    case v_action.action_type
      when 'email' then v_lead.email
      when 'sms' then v_lead.phone_e164
      when 'call' then v_lead.phone_e164
      else null end,
    p_payload->>'subject',
    p_payload->>'body',
    p_payload
  ) returning id into v_event_id;

  update actions
    set status = case when p_outcome = 'failed' then 'failed' else 'completed' end,
        provider = p_provider,
        provider_id = p_provider_id,
        result = jsonb_build_object('outcome', p_outcome) || p_payload,
        completed_at = now()
    where id = p_action_id;

  -- Update lead: auto-transition new -> active when first action lands
  update leads
    set last_action_at = now(),
        journey_status = case
          when journey_status = 'new' and p_outcome <> 'failed' then 'active'
          else journey_status
        end
    where id = v_action.lead_id;

  if v_action.action_type = 'email' and p_outcome = 'sent' and v_lead.assigned_sender_id is not null then
    update senders
    set sent_today = sent_today + 1,
        total_sent = total_sent + 1,
        last_sent_at = now()
    where id = v_lead.assigned_sender_id;
  end if;

  return v_event_id;
end;
$$;

-- 2. advance_journey: also flip 'new' -> 'active' on next-step path; keep exit semantics
create or replace function advance_journey(
  p_action_id uuid,
  p_outcome text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_journey journeys;
  v_steps jsonb;
  v_current_step jsonb;
  v_next_step jsonb;
  v_exit text;
  v_next_index int;
  v_delay_amount int;
  v_delay_unit text;
  v_run_at timestamptz;
  v_new_action_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  select * into v_lead from leads where id = v_action.lead_id;

  -- Resolve the journey the lead is enrolled in
  select * into v_journey
    from journeys
   where tenant_id = v_lead.tenant_id
     and journey_key = v_lead.journey_template
     and active
   order by version desc
   limit 1;

  if not found then
    -- Journey misconfigured. Flag the lead and log the error rather than silently completing.
    update leads
      set journey_status = 'error',
          updated_at = now()
      where id = v_lead.id;

    insert into error_logs (
      tenant_id, workflow_name, error_message, raw_error, severity, status
    ) values (
      v_lead.tenant_id,
      'advance_journey',
      'journey_template_not_found: ' || coalesce(v_lead.journey_template, '(null)'),
      jsonb_build_object('lead_id', v_lead.id, 'action_id', v_action.id, 'journey_template', v_lead.journey_template),
      'error',
      'open'
    );
    return null;
  end if;

  v_steps := v_journey.spec -> 'steps';

  -- Find the current step by step_index
  select s into v_current_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::int = v_action.step_index;

  -- Look up outcome routing
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

  v_delay_amount := coalesce((v_next_step -> 'delay' ->> 'amount')::int, 0);
  v_delay_unit := coalesce(v_next_step -> 'delay' ->> 'unit', 'minutes');

  v_run_at := now() + (v_delay_amount || ' ' || v_delay_unit)::interval;

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
        journey_status = case
          when journey_status in ('new', 'paused') then 'active'
          else journey_status
        end,
        updated_at = now()
    where id = v_lead.id;

  return v_new_action_id;
end;
$$;
