# Phase 6: Multi-Run Operations & Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-enrollment operable: every run of a lead is visible and controllable (pause / resume / cancel) from the lead drawer, journeys get a pause switch, and stop-on-reply becomes a per-journey policy so a reply to one journey no longer silently kills another journey's sends.

**Architecture:** Run state gains one non-terminal status (`paused`). The dispatch guard learns the difference between *terminal* runs (cancel the action permanently — current behavior) and *held* runs (paused run or paused journey → defer 15 minutes, never cancel). Per-journey `spec.stop_on_reply` (`'stop'` default = today's behavior; `'continue'` = this journey ignores replies) is enforced at both places that make replies fatal today: the engagement cancel (skips continue-runs' actions) and `should_dispatch`'s `lead_responded` block (exempts continue-runs). The dashboard gets a runs API + per-run controls in the lead drawer. The legacy lead mirror columns stay untouched (additive UI only).

**Tech Stack:** Supabase Postgres 17 (plpgsql), Next.js dashboard (JS), `node --test`.

---

## Environment & Working Agreements

- **Repo:** `<repo-root>` (branch `main`). Only `git add` files named in each commit step.
- **Migrations:** file in `supabase/migrations/` + apply identical SQL to dev `your-project-ref` via MCP `apply_migration`. Verify with `execute_sql`.
- **JS tests:** `cd dashboard && npm test`.
- **Dev-data caution:** synthetic wait→exit journeys and `*.invalid` leads only; clean up per task. The stop-on-reply E2E injects replies via `process_inbound_sms` directly — confirm `tenants.ai_replies_enabled = false` on the test tenant first.

## Hard Rules (violations caused production bugs in Phases 1-5)

1. **Never `CREATE OR REPLACE` a function without first diffing the DEPLOYED body** against the repo's newest version (Task 0).
2. **Never introduce a function overload** — replace exact signatures.
3. **Verify every column a function writes exists.**
4. **Every new/replaced function gets the grants block.**

## Cross-Plan Dependency Warning

Phase 3 (triggers, still deferred) replaces `process_inbound_sms`/`process_inbound_email`; this plan replaces `cancel_pending_on_engagement` and `should_dispatch` (which those processors call — signatures unchanged, so composition is clean). Whichever plan executes later re-runs its Task 0 against the then-deployed bodies.

## Locked Design Decisions

