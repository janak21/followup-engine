# Phase 8: Client Reporting & Deliverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show clients what the system did for them: email open/click tracking, per-journey funnel analytics over time and across published versions, an AI-agent analytics page, and a weekly per-tenant digest — plus the drift-check upgrade that would have caught the launch's missing-function incident automatically.

**Architecture:** Tracking rides the existing rails: a `track` edge function serves a 1px GIF (`/track/o/<token>`) and a 302 redirect (`/track/c/<token>`), writing `events` rows (`channel='email'`, `direction='internal'`, `event_type` open/click) keyed by a signed token minted at send time in `dispatch-gmail-email` (pixel + link-rewrite in the HTML MIME part only). Analytics are SQL RPCs over existing tables (`journey_runs` × `journey_versions` for per-version funnels — no new tracking tables). The weekly digest reuses the Phase 7 alerting rail (`notify-operator` + a Monday cron). Drift-check gains cross-environment function-set parity.

**Tech Stack:** Supabase Postgres 17, one new + one modified Deno edge function, Next.js dashboard pages, `node --test`.

---

## Environment & Working Agreements

- **TWO live projects now.** Dev `your-project-ref`, prod `xlvthuuinxbpyinviqvp`. Every migration in this plan applies to BOTH (dev first, prod after the task's verification passes on dev). Edge function changes deploy to both. All synthetic testing happens on DEV only; prod gets only the migration/deploy + drift-check pass.
- **Migrations:** file in `supabase/migrations/` + apply via MCP `apply_migration` (same name) per project.
- **JS tests:** `cd dashboard && npm test`.

## Hard Rules (violations caused production bugs in Phases 1-7)

1. **Never `CREATE OR REPLACE` a function without first diffing the DEPLOYED body on the target project** — with two projects, diff BOTH (they can drift from each other now; the launch left prod briefly missing 25 functions).
2. **Never introduce a function overload.**
3. **Verify every column a function writes exists.**
4. **Every new/replaced function gets the grants block.**
5. **Keep any single migration under ~50KB** — the MCP transport silently no-op'd a 120KB migration during the launch replay. Split large bodies across files.

## Locked Design Decisions

1. **Tracking tokens:** `<action_id>.<hmac>` where hmac = first 16 hex of `hmac-sha256(action_id, internal_dispatch_key)` — no new secret, stateless verification in the edge function via one RPC (`record_tracking_event`) that validates + writes. Opens dedupe to one event per action per hour; clicks store the destination URL in `raw_payload` and always redirect even if recording fails (never break a client's link).
2. **Link rewriting is opt-in per tenant** (`tenants.config.click_tracking = true`) and skips unsubscribe/mailto/anchor links. Open pixel is on for all HTML sends (industry default; note Apple MPP inflation in the UI copy).
3. **Funnel-over-versions is free:** `journey_runs.journey_version` + `journey_versions` already exist — `journey_report(p_journey_id, p_from, p_to)` returns enrollment→completion→reply→opt-out counts grouped by version and by week. No schema changes.
4. **AI analytics** reads `ai_reply_events` as-is: per-agent replies/escalations/errors, intent distribution, confidence histogram, cost trend (the PRD Tier-A item).
5. **Weekly digest:** Monday 08:00 tenant-local is overkill v1 — Monday 13:00 UTC flat, one Slack message per tenant with sends/replies/opens/clicks/bounces + top journey, via `notify-operator`. Skipped silently for tenants without a webhook (reuses `ops_slack_webhook_url` global fallback? No — digest is per-tenant value; add `tenants.config.digest_slack_webhook_url`, global ops webhook is NOT used for client digests).
6. **Out of scope:** per-recipient open timelines UI, bot-click filtering beyond dedupe, PDF report export, calendar booking.

## File Map

| File | Change |
|---|---|
| `scripts/drift-check.mjs` + `supabase/migrations/2026070609xxxx_drift_report_function_parity.sql` | Task 0: function/trigger-set parity across environments |
| `supabase/migrations/2026070610xxxx_tracking_events.sql` | record_tracking_event RPC + events.event_type support check |
| `supabase/functions/track/index.ts` | Create: pixel + redirect |
| `supabase/functions/dispatch-gmail-email/index.ts` | Modify: pixel injection + opt-in link rewrite |
| `supabase/migrations/2026070611xxxx_reporting_rpcs.sql` | journey_report, ai_agent_report, tenant_weekly_digest |
| `supabase/migrations/2026070612xxxx_weekly_digest_cron.sql` | Monday cron → digest → notify-operator |
| `dashboard/src/app/journeys/[id]/report/page.jsx` (or extend journeys page) | Funnel/version report UI |
| `dashboard/src/app/settings/ai-agents/page.jsx` | Analytics tab |
| `docs/decisions/009-client-reporting.md` | Decision record |

---

### Task 0: Drift-check learns function parity (the launch-incident guard)

- [ ] **Step 1:** Fetch deployed `drift_check_report()` from BOTH projects (Hard Rule 1); reconcile repo if drifted.
- [ ] **Step 2:** Migration (both projects): extend the report's jsonb with `function_names` (sorted array of `proname(oid::regprocedure)` in public), `trigger_names` (sorted `table:trigger` array), and `functions_md5` (md5 of the concatenated sorted list). Grants block; same signature (no overload — CREATE OR REPLACE with identical args).
- [ ] **Step 3:** `scripts/drift-check.mjs` gains a `--compare <other_url> <other_key>` mode: runs the report against both projects and FAILs listing set differences. Run `node scripts/drift-check.mjs --compare` dev↔prod → **must PASS now** (post-repair) — this retroactively proves the launch repair is complete.
- [ ] **Step 4:** Add the cross-env compare to the runbook smoke suite + commit.

### Task 1: Tracking RPC + edge function

- [ ] **Step 1:** Migration (both): `record_tracking_event(p_action_id uuid, p_kind text, p_sig text, p_url text default null)` — recompute hmac via `get_internal_dispatch_key()` + `hmac` from pgcrypto (`extensions.hmac`), reject bad signatures with `{ok:false}`; on open: insert `events` row (`channel='email'`, `direction='internal'`, `provider='tracker'`, `raw_payload = {kind:'open'}`) unless one exists for the action within 1h; on click: always insert with `{kind:'click', url}`. Returns `{ok, recorded}`. Grants block. Verify columns used exist on `events` (Hard Rule 3 — check `event_type` vs raw_payload-only; use raw_payload, no schema change).
- [ ] **Step 2:** `supabase/functions/track/index.ts` (complete in-task): GET `/track/o/<action_id>.<sig>` → call RPC kind=open → return 43-byte transparent GIF with no-cache headers; GET `/track/c/<action_id>.<sig>?u=<b64url>` → call RPC kind=click → 302 to decoded URL (validate http/https; on any error still 302). `verify_jwt=false` (public endpoints; the hmac IS the auth). Deploy to both projects.
- [ ] **Step 3:** Dev verification: mint a token via SQL (hmac of a real completed email action), curl the pixel + a click, confirm two events rows + dedupe on second open within the hour; bad signature records nothing and still serves GIF/redirect.
- [ ] **Step 4:** Commit (migration + edge fn).

### Task 2: Send-path injection

- [ ] **Step 1:** `dispatch-gmail-email` (deployed v8+ is repo-synced; re-diff per Hard Rule 1): after `rfc822` build inputs are ready — inject `<img src="<base>/functions/v1/track/o/<token>" ...>` before `</body>` (or append) in the HTML part only; when `tenant.config.click_tracking`, rewrite `href="http(s)://..."` links (skip mailto/#/unsubscribe-listed domains) to `/track/c/<token>?u=<b64url(original)>`. Token minted with Web Crypto HMAC using `INTERNAL_DISPATCH_KEY` (same secret the RPC checks). Plain-text part untouched.
- [ ] **Step 2:** Deploy to dev; send a REAL test email to your own address via the inline composer on a dev tenant; verify pixel/click round-trip end-to-end in `events`. Deploy to prod only after dev pass. Commit.

### Task 3: Reporting RPCs

- [ ] **Step 1:** Migration (both), three read-only RPCs (STABLE, SECURITY DEFINER, service_role-only):
  - `journey_report(p_journey_id, p_from date, p_to date)` → jsonb: totals + per-version rows (enrolled, completed, responded, opted_out, avg completion seconds — from `journey_runs`) + per-week enrollment series + open/click counts joined from tracker events via runs' action ids.
  - `ai_agent_report(p_tenant_id, p_agent_id, p_from, p_to)` → replies/escalations/errors counts, intent distribution, avg confidence, cost sum + daily cost series from `ai_reply_events`.
  - `tenant_weekly_digest(p_tenant_id)` → the digest jsonb (sends/replies/opens/clicks/bounces last 7d by channel + top journey by enrollments).
- [ ] **Step 2:** Dev verification with existing dev data (real numbers exist from weeks of testing); sanity: no division by zero on empty tenants. Commit.

### Task 4: Digest cron

- [ ] **Step 1:** Migration (both): `send_weekly_digests()` — loop tenants with `config->>'digest_slack_webhook_url'`, build text from `tenant_weekly_digest`, post via `net.http_post` → `notify-operator` (which already validates hooks.slack.com); cron `weekly-digest` Mondays 13:00 UTC, idempotent schedule block. Grants.
- [ ] **Step 2:** Dev: set a test webhook on tenant 1, run `send_weekly_digests()` manually, confirm Slack message; unset. Commit.

### Task 5: Dashboard UI

- [ ] **Step 1:** Journey report view (route or drawer from `/journeys`): version funnel table + weekly enrollment sparkline + open/click rates, reading `journey_report` via a thin API route. Follow the journeys page's existing data-fetch pattern.
- [ ] **Step 2:** AI Agents page: "Analytics" tab per agent rendering `ai_agent_report` (counts, intent bars, cost trend).
- [ ] **Step 3:** Settings: tenant toggles for `click_tracking` + digest webhook URL field.
- [ ] **Step 4:** `npm test` + eslint green; manual smoke via `npm run dev` on dev project. Commit.

### Task 6: Close-out

- [ ] Cross-env drift-check `--compare` PASS; advisors clean on both; error_logs clean 24h on both; test data purged from dev; decision record `docs/decisions/009-client-reporting.md` (tracking token design, dedupe window, digest schedule, drift parity check); memory/PRD updated. Commit.

## Known Risks

1. **Open-rate inflation** (Apple MPP prefetch): label the metric "opens (incl. auto-loads)" in UI copy.
2. **Link rewriting can break DKIM-adjacent heuristics / spam scoring** — that's why it's opt-in per tenant and skips unsubscribe links; monitor bounce classification for a week after enabling for any tenant.
3. **Tracker endpoint is public by design** — hmac prevents forgery; RPC never trusts the URL param for anything but storage/redirect, and redirect validates scheme.
4. **Two-project discipline is new** — every task says "both projects"; the Task 0 compare is the net that catches a missed apply.
