-- A workflow_action reaching failed_permanent previously left its journey_run
-- stuck in status 'running' forever (only advance_workflow_run's own failure
-- paths updated the run). A trigger covers every code path that marks an
-- action failed_permanent: mark_workflow_action_failed, inline handlers, and
-- future ones.
--
-- Applied to follow-up-dev via Supabase MCP on 2026-07-03.

create or replace function public.on_workflow_action_failed_permanent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status = 'failed_permanent'
     and (tg_op = 'INSERT' or coalesce(old.status, '') <> 'failed_permanent')
     and new.run_id is not null then
    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = coalesce(nullif(new.last_error, ''), 'Workflow action failed permanently.')
     where id = new.run_id
       and status not in ('completed', 'failed', 'cancelled');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_workflow_action_failed_permanent on public.workflow_actions;
create trigger trg_workflow_action_failed_permanent
  after insert or update of status on public.workflow_actions
  for each row execute function public.on_workflow_action_failed_permanent();

-- Backfill: fail runs that are stuck 'running' with a permanently failed
-- action and nothing left in flight.
update public.journey_runs jr
   set status = 'failed',
       failed_at = coalesce(jr.failed_at, wa.failed_at, now()),
       last_error = coalesce(jr.last_error, nullif(wa.last_error, ''), 'Workflow action failed permanently.')
  from public.workflow_actions wa
 where wa.run_id = jr.id
   and wa.status = 'failed_permanent'
   and jr.status = 'running'
   and not exists (
     select 1 from public.workflow_actions p
      where p.run_id = jr.id and p.status in ('pending', 'in_progress')
   );
