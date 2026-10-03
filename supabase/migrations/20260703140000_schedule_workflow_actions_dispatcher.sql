-- The event-workflow queue (workflow_actions) previously had NO scheduler:
-- dispatch_pending_workflow_actions existed but was only invoked inline at
-- webhook receipt (due-now steps only). Any delayed step (wait) or retry
-- stalled forever. Schedule it like the legacy dispatcher.
--
-- Applied to follow-up-dev via Supabase MCP on 2026-07-03.

do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'dispatch-pending-workflow-actions') then
    perform cron.schedule(
      'dispatch-pending-workflow-actions',
      '30 seconds',
      'select public.dispatch_pending_workflow_actions(''cron-workflow-worker'', 50);'
    );
  end if;
end
$do$;
