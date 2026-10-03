-- Migration: advance_journey RPC
-- Created at: 2026-06-12T09:50:40+05:30

create or replace function advance_journey(
  p_action_id uuid,
  p_outcome text
) returns uuid
language plpgsql security definer set search_path = public as $$
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
    update leads set journey_status = 'completed' where id = v_lead.id;
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
        updated_at = now()
    where id = v_lead.id;

  return v_new_action_id;
end;
$$;