1. **Run status vocabulary gains `paused`.** Terminal stays {completed, failed, cancelled, responded, opted_out}; `paused` is a held state that only `resume_journey_run` leaves.
2. **Guard semantics split:** action whose run is terminal → permanent cancel (`run_not_active`, current behavior). Action whose run is `paused` → defer (`run_paused`, reschedule now()+15min). Action whose run's **journey** is paused (`journeys.paused`) → defer (`journey_paused`). Inline actions still bypass the guard (pre-existing, unchanged) — but pausing also parks the run's pending actions by pushing `run_at` forward, so inline steps hold too (see decision 3).
3. **Pause is belt-and-braces:** `pause_journey_run` sets run `paused` AND bumps its pending actions' `run_at` to `+100 years` (recorded in `result.paused_from_run_at` for exact restore). Resume restores `run_at` (past values snap to now()). The guard deferral is the safety net for anything that slips through, not the primary mechanism — this is what makes pause work for inline steps despite the unguarded inline path.
4. **Journey pause** (`journeys.paused boolean default false`): holds all of its runs' external dispatches via the guard AND blocks new enrollments (`enroll_lead_in_journey` returns `journey_paused`). It does NOT park actions (unpausing a journey must not have to scan every run) — inline steps of a paused journey keep executing; only provider sends hold. Document this asymmetry in the UI copy ("Pauses sends; waits and internal steps continue").
5. **`spec.stop_on_reply`:** `'stop'` (default, current behavior) or `'continue'`. Enforced in: (a) `cancel_pending_on_engagement` — actions belonging to continue-runs are excluded from the cancel and their runs stay `running`; (b) `should_dispatch` — the `lead_responded` block is skipped when the action's run's journey says continue. `opt_out`, suppression, and `callback_requested` remain absolute — continue never overrides those.
6. **Runs API is lead-scoped + run-scoped:** `GET /api/leads/[id]/runs` (all runs, newest first, with journey name/status/step/counts) and `POST /api/runs/[id]` with `{ op: 'pause' | 'resume' | 'cancel' }`. Operator-gated like every mutating route.
7. **Out of scope:** retiring the lead mirror columns, run-level analytics, rollback UI, Phase 3 triggers, bulk run operations (journey pause covers the practical case).

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260709090000_run_controls.sql` | Create: journeys.paused, pause/resume/cancel RPCs, enroll paused-block |
| `supabase/migrations/20260709091000_guard_held_runs.sql` | Create: should_dispatch + guard defer for paused run/journey |
| `supabase/migrations/20260709092000_stop_on_reply_policy.sql` | Create: policy in engagement cancel + should_dispatch |
| `dashboard/src/app/api/leads/[id]/runs/route.js` | Create: runs list |
| `dashboard/src/app/api/runs/[id]/route.js` | Create: pause/resume/cancel |
| `dashboard/src/app/leads/page.jsx` | Modify: enrollments panel in drawer + active-run chip |
| `dashboard/src/app/journeys/page.jsx` | Modify: pause toggle per journey |
| `dashboard/src/app/journeys/builder/page.jsx` | Modify: stop-on-reply select in journey settings |
| `dashboard/src/lib/journeyValidation.js` + tests | Modify: stop_on_reply value check |
| `docs/decisions/007-multi-run-operations.md` | Create: decision record |

---

### Task 0: Preflight — deployed-vs-repo diff (mandatory)

- [ ] **Step 1:** Diff deployed vs repo for `should_dispatch`, `dispatch_guard_external_action`, `cancel_pending_on_engagement`, `enroll_lead_in_journey`. Reconcile drift first. (Expected bases: Phase 4/5-era bodies; `cancel_pending_on_engagement` was last replaced in Phase 1's run-aware guards + Phase 4 may have adjusted goal interplay — take the deployed body.)
- [ ] **Step 2:** Confirm live run-status values (`select distinct status from journey_runs`) — the new code treats anything not in {running, paused} as terminal; verify no unexpected value exists.
- [ ] **Step 3:** Record where the lead drawer fetches lead detail in `leads/page.jsx` (grep `fetch(`/api/leads/`) — the enrollments panel hooks in there.

---

### Task 1: Run controls + journey pause

