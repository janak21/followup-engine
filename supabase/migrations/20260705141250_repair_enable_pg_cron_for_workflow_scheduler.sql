-- Repair fresh production replay before
-- 20260703140000_schedule_workflow_actions_dispatcher.
-- Fresh projects may not have pg_cron installed when the scheduler migration
-- first references cron.job.
create extension if not exists pg_cron with schema cron;
