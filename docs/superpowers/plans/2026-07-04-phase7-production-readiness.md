# Phase 7: Production Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can be stood up on a fresh production Supabase project from the repo alone, alerts an operator when something breaks, prunes its own growth, and ships with a launch runbook — so real client tenants can run on prod while dev stays a sandbox.

**Architecture:** Four workstreams. (1) **Portability:** the dispatcher hard-codes the dev project URL for its four edge-function calls — that becomes a Vault-backed `get_functions_base_url()` helper, and everything environment-specific (cron jobs, Vault secrets, buckets, auth toggles) gets either an idempotent bootstrap migration or an explicit runbook line. (2) **Alerting:** a `notify-operator` edge function + 5-minute cron watchdog posts new engine errors and a stale-dispatcher heartbeat to a per-tenant (or global ops) Slack webhook — closing the "engine silently stalled for 5 hours" gap that opened this whole project. (3) **Retention:** scheduled pruning for `error_logs`, `journey_webhook_samples` (already capped), and old completed actions/events beyond a retention window. (4) **Drift discipline as code:** a `drift-check` script that verifies repo↔deployed migration parity and scans for environment leaks, turning the Task-0 ritual into a one-command check.

**Tech Stack:** Supabase Postgres 17 (plpgsql + pg_cron + Vault), one Deno edge function, Node script, runbook docs.

---

## Environment & Working Agreements

- **Repo:** `<repo-root>` (branch `main`). Only `git add` files named in each commit step.
- **Migrations:** file in `supabase/migrations/` + apply identical SQL to dev `your-project-ref` via MCP `apply_migration`. Prod application happens via the runbook (Task 6), not ad hoc.
- **JS tests:** `cd dashboard && npm test`.
- **Secrets NEVER go in migrations or the repo** — Vault entries and edge-function env vars are runbook steps with placeholders.

## Hard Rules (violations caused production bugs in Phases 1-6)

1. **Never `CREATE OR REPLACE` a function without first diffing the DEPLOYED body** against the repo's newest version (Task 0).
2. **Never introduce a function overload** — replace exact signatures.
3. **Verify every column a function writes exists.**
4. **Every new/replaced function gets the grants block.**

## Locked Design Decisions