**Files:**
- Create: `supabase/migrations/20260709090000_run_controls.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 6: per-run pause/resume/cancel + journey-level pause.
-- Pause parks the run's pending actions (run_at += 100 years, original kept
-- in result.paused_from_run_at) AND sets status='paused'; the dispatch guard
-- (20260709091000) is the safety net. Resume restores run_at exactly;
-- past-due restores snap to now().

alter table public.journeys
  add column if not exists paused boolean not null default false;

create or replace function public.pause_journey_run(
  p_run_id uuid,
  p_tenant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_parked integer;
begin
  select * into v_run from public.journey_runs
   where id = p_run_id and tenant_id = p_tenant_id
   for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('status', 'not_running', 'run_status', v_run.status);
  end if;

  update public.journey_runs set status = 'paused' where id = p_run_id;

  with parked as (
    update public.actions
       set result = coalesce(result, '{}'::jsonb)
                    || jsonb_build_object('paused_from_run_at', run_at),
           run_at = run_at + interval '100 years',
           locked_until = null,
           locked_by = null
     where run_id = p_run_id
       and status = 'pending'
     returning id
  )
  select count(*)::integer into v_parked from parked;

  return jsonb_build_object('status', 'paused', 'parked_actions', v_parked);
end;
$$;

create or replace function public.resume_journey_run(
  p_run_id uuid,
  p_tenant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_restored integer;
begin
  select * into v_run from public.journey_runs
   where id = p_run_id and tenant_id = p_tenant_id
   for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_run.status <> 'paused' then
    return jsonb_build_object('status', 'not_paused', 'run_status', v_run.status);
  end if;

  update public.journey_runs set status = 'running' where id = p_run_id;

  with restored as (
    update public.actions
       set run_at = greatest(now(), (result ->> 'paused_from_run_at')::timestamptz),
           result = result - 'paused_from_run_at'
     where run_id = p_run_id
       and status = 'pending'
       and result ? 'paused_from_run_at'
     returning id
  )
  select count(*)::integer into v_restored from restored;

  return jsonb_build_object('status', 'running', 'restored_actions', v_restored);
end;
$$;

create or replace function public.cancel_journey_run(
  p_run_id uuid,
  p_tenant_id uuid,
  p_reason text default 'cancelled_by_operator'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_cancelled integer;
begin
  select * into v_run from public.journey_runs
   where id = p_run_id and tenant_id = p_tenant_id
   for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_run.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'already_terminal', 'run_status', v_run.status);
  end if;

  update public.journey_runs
     set status = 'cancelled',
         completed_at = coalesce(completed_at, now()),
         last_error = p_reason
   where id = p_run_id;

  with cancelled as (
    update public.actions
       set status = 'cancelled',
           error_message = p_reason,
           locked_until = null,
           locked_by = null
     where run_id = p_run_id
       and status in ('pending', 'in_progress')
     returning id
  )
  select count(*)::integer into v_cancelled from cancelled;

  return jsonb_build_object('status', 'cancelled', 'cancelled_actions', v_cancelled);
end;
$$;
```

Plus `enroll_lead_in_journey` full replacement (base = Task 0 reconciled) with one insertion after the journey lookup succeeds:

```sql
  if coalesce(v_journey.paused, false) then
    return jsonb_build_object('status', 'journey_paused');
  end if;
```

Grants blocks for all four functions.

- [ ] **Step 2: Apply to dev**; verify with a synthetic running run: pause → status `paused`, pending action's `run_at` a century out with `paused_from_run_at` stamped; resume → `running`, `run_at` restored (snapped to now if past); cancel → run `cancelled` + actions cancelled. Enroll into a `paused=true` journey → `journey_paused`. Clean up.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260709090000_run_controls.sql
git commit -m "feat(engine): run pause/resume/cancel + journey pause switch"
```

---

### Task 2: Guard distinguishes held runs from dead runs

**Files:**
- Create: `supabase/migrations/20260709091000_guard_held_runs.sql`

- [ ] **Step 1: Write the migration.** Full replacements (bases = Task 0 reconciled):

**`should_dispatch`** — replace the Phase-1 run check block:

```sql
  if v_action.run_id is not null then
    select r.status, coalesce(j.paused, false)
      into v_run_status, v_journey_paused
      from journey_runs r
      left join journeys j on j.id = r.journey_id
     where r.id = v_action.run_id;
    if v_run_status is not null then
      if v_run_status = 'paused' then
        return query select false, 'run_paused', now() + interval '15 minutes';
        return;
      elsif v_run_status <> 'running' then
        return query select false, 'run_not_active', null::timestamptz;
        return;
      elsif v_journey_paused then
        return query select false, 'journey_paused', now() + interval '15 minutes';
        return;
      end if;
    end if;
  end if;
