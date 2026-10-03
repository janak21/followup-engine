-- Lock-in: actions.updated_at references are gone.
--
-- Root cause: process_wait_action used to contain
--   update actions set status = 'completed', updated_at = now() where id = p_action_id;
-- but public.actions has no updated_at column. Every dispatch_pending_actions:inline:wait
-- tick therefore raised 42703 ("column updated_at of relation actions does not exist")
-- and wait nodes stalled until migration 20260703130000_fix_process_wait_action_updated_at.sql
-- rewrote the function without the offending column.
--
-- This migration verifies that no public function body still references actions.updated_at
-- and re-creates process_wait_action with the corrected body so the fix is explicitly
-- captured in schema history.

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

do $$
declare
  v_bad_refs int;
begin
  select count(*) into v_bad_refs
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc ~* 'update\s+actions[^;]*updated_at|insert\s+into\s+actions[^;]*updated_at|select[^;]*actions[^;]*\.updated_at';

  if v_bad_refs > 0 then
    raise exception 'Regression detected: % public function(s) still reference actions.updated_at', v_bad_refs;
  end if;
end $$;