1. **`get_functions_base_url()`** mirrors the existing `get_internal_dispatch_key()` pattern: reads Vault secret `functions_base_url`; falls back to the current dev URL when the secret is absent so dev behavior is unchanged until the secret is set. The dispatcher's four URL constants become `get_functions_base_url() || '/functions/v1/<name>'`. The pg_cron `poll-gmail-inbox` command gets the same treatment (re-scheduled from a migration so it's reproducible).
2. **Cron bootstrap is idempotent migration, not runbook prose.** The two core jobs (`dispatch-pending-actions`, `poll-gmail-inbox`) exist in dev only because someone once ran SQL by hand — the bootstrap migration re-creates them `if not exists` with the Vault-based URL, making fresh-project replay produce a working engine.
3. **Alerting scope:** one global ops webhook (Vault secret `ops_slack_webhook_url`) this phase; per-tenant webhooks are a column added later. Alert triggers: (a) new `error_logs` rows with `severity='error'` since the last scan; (b) dispatcher heartbeat stale — newest `cron.job_run_details` success for `dispatch-pending-actions` older than 5 minutes; (c) `failed_permanent` actions in the last scan window. Dedup via a single-row `ops_alert_state` table storing the last-scanned timestamp; the cron calls the edge function only when there is something to say.
4. **Retention:** nightly prune cron — `error_logs` > 90 days; `events` with `channel='system'` > 90 days (provider events are kept — they are the conversation history); completed/cancelled `actions` > 180 days; `workflow_actions_archived` dropped entirely (its 30-day window is a launch-blocker anyway — folded in here); `journey_versions` kept forever (tiny).
5. **Drift check is advisory, not enforcing:** `node scripts/drift-check.mjs` prints PASS/FAIL per check (migration parity, no dev-URL leak in deployed function bodies, no functions executable by anon/authenticated, cron jobs present). It uses `SUPABASE_DB_URL` or service-role REST; no CI wiring this phase.
6. **Prod is a NEW Supabase project** (fresh region choice allowed); dev keeps its data. Tenant data does not migrate — client tenants are onboarded fresh on prod via the runbook checklist.
7. **Out of scope:** multi-region, staging tier, CI pipeline, per-tenant alert webhooks, dashboards hosting change (wherever the Next.js app runs today keeps running — the runbook records its env vars).

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260710090000_functions_base_url.sql` | Create: Vault-backed URL helper + dispatcher de-hardcoded |
| `supabase/migrations/20260710091000_cron_bootstrap.sql` | Create: idempotent core cron jobs (Vault URL) |
| `supabase/migrations/20260710092000_ops_alerting.sql` | Create: ops_alert_state + scan function + 5-min cron |
| `supabase/migrations/20260710093000_retention_prune.sql` | Create: nightly prune + drop workflow_actions_archived |
| `supabase/functions/notify-operator/index.ts` | Create: Slack webhook poster |
| `scripts/drift-check.mjs` | Create: repo↔deployed parity + env-leak scan |
| `docs/runbooks/production-launch.md` | Create: the launch runbook |
| `docs/decisions/008-production-readiness.md` | Create: decision record |

---

### Task 0: Preflight — deployed-vs-repo diff + environment inventory (mandatory)

- [ ] **Step 1:** Diff deployed vs repo for `dispatch_pending_actions` (base should be Phase-4-era with ab_split routing — reconcile drift first).
- [ ] **Step 2: Environment inventory.** Produce the definitive list of environment-specific state by querying dev, and record it in the runbook draft as you go:

```sql
-- hardcoded URLs inside function bodies (expect: dispatch_pending_actions)
select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prokind='f'
   and pg_get_functiondef(p.oid) like '%your-project-ref%';
-- cron jobs + their commands (URLs inside!)
select jobname, command from cron.job;
-- vault secrets (names only)
select name from vault.secrets;
-- storage buckets
select id, name, public from storage.buckets;
```

Also inventory: edge functions deployed (10 active after the manual `dispatch-workflow-http-request` deletion — verify it was actually deleted; if not, that's runbook step 0), edge function env vars in use (`INTERNAL_DISPATCH_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — grep `Deno.env.get` across `supabase/functions/*/index.ts`), dashboard env vars (grep `process.env.` across `dashboard/src`), and Supabase Auth settings that differ from defaults (leaked-password protection — still OFF in dev; must be ON in prod).

- [ ] **Step 3:** Confirm `resolve_tenant_by_phone` / Twilio & Retell webhook URLs that live OUTSIDE this repo (Twilio console StatusCallback/inbound URLs, Retell webhook URL, Google OAuth redirect URIs) — list each as a runbook line with where to change it.

---

### Task 1: De-hardcode the dispatcher

**Files:**
- Create: `supabase/migrations/20260710090000_functions_base_url.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 7: environment portability. The dispatcher called edge functions at
-- a hardcoded dev project URL — on any other project it would post to DEV.
-- Base URL now comes from Vault ('functions_base_url', no trailing slash),
-- falling back to the dev URL so dev keeps working before the secret is set.

create or replace function public.get_functions_base_url()
returns text
language sql
security definer
set search_path to 'vault', 'public'
as $$
  select coalesce(
    (select decrypted_secret from vault.decrypted_secrets
      where name = 'functions_base_url' limit 1),
    'https://your-project-ref.supabase.co'
  );
$$;

revoke execute on function public.get_functions_base_url()
  from public, anon, authenticated;
grant execute on function public.get_functions_base_url() to service_role;
```

Plus the full `dispatch_pending_actions(text, integer, integer)` replacement (base = Task 0 reconciled) with exactly one change — the four URL constants become:

