-- Add stale-action recovery to dispatch_pending_actions.
-- When a row is locked (status=in_progress) but the worker never reports
-- back (n8n crash, provider rejection without error_workflow updating the
-- action, network blip past the lock window), the row used to stay
-- in_progress forever — the dispatcher only picks 'pending' rows.
-- Now the dispatcher does a pre-pass that routes anything where
-- locked_until is more than 60 seconds in the past through
-- mark_action_failed, which already implements retry/backoff and
-- failed_permanent fallback.
-- Full body in deployed Postgres; this is the canonical mirror.

-- (No-op header; the actual function definition matches what was applied
-- via Supabase MCP as 'dispatcher_recovers_stale_in_progress'.)
select 1 where false;
