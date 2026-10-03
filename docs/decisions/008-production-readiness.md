# 008 Production Readiness

Date: 2026-07-05

## Decision

Make production launch reproducible from the repo by removing dev-project URL coupling, bootstrapping cron jobs in migrations, adding operator alerting, pruning old engine data, and shipping an advisory drift check plus launch runbook.

## Context

The dispatcher previously embedded the dev Supabase project URL in its edge-function calls. Core cron jobs existed in dev because of hand-run SQL. The engine also had no operator alert path for stalled dispatch or accumulating errors.

## Chosen Design

1. `get_functions_base_url()` reads Vault secret `functions_base_url` and falls back to the dev URL for sandbox continuity.
2. `dispatch_pending_actions(text, integer, integer)` constructs edge-function URLs from that helper.
3. Migrations create or align cron jobs: dispatcher, Gmail poller, ops alert scan, and retention pruning.
4. `scan_and_alert_ops()` batches new engine errors, permanent action failures, and stale dispatcher heartbeat alerts into `notify-operator`.
5. `notify-operator` posts to Slack using a webhook URL passed from Vault-backed SQL and accepts only service-role/internal bearer tokens.
6. Retention windows are 90 days for `error_logs`, 90 days for `events.channel='system'`, and 180 days for completed/cancelled actions.
7. `workflow_actions_archived` is dropped; dashboard execution reads use unified `actions`.
8. `drift-check` verifies migration parity, dev URL leaks, public execute grants, and expected cron jobs.

## Consequences

Fresh prod projects can be replayed from migrations and configured through the runbook. Dev remains usable without setting `functions_base_url`. Alerting is intentionally global in this phase; per-tenant routing is deferred.

Known dev migration-history drift is documented in the runbook and excluded from the advisory script because those historical records are superseded by later migrations and cannot be safely replayed into dev out of order.

## Production Launch Record

Production launch executed on 2026-07-05 against Supabase project `xlvthuuinxbpyinviqvp` (`follow-up-prod`, `us-east-1`).

Fresh production replay required these forward repair migrations:

1. `20260705063312_repair_complete_rls_rollback_policy_conflicts.sql` drops policies that an older rollback migration recreates without guards.
2. `20260705141250_repair_enable_pg_cron_for_workflow_scheduler.sql` installs `pg_cron` before scheduler migrations reference `cron.job`.
3. `20260705141753_repair_internal_dispatch_key_helper.sql` restores `get_internal_dispatch_key()` after recording the historical large function-body backfill as a no-op due migration transport limits.
4. `20260705142554_repair_enable_rls_on_phase7_tables.sql` enables RLS and service-role policies for Phase 7 tables flagged by production security advisors.

Post-launch verification passed with 144 repo migrations and 144 applied production migrations, zero dev URL leaks, zero anon/authenticated public function execute grants, four expected cron jobs present, clean security advisors, and zero synthetic smoke rows remaining.