```sql
  v_base_url     text := public.get_functions_base_url();
  v_call_url     text;
  v_sms_url      text;
  v_email_url    text;
  v_ai_reply_url text;
begin
  v_call_url     := v_base_url || '/functions/v1/dispatch-retell-call';
  v_sms_url      := v_base_url || '/functions/v1/dispatch-twilio-sms';
  v_email_url    := v_base_url || '/functions/v1/dispatch-gmail-email';
  v_ai_reply_url := v_base_url || '/functions/v1/generate-ai-reply';
```

(assignments at the top of the body since defaults can't call the helper before the declare block completes — declare without defaults, assign first thing in `begin`). Grants block.

- [ ] **Step 2: Apply to dev; verify** `select get_functions_base_url();` returns the dev URL (no secret set), a flush tick succeeds, and `select proname ... where pg_get_functiondef like '%your-project-ref%'` now returns ONLY `get_functions_base_url` (the fallback) — no other function embeds the URL.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260710090000_functions_base_url.sql
git commit -m "feat(engine): Vault-backed functions base URL — dispatcher portable across projects"
```

---

### Task 2: Cron bootstrap migration

**Files:**
- Create: `supabase/migrations/20260710091000_cron_bootstrap.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 7: the two core cron jobs existed only as hand-run SQL in dev. A
-- fresh project replaying this repo now gets a working engine. Idempotent:
-- existing jobs are left untouched (dev), missing jobs are created (prod).

do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'dispatch-pending-actions') then
    perform cron.schedule(
      'dispatch-pending-actions',
      '30 seconds',
      'select public.dispatch_pending_actions(''cron-worker'', 50);'
    );
  end if;

  if not exists (select 1 from cron.job where jobname = 'poll-gmail-inbox') then
    perform cron.schedule(
      'poll-gmail-inbox',
      '* * * * *',
      $cmd$
      select net.http_post(
        url     := public.get_functions_base_url() || '/functions/v1/poll-gmail-inbox',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || public.get_internal_dispatch_key()
        ),
        body                 := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
      $cmd$
    );
  end if;
end
$do$;
```

Note the dev `poll-gmail-inbox` job keeps its old hardcoded command (it exists, so the migration skips it) — **also re-schedule it in dev** so both environments run the Vault-based command: add to the migration a conditional update path:

```sql
-- Align dev's existing poller with the portable command.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'poll-gmail-inbox'
              and command not like '%get_functions_base_url%') then
    perform cron.unschedule('poll-gmail-inbox');
    perform cron.schedule('poll-gmail-inbox', '* * * * *',
      $cmd$
      select net.http_post(
        url     := public.get_functions_base_url() || '/functions/v1/poll-gmail-inbox',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || public.get_internal_dispatch_key()
        ),
        body                 := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
      $cmd$);
  end if;
end
$do$;
```

- [ ] **Step 2: Apply to dev; verify:** `select jobname, command from cron.job` shows both jobs, poller command contains `get_functions_base_url`, and the next poller tick succeeds (`cron.job_run_details`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260710091000_cron_bootstrap.sql
git commit -m "feat(engine): idempotent cron bootstrap — fresh projects get a working engine"
```

---

### Task 3: Operator alerting

**Files:**
- Create: `supabase/functions/notify-operator/index.ts`, `supabase/migrations/20260710092000_ops_alerting.sql`

- [ ] **Step 1: Edge function** (complete):

```ts
// Posts engine alerts to the ops Slack webhook (Vault: ops_slack_webhook_url,
// passed in the request body by the SQL scanner — the function itself holds
// no secrets beyond the dispatch key check).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_DISPATCH_KEY = Deno.env.get("INTERNAL_DISPATCH_KEY") || "";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false });
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== SUPABASE_SERVICE_ROLE_KEY && (!INTERNAL_DISPATCH_KEY || token !== INTERNAL_DISPATCH_KEY)) {
    return json(401, { ok: false });
  }

  let body: { webhook_url?: string; text?: string };
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "bad json" }); }
  if (!body.webhook_url || !body.text) return json(400, { ok: false, error: "webhook_url and text required" });
  if (!/^https:\/\/hooks\.slack\.com\//.test(body.webhook_url)) {
    return json(400, { ok: false, error: "only hooks.slack.com webhooks allowed" });
  }

  const res = await fetch(body.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body.text.slice(0, 3500) }),
  });
  return json(res.ok ? 200 : 502, { ok: res.ok, slack_status: res.status });
});
```

