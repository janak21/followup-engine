-- Phase 7: the engine prunes its own growth. Nightly at 03:15 UTC.
-- Conversation history (provider events) is NEVER pruned.

create or replace function public.prune_engine_history()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_errors integer; v_system_events integer; v_actions integer;
begin
  with d as (
    delete from public.error_logs
     where created_at < now() - interval '90 days'
     returning 1
  )
  select count(*) into v_errors from d;

  with d as (
    delete from public.events
     where channel = 'system'
       and created_at < now() - interval '90 days'
     returning 1
  )
  select count(*) into v_system_events from d;

  with d as (
    delete from public.actions
     where status in ('completed', 'cancelled')
       and coalesce(completed_at, created_at) < now() - interval '180 days'
     returning 1
  )
  select count(*) into v_actions from d;

  return jsonb_build_object('errors', v_errors, 'system_events', v_system_events, 'actions', v_actions);
end;
$$;

revoke execute on function public.prune_engine_history() from public, anon, authenticated;
grant execute on function public.prune_engine_history() to service_role;

do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'prune-engine-history') then
    perform cron.schedule('prune-engine-history', '15 3 * * *',
      'select public.prune_engine_history();');
  end if;
end
$do$;

-- The 30-day window from decision 003 is moot at launch: drop the archive.
drop table if exists public.workflow_actions_archived;