```

(declare `v_journey_paused boolean;` — `v_run_status` exists.) A non-null `reschedule_to` routes these through the guard's existing *reschedule* branch, so held actions are deferred, never cancelled — no guard change needed for that path. `run_not_active` stays in the permanent list for terminal runs only, which this ordering guarantees.

**Note on `should_dispatch` evolving twice:** Task 3 also modifies this function. The sequence is deliberate and safe: Task 2's migration contains ONLY the held-run logic; Task 3's migration re-replaces the whole function using **Task 2's committed body as its base** (same single-function-evolution pattern used across phases — each migration is a complete replacement, applied in order).

- [ ] **Step 2: Apply; verify:** pending email action on a paused run → `should_dispatch` returns `run_paused` with a reschedule time; flush → action still `pending` with bumped `run_at` + `last_skip_reason='run_paused'` (not cancelled). Same for `journey_paused` via the journeys.paused flag. Terminal-run action still cancels with `run_not_active`. Clean up.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260709091000_guard_held_runs.sql
git commit -m "feat(engine): dispatch guard defers paused runs/journeys instead of cancelling"
```

---

### Task 3: Per-journey stop-on-reply policy

**Files:**
- Create: `supabase/migrations/20260709092000_stop_on_reply_policy.sql`
- Modify: `dashboard/src/lib/journeyValidation.js`, `dashboard/tests/journey-validation.test.mjs`, `dashboard/src/app/journeys/builder/page.jsx`