Deploy to dev via MCP `deploy_edge_function` (verify_jwt=false — it does its own bearer check, same pattern as the other internal functions).

- [ ] **Step 2: SQL scanner + cron** (migration, complete):

```sql
-- Phase 7: ops alerting. Every 5 minutes, scan for (a) new severity=error
-- rows, (b) stale dispatcher heartbeat, (c) new failed_permanent actions.
-- Posts to Slack via notify-operator when ops_slack_webhook_url is set.

create table if not exists public.ops_alert_state (
  id integer primary key default 1 check (id = 1),
  last_scanned_at timestamptz not null default now(),
  last_heartbeat_alert_at timestamptz
);
insert into public.ops_alert_state (id) values (1) on conflict do nothing;

create or replace function public.scan_and_alert_ops()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_state public.ops_alert_state%rowtype;
  v_webhook text;
  v_errors integer;
  v_failed integer;
  v_last_tick timestamptz;
  v_lines text := '';
  v_now timestamptz := now();
begin
  select decrypted_secret into v_webhook
    from vault.decrypted_secrets where name = 'ops_slack_webhook_url' limit 1;
  if v_webhook is null then
    return jsonb_build_object('status', 'no_webhook_configured');
  end if;

  select * into v_state from public.ops_alert_state where id = 1 for update;

  select count(*) into v_errors
    from public.error_logs
   where severity = 'error' and created_at > v_state.last_scanned_at;

  select count(*) into v_failed
    from public.actions
   where status = 'failed_permanent' and completed_at > v_state.last_scanned_at;

  select max(d.start_time) into v_last_tick
    from cron.job j join cron.job_run_details d on d.jobid = j.jobid
   where j.jobname = 'dispatch-pending-actions' and d.status = 'succeeded';

  if v_errors > 0 then
    v_lines := v_lines || format(':rotating_light: %s new engine error(s) since %s'
      || E'\n', v_errors, to_char(v_state.last_scanned_at, 'HH24:MI'));
  end if;
  if v_failed > 0 then
    v_lines := v_lines || format(':x: %s action(s) failed permanently' || E'\n', v_failed);
  end if;
  if v_last_tick is not null and v_last_tick < v_now - interval '5 minutes'
     and (v_state.last_heartbeat_alert_at is null
          or v_state.last_heartbeat_alert_at < v_now - interval '30 minutes') then
    v_lines := v_lines || format(':heartbeat: dispatcher last succeeded %s — STALLED?' || E'\n',
      to_char(v_last_tick, 'YYYY-MM-DD HH24:MI'));
    update public.ops_alert_state set last_heartbeat_alert_at = v_now where id = 1;
  end if;

  update public.ops_alert_state set last_scanned_at = v_now where id = 1;

  if v_lines = '' then
    return jsonb_build_object('status', 'quiet');
  end if;

  perform net.http_post(
    url := public.get_functions_base_url() || '/functions/v1/notify-operator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.get_internal_dispatch_key()
    ),
    body := jsonb_build_object('webhook_url', v_webhook, 'text',
      '*Follow-Up Engine* ' || E'\n' || v_lines),
    timeout_milliseconds := 15000
  );

  return jsonb_build_object('status', 'alerted', 'errors', v_errors, 'failed', v_failed);
end;
$$;

revoke execute on function public.scan_and_alert_ops() from public, anon, authenticated;
grant execute on function public.scan_and_alert_ops() to service_role;

do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'ops-alert-scan') then
    perform cron.schedule('ops-alert-scan', '*/5 * * * *',
      'select public.scan_and_alert_ops();');
  end if;
end
$do$;
```

