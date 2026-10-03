# Launch Execution Brief — Phase 7 Task 6 (agent handoff)

**You are executing the production launch of the Follow-Up Engine.**
This brief is self-contained; the background documents are
`docs/superpowers/plans/2026-07-04-phase7-production-readiness.md` (Task 6) and
`docs/runbooks/production-launch.md` (the full runbook — this brief sequences
the agent-executable subset and marks every human-only step).

## Inputs (must exist before starting)

1. A fresh production Supabase project, created by the operator in the SAME
   organization as `follow-up-dev` (so MCP can see it). Find it via
   `list_projects` — anything that is not `your-project-ref` and was
   created recently is the target. **Record its ref as `<PROD>` and confirm
   with the operator before the first write if more than one candidate exists.**
2. Optional: the operator's Slack webhook URL for ops alerts. If not provided,
   skip that secret — alerting stays quiet until it's set (safe).

## Non-negotiable rules

1. **Every `apply_migration` / `execute_sql` / `deploy_edge_function` in this
   run targets `<PROD>`.** The dev project `your-project-ref` is read-only
   reference during this run (and NEVER receives `supabase db push`, now or
   ever — its migration versions are MCP-assigned and differ from filenames).
2. **Fix forward.** If a migration fails during replay, do NOT edit historical
   migration files. Diagnose, write a new repair migration (timestamped now)
   that makes the sequence replayable, apply it on `<PROD>`, apply it on dev
   too if the fix is semantic (usually it is not — replay-order fixes are
   no-ops on dev), and commit it.
3. Never `CREATE OR REPLACE` outside a committed migration file; never create
   function overloads; every new function carries the standard grants block.
4. Secrets never enter the repo or migration files. Vault writes happen via
   `execute_sql` with values generated at runtime or provided by the operator.
5. Test data on prod uses `*.invalid` emails and is deleted before finishing.

## Execution sequence

### Step 1 — Preflight
- `list_projects` → identify `<PROD>`; verify `ACTIVE_HEALTHY`, Postgres 17.
- Confirm the repo is clean (`git status`) and tests pass
  (`cd dashboard && npm test`).

### Step 2 — Migration replay (the first real replay of this repo)
- Apply every file in `supabase/migrations/` in filename order via
  `apply_migration` (migration name = filename without timestamp/extension).
- **Known watch-points:**
  - `20260612040000_apply_seed` and `20260612160000_voice_test_seed` insert
    seed/test rows. Apply them (replay fidelity), record what they created,
    and delete obvious test rows in Step 8 cleanup.
  - `20260623130000_enable_pg_net_and_inline_call_dispatch` and the cron
    bootstrap (`20260710091000`) require `pg_cron`/`pg_net`; if an extension
    is missing on the fresh project, create it in a repair migration.
  - The decommission migration (`20260704120000`) unschedules a cron job that
    on a fresh replay may not exist — `cron.unschedule` raises on missing
    jobs; if it fails, that is the expected first repair migration (wrap in a
    conditional). Same class of issue may appear anywhere dev-history assumed
    existing state: fix forward, one repair per failure.
- After replay: `select count(*) from supabase_migrations.schema_migrations;`
  must equal the repo file count (± repair migrations).

### Step 3 — Vault secrets (agent-settable ones)
```sql
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'internal_dispatch_key');
select vault.create_secret('https://<PROD>.supabase.co', 'functions_base_url');
-- only if the operator provided one:
select vault.create_secret('<SLACK_WEBHOOK_URL>', 'ops_slack_webhook_url');
```
Verify `get_functions_base_url()` returns the prod URL and
`get_internal_dispatch_key()` returns the new key.

### Step 4 — Deploy edge functions
Deploy these 10 from `supabase/functions/<name>/index.ts` via
`deploy_edge_function`, `verify_jwt=false` for all EXCEPT none (all ten do
their own bearer/webhook auth — match dev exactly, where all active functions
run `verify_jwt=false`):
`journey-trigger, retell-result, twilio-status, twilio-status-poll,
dispatch-retell-call, dispatch-twilio-sms, dispatch-gmail-email,
poll-gmail-inbox, generate-ai-reply, twilio-inbound, notify-operator`
(11 names listed — `dispatch-workflow-http-request` is decommissioned and must
NOT be deployed).

### Step 5 — HUMAN STEP (pause and tell the operator exactly this)
> In the Supabase dashboard for `<PROD>`: Edge Functions → Secrets → add
> `INTERNAL_DISPATCH_KEY` = (the value from Step 3 — print it for them once,
> from `select get_internal_dispatch_key();`). Alternatively:
> `supabase secrets set INTERNAL_DISPATCH_KEY=<value> --project-ref <PROD>`.
Wait for confirmation before Step 6 — without it, pg_net→edge auth fails.

### Step 6 — Engine ignition checks
- `select jobname from cron.job;` → 4 jobs.
- Wait ≥90s; `cron.job_run_details` shows green ticks for
  `dispatch-pending-actions` and `poll-gmail-inbox` (poller may 200 with zero
  senders — that is healthy).
- `SUPABASE_URL=https://<PROD>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<prod key> node scripts/drift-check.mjs`
  → all PASS (url-leak check: the helper fallback contains the dev ref by
  design; the script already excludes `get_functions_base_url`).

### Step 7 — Smoke suite (synthetic only)
1. Seed a minimal tenant if the seed migrations didn't leave a usable one
   (`insert into tenants ...` per the runbook's onboarding section).
2. Synthetic two-step wait journey + `*.invalid` lead via
   `enroll_lead_in_journey` → completes via the real cron (two ticks),
   `current_step=1`.
3. Webhook round-trip: journey with `webhook_token`, `process_journey_webhook`
   with a mapped payload → `status='processed'`, action row in `actions`.
4. `select scan_and_alert_ops();` → `no_webhook_configured` or `quiet`.
5. `select prune_engine_history();` → returns counts, no error.
6. Security advisors on `<PROD>`: no ERROR-level findings; anon/authenticated
   can execute 0 public functions (`has_function_privilege` sweep).

### Step 8 — Cleanup + handback
- Delete all smoke/test rows and any seed test data recorded in Step 2.
- Commit: repair migrations (if any) + an update to
  `docs/decisions/008-production-readiness.md` with the launch date, `<PROD>`
  ref, and the list of repair migrations the replay needed.
- Print the HUMAN CHECKLIST for the operator (these cannot be done by agent):
  1. Twilio console: inbound webhook + StatusCallback →
     `https://<PROD>.supabase.co/functions/v1/twilio-inbound` / `twilio-status`
  2. Retell: post-call webhook → `.../functions/v1/retell-result`
  3. Google Cloud per-tenant OAuth clients: add prod dashboard origin +
     redirect URI
  4. Dashboard hosting env: `NEXT_PUBLIC_SUPABASE_URL`,
     `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` → prod values
  5. Supabase Auth (BOTH projects): enable leaked-password protection
  6. Enable PITR/backup tier on `<PROD>`
  7. Set `ops_slack_webhook_url` Vault secret if not done in Step 3
  8. Onboard the first tenant per `docs/runbooks/production-launch.md` §11

## Success criteria
Replay complete with schema_migrations parity; drift-check all PASS on prod;
cron green; smoke suite clean; zero test rows left; repair migrations (if any)
committed; human checklist delivered.