- [ ] **Step 1 (SQL):** two full replacements (bases: `cancel_pending_on_engagement` from Task 0; `should_dispatch` from Task 2's committed body):

**`cancel_pending_on_engagement`** — the cancel CTE gains an exclusion, and the run-responded update inherits it. Replace the `with cancelled as (...)` predicate additions:

```sql
     where lead_id    = p_lead_id
       and status     = 'pending'
       and action_type not in ('team_alert','wait_reply')
       and (p_source_action_id is null or id <> p_source_action_id)
       -- PHASE6: runs whose journey opts out of stop-on-reply keep their work.
       and not exists (
         select 1
           from journey_runs r
           join journeys j on j.id = r.journey_id
          where r.id = actions.run_id
            and coalesce(j.spec ->> 'stop_on_reply', 'stop') = 'continue'
       )
```

(The follow-up `update journey_runs ... set status='responded'` already keys off the cancelled ids, so continue-runs are automatically spared.)

**`should_dispatch`** — the `lead_responded` block becomes policy-aware:

```sql
  if v_lead.responded and v_action.action_type <> 'team_alert' then
    -- PHASE6: journeys with stop_on_reply='continue' keep sending after a
    -- reply. opt_out/suppression/callback checks below remain absolute.
    if not (
      v_action.run_id is not null and exists (
        select 1 from journey_runs r
          join journeys j on j.id = r.journey_id
         where r.id = v_action.run_id
           and coalesce(j.spec ->> 'stop_on_reply', 'stop') = 'continue'
      )
    ) then
      return query select false, 'lead_responded', null::timestamptz;
      return;
    end if;
  end if;
```

Grants blocks; same signatures.

- [ ] **Step 2 (validation, TDD):** failing test → implement → pass:

```js
test("stop_on_reply accepts stop/continue and rejects unknown values", () => {
  const ok = validateJourneySpec({ stop_on_reply: "continue", steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }], triggerNextStep: 0 });
  assert.ok(!ok.checks.some((c) => c.title.includes("stop_on_reply")));
  const bad = validateJourneySpec({ stop_on_reply: "sometimes", steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }], triggerNextStep: 0 });
  assert.equal(bad.status, "invalid");
});
```

Implementation in `validateJourneySpec`: if `spec.stop_on_reply` present and not in `{stop, continue}` → error check titled "stop_on_reply must be 'stop' or 'continue'.".

- [ ] **Step 3 (builder):** journey settings panel gains a "When the lead replies" select — "Stop this journey (recommended)" / "Keep going" — writing `spec.stop_on_reply` (omit when 'stop' to keep specs lean).

- [ ] **Step 4 (verify live — the multi-run scenario this phase exists for):** tenant with `ai_replies_enabled=false`. Two synthetic journeys: `p6_stop` (default) and `p6_continue` (`stop_on_reply: 'continue'`), both wait(0)→wait(6h)→exit so both runs park at a pending long wait. Enroll ONE throwaway lead (with a phone the tenant's `resolve_tenant_by_phone` resolves) in both. Inject a reply: `select process_inbound_sms('<lead phone>', '<tenant number>', 'yes interested', 'SM_p6_test');`. Expected: `p6_stop` run → `responded`, its pending wait cancelled; `p6_continue` run → still `running`, its pending wait still `pending`; `should_dispatch` on a hypothetical send action for the continue-run returns `can_dispatch=true` despite `lead.responded=true`. Clean up fully (lead, runs, actions, events, error_log info rows ok to leave).

- [ ] **Step 5:** `npm test` green; commit (migration + 3 dashboard files).

```bash
git commit -m "feat(engine): per-journey stop-on-reply policy — continue-journeys survive replies"
```

---

### Task 4: Runs API

**Files:**
- Create: `dashboard/src/app/api/leads/[id]/runs/route.js`, `dashboard/src/app/api/runs/[id]/route.js`

- [ ] **Step 1:** `GET /api/leads/[id]/runs` (complete):

```js
import { NextResponse } from "next/server";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { data: runs, error } = await supabase
      .from("journey_runs")
      .select("id, journey_id, journey_key, status, current_step, next_action_at, trigger_type, created_at, completed_at")
      .eq("tenant_id", tenantId)
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const journeyIds = [...new Set((runs || []).map((r) => r.journey_id).filter(Boolean))];
    let namesById = {};
    if (journeyIds.length > 0) {
      const { data: journeys } = await supabase
        .from("journeys").select("id, name, paused").in("id", journeyIds);
      namesById = Object.fromEntries((journeys || []).map((j) => [j.id, j]));
    }
    return NextResponse.json({
      data: (runs || []).map((r) => ({
        ...r,
        journey_name: namesById[r.journey_id]?.name || r.journey_key,
        journey_paused: namesById[r.journey_id]?.paused || false,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}
```

- [ ] **Step 2:** `POST /api/runs/[id]` (complete):

```js
import { NextResponse } from "next/server";
import { requireOperator } from "@/utils/role";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";

const OPS = {
  pause: "pause_journey_run",
  resume: "resume_journey_run",
  cancel: "cancel_journey_run",
};

export async function POST(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  try {
    const { id } = await params;
    const { op } = await request.json();
    const rpc = OPS[op];
    if (!rpc) return NextResponse.json({ error: `op must be one of ${Object.keys(OPS).join(", ")}` }, { status: 400 });
    const tenantId = await getTenantId(request);
    const { data, error } = await supabase.rpc(rpc, { p_run_id: id, p_tenant_id: tenantId });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const okStatuses = { pause: "paused", resume: "running", cancel: "cancelled" };
    if (data?.status !== okStatuses[op]) {
      return NextResponse.json({ error: data?.status || "failed", detail: data }, { status: 409 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}
```

- [ ] **Step 3:** exercise both endpoints against dev (`curl` or the dashboard once Task 5 lands); commit.

```bash
git add "dashboard/src/app/api/leads/[id]/runs/route.js" "dashboard/src/app/api/runs/[id]/route.js"
git commit -m "feat(dashboard): runs API — list per lead, pause/resume/cancel per run"
```

---

### Task 5: UI — enrollments panel, run chip, journey pause toggle

**Files:**
- Modify: `dashboard/src/app/leads/page.jsx`, `dashboard/src/app/journeys/page.jsx`

- [ ] **Step 1 (lead drawer):** at the drawer's lead-detail fetch site (recorded in Task 0 Step 3), also fetch `/api/leads/[id]/runs`; render an "Enrollments" section above/next to the timeline: per run — journey name, status pill (running=green, paused=amber, responded=blue, completed=zinc, failed/cancelled=red), current step, started date, and buttons Pause/Resume (toggled by status) + Cancel (confirm dialog) calling `POST /api/runs/[id]`; refetch on success. Show `journey_paused` as an amber "journey paused" note on affected runs.
- [ ] **Step 2 (leads list):** the list rows show an active-run count chip when > 1 (data: extend the existing leads list API response with a `running_runs` count — `select lead_id, count(*) from journey_runs where status='running' group by lead_id` merged server-side; keep it out of the hot path if the list API already aggregates per lead — follow its existing metrics pattern, recorded in Task 0 Step 3's grep).
- [ ] **Step 3 (journeys page):** pause toggle per journey row (PATCH via existing journeys PUT with `{ paused }` — extend the PUT handler's allowed fields; `paused` is a direct column like `active`, not versioned). Confirm copy: "Pauses sends for all running leads and blocks new enrollments. Waits/internal steps continue."
- [ ] **Step 4:** manual smoke in `npm run dev`: pause a run → chip flips, action parked (SQL check); resume → restored; cancel → terminal. `npm test` + eslint green; commit.

```bash
git add dashboard/src/app/leads/page.jsx dashboard/src/app/journeys/page.jsx dashboard/src/app/api/journeys/route.js
git commit -m "feat(dashboard): enrollments panel with run controls; journey pause toggle"
```

---

### Task 6: E2E + decision record

- [ ] **Step 1:** Full pause lifecycle through the real cron: synthetic wait(2min)-chain journey, enroll lead, pause mid-wait (via API), confirm two cron ticks pass with the action parked and zero guard cancels; resume; run completes. Then the Task 3 Step 4 stop-on-reply scenario if not already run post-UI.
- [ ] **Step 2:** `error_logs` clean 15 min; advisors no ERROR-level; zero `*.invalid` rows.
- [ ] **Step 3:** `docs/decisions/007-multi-run-operations.md`:

```markdown
# 007 — Multi-run operations (Phase 6)

**Date:** (execution date)
**Status:** Accepted

## Decision
Run status gains 'paused' (held, not terminal). Pause parks pending actions
(run_at +100y, original in result.paused_from_run_at) with the dispatch
guard as safety net (run_paused/journey_paused defer; run_not_active stays
permanent for terminal runs). journeys.paused holds sends + blocks new
enrollments but not inline steps. spec.stop_on_reply ('stop' default |
'continue') is enforced in cancel_pending_on_engagement and should_dispatch's
lead_responded block; opt-out/suppression stay absolute. Lead drawer gets an
enrollments panel with per-run controls via /api/leads/[id]/runs and
/api/runs/[id].

## Deferred
- Retiring the lead mirror columns; bulk run ops; run-level analytics
```

- [ ] **Step 4: Commit** the record.

---

## Post-Plan Checklist

- [ ] `npm test` fully green; advisors clean; error_logs clean over 24h; test data purged
- [ ] `dispatch-workflow-http-request` deployed edge function deleted from the Supabase dashboard (carried over from Phase 2 Task 8 — manual step, still pending unless already done)
- [ ] Memory/PRD updated

## Known Risks

1. **Pause vs wait_reply:** a paused run's pending `wait_reply` action gets parked (+100y), but an inbound reply consumes wait_reply actions via the processors regardless of run_at. A paused run can therefore still advance on a reply. Acceptable this phase (a reply is an explicit lead signal), but document it; a stricter hold is a follow-up.
2. **`stop_on_reply='continue'` + AI auto-replies:** the AI replies to the lead while a continue-journey keeps sending scheduled outreach — potentially awkward sequencing. The builder copy should warn; tenants using continue-journeys with AI replies enabled should route replies via wait_reply branches instead.
3. **100-year parking:** any future query assuming `run_at` is near-term (analytics, "next action" displays) must exclude parked actions (`result ? 'paused_from_run_at'`). The leads list `next_action_at` mirror is set from run state, not parked actions — verify in Task 6 that a paused run shows sensibly in the UI.
4. **Journey pause is not run pause:** inline steps (waits, tags, splits) of a paused journey still execute — only provider sends hold. This is deliberate (cheap unpause) but must be in the toggle's copy, or operators will report "pause doesn't work" when a wait advances.