- [ ] **Step 3: Verify on dev:** without the Vault secret → `no_webhook_configured` (quiet no-op, cron ticks green). Set a real (or requestbin) webhook secret, insert a fake `severity='error'` row, run the scanner → Slack message received; delete the fake row. Leave the secret unset OR set to the user's real ops channel per their choice — record in runbook.

- [ ] **Step 4: Commit** (edge fn + migration).

```bash
git add supabase/functions/notify-operator/index.ts supabase/migrations/20260710092000_ops_alerting.sql
git commit -m "feat(ops): Slack alerting — engine errors, permanent failures, dispatcher heartbeat"
```

---

### Task 4: Retention pruning + archive drop

**Files:**
- Create: `supabase/migrations/20260710093000_retention_prune.sql`

- [ ] **Step 1: Write the migration**

```sql
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
  with d as (delete from public.error_logs where created_at < now() - interval '90 days' returning 1)
  select count(*) into v_errors from d;

  with d as (delete from public.events
              where channel = 'system' and created_at < now() - interval '90 days' returning 1)
  select count(*) into v_system_events from d;

  with d as (delete from public.actions
              where status in ('completed', 'cancelled')
                and coalesce(completed_at, created_at) < now() - interval '180 days' returning 1)
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
```

**Before applying:** the executions route still UNIONs `workflow_actions_archived` (legacy branch from Phase 2 Task 6) — remove that read in the same task (delete the second query + merge; keep the unified `actions` read only) or the route 500s on old event runs. Check `dashboard/src/app/api/journeys/[id]/executions/route.js` and simplify.

- [ ] **Step 2: Apply; verify:** `select prune_engine_history();` returns counts (0s are fine), cron job listed, archive table gone, executions endpoint still 200 for a journey with runs. `npm test` green.

- [ ] **Step 3: Commit** (migration + executions route).

```bash
git commit -m "feat(ops): nightly retention pruning; drop workflow_actions archive"
```

---

### Task 5: Drift-check script

**Files:**
- Create: `scripts/drift-check.mjs`

- [ ] **Step 1: Write the two pieces.** First a migration, `supabase/migrations/20260710094000_drift_check_report.sql`, defining `drift_check_report()` (security definer, service_role-only grants) that returns one jsonb: applied migration versions+names from `supabase_migrations.schema_migrations`, function names whose body contains the dev project ref (excluding `get_functions_base_url`), the count of public functions executable by anon/authenticated, and cron jobnames. Then the dependency-free Node script (`fetch` against PostgREST `/rest/v1/rpc/drift_check_report` with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env), which reads `supabase/migrations/*.sql` filenames locally, calls the RPC, and prints:

```
[PASS|FAIL] migrations: repo N / applied M / missing-in-db [...] / unknown-in-db [...]
[PASS|FAIL] url-leak: functions embedding the dev URL: [...]
[PASS|FAIL] grants: N functions executable by anon/authenticated (expect 0)
[PASS|FAIL] cron: expected {dispatch-pending-actions, poll-gmail-inbox, ops-alert-scan, prune-engine-history} present
```

Exit code 1 on any FAIL. Add `"drift-check": "node ../scripts/drift-check.mjs"` to `dashboard/package.json` scripts (or run directly with node — keep it dependency-free using `fetch` against PostgREST `/rest/v1/rpc/drift_check_report`).

- [ ] **Step 2: Run against dev** — expect all PASS (migration parity note: dev has MCP-named versions that differ from file timestamps; the script must compare by NAME suffix, not timestamp — the MCP applies recorded `name` in `supabase_migrations.schema_migrations`; reconcile the comparison rule accordingly and document it in the script header).

- [ ] **Step 3: Commit**

```bash
git add scripts/drift-check.mjs supabase/migrations/20260710094000_drift_check_report.sql dashboard/package.json
git commit -m "feat(ops): drift-check — repo/deployed parity and env-leak scan in one command"
```

---

### Task 6: The launch runbook

**Files:**
- Create: `docs/runbooks/production-launch.md`

