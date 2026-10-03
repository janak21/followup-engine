-- Fix: process_wait_action referenced actions.updated_at, which does not exist.
-- Every dispatcher tick threw 42703 for pending wait actions, so wait nodes
-- never completed and journeys stalled (same bug class as 20260612180000,
-- reintroduced by the wait engine and captured into the 20260626 backfill).

create or replace function public.process_wait_action(p_action_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lead_id uuid;
  v_next_id uuid;
begin
  select lead_id into v_lead_id from actions where id = p_action_id;

  update actions
     set status = 'completed',
         completed_at = now()
   where id = p_action_id
     and action_type = 'wait'
     and status = 'pending';

  if not found then
    return null;
  end if;

  update leads
     set custom_fields = (custom_fields - '_skip_outbound_until_wait')
   where id = v_lead_id
     and (custom_fields ? '_skip_outbound_until_wait');

  v_next_id := advance_journey(p_action_id, 'default');
  return v_next_id;
end;
$$;
