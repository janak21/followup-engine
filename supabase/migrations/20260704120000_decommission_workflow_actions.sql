-- Phase 2 Task 8: decommission the parallel event-workflow machinery.
-- Gate verified 2026-07-04: 0 in-flight workflow_actions, 0 new rows in 24h,
-- 0 workflow errors in 24h, and zero functions outside this drop list
-- reference the table or these functions (live pg_proc scan).
--
-- The unified actions queue has been the sole intake since
-- 20260705095000_event_webhook_intake_unified.
--
-- Applied to follow-up-dev via Supabase MCP on 2026-07-04.

select cron.unschedule('dispatch-pending-workflow-actions');

drop trigger if exists trg_workflow_action_failed_permanent on public.workflow_actions;
drop function if exists public.on_workflow_action_failed_permanent();

-- Exact deployed signatures (from pg_proc scan, 2026-07-04):
drop function if exists public.advance_workflow_run(uuid, text);
drop function if exists public.dispatch_pending_workflow_actions(text, integer);
drop function if exists public.dispatch_workflow_run_actions(uuid, text, integer);
drop function if exists public.mark_workflow_action_failed(uuid, text, integer);
drop function if exists public.process_workflow_conditional_split_action(uuid);
drop function if exists public.process_workflow_create_lead_action(uuid);
drop function if exists public.process_workflow_find_lead_action(uuid);
drop function if exists public.process_workflow_http_request_action(uuid);
drop function if exists public.process_workflow_http_response_collector(uuid, integer);
drop function if exists public.process_workflow_wait_action(uuid);
drop function if exists public.reschedule_workflow_action(uuid, timestamp with time zone, text);

-- Keep history; the rename guarantees nothing writes it silently.
alter table public.workflow_actions rename to workflow_actions_archived;