- [ ] **Step 1: Write the runbook** from the Task 0 inventory. Required sections (each a numbered checklist with exact commands/console paths):
  1. **Create prod project** (region, Postgres 17, note project ref).
  2. **Replay schema:** `supabase link --project-ref <prod>` + `supabase db push` (all migrations, in order, from the repo — this is why repo↔deployed parity mattered all along). Alternative: MCP apply per file.
  3. **Vault secrets:** `internal_dispatch_key` (new random), `functions_base_url` (`https://<prod-ref>.supabase.co`), `ops_slack_webhook_url`.
  4. **Deploy edge functions:** the 10 active ones, with env vars (`INTERNAL_DISPATCH_KEY` matching Vault). List each function name explicitly.
  5. **Auth settings:** enable leaked-password protection (dev still has it OFF — enable there too), disable public signups if applicable.
  6. **Storage:** csv-uploads bucket exists via migration; verify policies.
  7. **External webhooks:** Twilio inbound + StatusCallback URLs → prod `twilio-status`/`twilio-inbound`; Retell webhook → prod `retell-result`; Google OAuth redirect URIs → prod dashboard origin (per-tenant Workspace clients).
  8. **Dashboard env:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (prod), `NEXT_PUBLIC_SUPABASE_ANON_KEY` — and confirm `SUPABASE_SERVICE_ROLE_KEY` is actually set (the anon fallback in `utils/supabase.js` now fails loudly thanks to the grant hardening; the runbook says how to recognize that failure).
  9. **Enable PITR / backups** (dashboard setting; pick tier).
  10. **Smoke suite** (copy-paste SQL): cron jobs ticking, `drift-check` all PASS, synthetic wait-journey enrollment completes via cron, webhook intake round-trip, `scan_and_alert_ops()` returns quiet, test Slack alert fires from a fake error row.
  11. **Tenant onboarding checklist:** tenant row, credentials (Twilio/Retell/OpenAI-or-Anthropic/Gmail OAuth client), senders + OAuth connect, business hours/timezone, suppression import, first journey publish, test lead end-to-end.
- [ ] **Step 2:** Walk the runbook top-to-bottom against a REAL new prod project (this is the actual launch). Every step that surprises you gets edited into the runbook before continuing. Run `drift-check` against prod at the end — all PASS.
- [ ] **Step 3:** `docs/decisions/008-production-readiness.md` recording: Vault-based URL indirection, cron bootstrap, alerting design (global webhook, 5-min scan, 30-min heartbeat dedup), retention windows, drift-check checks, and the launch date.
- [ ] **Step 4: Commit** runbook + decision record.

---

## Post-Plan Checklist

- [ ] `npm test` green; advisors clean on BOTH projects; `drift-check` PASS on both
- [ ] Dev retains: leaked-password protection ON (fix the long-standing dev gap while at it)
- [ ] `dispatch-workflow-http-request` deployed copy deleted (if still lingering)
- [ ] Memory/PRD updated; PRD gets a v3 note: production live, single-queue run-centric engine

## Known Risks

1. **`supabase db push` vs MCP-applied history:** dev's `schema_migrations` versions were assigned by MCP at apply time and do NOT match repo file timestamps. Prod replayed from files will have file-timestamp versions. That asymmetry is permanent and harmless — but it means drift-check compares by NAME, and nobody should ever `db push` against DEV. The runbook states this in bold.
2. **First full replay is untested:** the repo has never actually been replayed end-to-end since the June 26 backfill (that was its stated goal, unverified). Task 6 Step 2 IS that test, on the real prod project; expect one or two ordering surprises (e.g., seed data assumptions, `apply_seed` migration) — fix forward with repair migrations, never by editing history.
3. **pg_net + Vault availability on fresh projects:** extensions enabled by migrations, but Vault secrets must exist before the first cron tick fires or the poller 401s harmlessly until Step 3 is done — runbook orders secrets before cron-enabling traffic.
4. **Alert noise:** a bad tenant credential can produce an error per tick; the 5-minute batch scan caps Slack at 12 messages/hour worst case. Acceptable v1; per-source dedup is a follow-up.
