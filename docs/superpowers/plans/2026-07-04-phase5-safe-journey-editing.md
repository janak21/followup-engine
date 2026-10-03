# Phase 5: Safe Journey Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editing a live journey becomes safe: steps get stable identities (`sid`) so deleting/reordering can't silently re-point in-flight leads, and journeys gain draft → publish semantics so edits never hit running leads until explicitly published (with a running-run count in the confirm step).

**Architecture:** Three layers, no breaking spec change. (1) `sid`: every step carries a stable random id; `on_outcome` edges carry `next_sid` alongside the legacy `next_step` index; `advance_journey` resolves by sid first, index fallback — old specs keep working untouched. Step indexes become an immutable allocation in the builder (new step = max+1, never renumber). (2) Draft/publish: `journeys.draft_spec` holds edits; Save writes only the draft; a `publish_journey_draft` RPC atomically copies draft→spec, bumps `version`, and appends an audit row to `journey_versions`. The engine reads `spec` everywhere — zero engine changes for publishing. (3) Guardrails: publish returns the journey's running-run count for a confirm dialog, and the journeys API's silent mock-DB fallback is removed from write paths (a "successful" save that went to a mock is how edits get lost).

**Tech Stack:** Supabase Postgres 17 (plpgsql), Next.js dashboard (JS), `node --test`.

---

## Environment & Working Agreements

- **Repo:** `<repo-root>` (branch `main`). Only `git add` files named in each commit step.
- **Migrations:** file in `supabase/migrations/` + apply identical SQL to dev `your-project-ref` via MCP `apply_migration`. Verify with `execute_sql`.
- **JS tests:** `cd dashboard && npm test`.
- **Dev-data caution:** synthetic wait→exit journeys and `*.invalid` leads only; clean up per task.

## Hard Rules (each violation caused a production bug in Phases 1-4)

1. **Never `CREATE OR REPLACE` a function without first diffing the DEPLOYED body** against the repo's newest version (Task 0).
2. **Never introduce a function overload** — replace exact signatures.
3. **Verify every column a function writes exists.**
4. **Every new/replaced function gets the grants block.**

## Cross-Plan Dependency Warning

Phase 3 (triggers, deferred) adds a DB trigger on `journeys` that syncs `journey_triggers` from `spec` on save. It composes cleanly with this plan (publish updates `spec` → sync fires; draft saves touch only `draft_spec` → no sync, which is correct). Phase 2 Task 8 (decommission) is still pending and unrelated. As always: whichever plan executes later re-runs its Task 0 against the then-deployed bodies.

## Locked Design Decisions

1. **`sid` format:** 8 lowercase hex chars, generated in the builder (`crypto` if available, `Math.random` fallback), assigned once — on load for legacy steps, at creation for new ones. Labels/indexes never derive sids.
2. **Edges carry both pointers.** The builder writes `on_outcome[o] = { next_sid, next_step }` (or `{ exit }`). `next_step` stays authoritative for legacy engines/tests; `next_sid` wins at runtime when both exist and disagree (that disagreement is exactly the delete/renumber bug this phase kills).
3. **Index allocation becomes immutable in the builder:** deleting a step never renumbers survivors; a new step's index = `max(existing indexes) + 1`. `current_step`, `actions.step_index`, funnels, and executions keep meaning what they meant.
4. **Draft/publish is one row per journey.** `draft_spec` (nullable) + `draft_updated_at` on `journeys`; publishing copies draft→spec, `version = version + 1`, clears the draft, and appends `(journey_id, version, spec)` to `journey_versions` (audit/rollback substrate — rollback UI is out of scope). The `unique(tenant_id, journey_key, version)` constraint is satisfied because the row's version strictly increases.
5. **Enrollment and advancement read `spec` only.** A journey with only a draft (never published) has `spec` = last published state; brand-new journeys publish their first version on creation (POST keeps writing `spec` directly, version 1).
6. **Publish gate:** client blocks publish when `validateJourneySpec` status is `invalid`; the RPC independently enforces structural sanity (non-empty steps array, resolvable `trigger_next_step`) — the DB never trusts the client.
7. **Mock-DB fallback removed from journeys write paths** (PUT + publish). Reads may keep it. A write that silently lands in a mock and returns 200 is data loss.
8. **Out of scope:** rollback UI, spec diffing UI, multi-version concurrent publishing, converting `wait.on_passed_step` / goal `goto_step` to sids (they stay index-based; indexes are now immutable so they are stable too).

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260708090000_journey_draft_publish.sql` | Create: draft columns, journey_versions, publish RPC |
| `supabase/migrations/20260708091000_advance_journey_sid_resolution.sql` | Create: sid-first next-step resolution |
| `dashboard/src/lib/journeySpecIdentity.js` | Create: `ensureStepSids`, `allocateStepIndex`, `resolveStepBySid` helpers |
| `dashboard/tests/journey-spec-identity.test.mjs` | Create: helper tests |
| `dashboard/src/app/journeys/builder/page.jsx` | Modify: sid assignment, immutable indexes, dual-pointer edges, Save-as-draft + Publish UX |
| `dashboard/src/app/api/journeys/route.js` | Modify: PUT writes draft_spec; mock fallback removed from writes |
| `dashboard/src/app/api/journeys/[id]/publish/route.js` | Create: publish + discard endpoints |
| `dashboard/src/app/journeys/page.jsx` | Modify: "Draft" badge on journeys with unpublished changes |
| `docs/decisions/006-safe-journey-editing.md` | Create: decision record |

---

### Task 0: Preflight — deployed-vs-repo diff (mandatory)

- [ ] **Step 1:** Diff deployed vs repo for `advance_journey` (Phase 4 may not have touched it, but Phase 2's leadless version is the expected base — confirm). Reconcile drift before Task 2.
- [ ] **Step 2:** Confirm no OTHER writer of `journeys.spec` exists besides the dashboard POST/PUT (`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?journeys'`). Record any hits — each must be reviewed for draft-vs-spec correctness (e.g., `ensure_journey_webhook_token` writes token columns only — fine).
- [ ] **Step 3:** Confirm which builder save path(s) call PUT `/api/journeys` (grep `method: "PUT"` / `fetch("/api/journeys"` in `builder/page.jsx`) and record the payload shape (`{ id, journey_key, name, spec, active }`).

---

### Task 1: Draft/publish schema + RPC

**Files:**
- Create: `supabase/migrations/20260708090000_journey_draft_publish.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 5: draft/publish for journeys. Edits land in draft_spec; the engine
-- reads spec only. Publishing is atomic: copy, bump version, audit, clear.

alter table public.journeys
  add column if not exists draft_spec jsonb,
  add column if not exists draft_updated_at timestamptz;

create table if not exists public.journey_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  version integer not null,
  spec jsonb not null,
  published_at timestamptz not null default now(),
  published_by uuid,
  unique (journey_id, version)
);

alter table public.journey_versions enable row level security;
create policy "service role full access on journey_versions"
  on public.journey_versions for all using (auth.role() = 'service_role');

create or replace function public.publish_journey_draft(
  p_journey_id uuid,
  p_tenant_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_journey public.journeys%rowtype;
  v_new_version integer;
  v_running integer;
  v_trigger_next text;
begin
  select * into v_journey
    from public.journeys
   where id = p_journey_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_journey.draft_spec is null then
    return jsonb_build_object('status', 'no_draft');
  end if;

  -- Structural gate — the DB never trusts the client's validation.
  if jsonb_typeof(v_journey.draft_spec -> 'steps') <> 'array'
     or jsonb_array_length(v_journey.draft_spec -> 'steps') = 0 then
    return jsonb_build_object('status', 'invalid_draft', 'reason', 'no_steps');
  end if;
  v_trigger_next := coalesce(v_journey.draft_spec ->> 'trigger_next_step',
                             v_journey.draft_spec ->> 'triggerNextStep');
  if v_trigger_next is null or not exists (
    select 1 from jsonb_array_elements(v_journey.draft_spec -> 'steps') s
     where (s ->> 'index')::integer = v_trigger_next::integer
  ) then
    return jsonb_build_object('status', 'invalid_draft', 'reason', 'unresolvable_start_step');
  end if;

  v_new_version := v_journey.version + 1;

  update public.journeys
     set spec = v_journey.draft_spec,
         version = v_new_version,
         draft_spec = null,
         draft_updated_at = null
   where id = p_journey_id;

  insert into public.journey_versions (tenant_id, journey_id, version, spec, published_by)
  values (p_tenant_id, p_journey_id, v_new_version, v_journey.draft_spec, p_actor);

  select count(*) into v_running
    from public.journey_runs
   where journey_id = p_journey_id and status = 'running';

  return jsonb_build_object(
    'status', 'published',
    'version', v_new_version,
    'running_runs', v_running
  );
end;
$$;

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'publish_journey_draft'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
```

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `journey_draft_publish`).

- [ ] **Step 3: Verify:** create a synthetic journey; `update journeys set draft_spec = spec || '{"phase5":"draft"}'::jsonb where journey_key='<it>'`; call `publish_journey_draft(<id>, <tenant>)` → `status='published'`, `version` bumped, `spec` contains the marker, `draft_spec` null, one `journey_versions` row. Call again → `no_draft`. Set a draft with `"steps": []` → `invalid_draft/no_steps`. Clean up.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260708090000_journey_draft_publish.sql
git commit -m "feat(engine): journey draft/publish with version audit trail"
```

---

### Task 2: `advance_journey` resolves edges by sid first

**Files:**
- Create: `supabase/migrations/20260708091000_advance_journey_sid_resolution.sql`

- [ ] **Step 1: Write the migration.** Full replacement (base = Task 0 reconciled body). Two localized changes:

**Change A** — replace the next-index extraction + lookup block:

```sql
  v_next_index := nullif(v_current_step -> 'on_outcome' -> p_outcome ->> 'next_step', '')::integer;
```

with:

```sql
  -- PHASE5: stable step identity. next_sid wins when present; the index is
  -- the legacy pointer and the tiebreaker for specs that predate sids.
  v_next_sid := nullif(v_current_step -> 'on_outcome' -> p_outcome ->> 'next_sid', '');
  v_next_index := nullif(v_current_step -> 'on_outcome' -> p_outcome ->> 'next_step', '')::integer;

  if v_next_sid is not null then
    select (s ->> 'index')::integer into v_sid_index
      from jsonb_array_elements(v_steps) s
     where s ->> 'sid' = v_next_sid
     limit 1;
    if v_sid_index is not null then
      v_next_index := v_sid_index;
    end if;
    -- sid set but absent from the spec: fall back to the index pointer;
    -- if that also fails the existing missing-step handling completes the run.
  end if;
```

(declare `v_next_sid text; v_sid_index integer;`)

**Change B** — the current-step lookup gains a sid path: where the function locates `v_current_step` by `v_action.step_index`, prefer the sid recorded on the action's snapshot when available:

```sql
  select s into v_current_step
    from jsonb_array_elements(v_steps) s
   where (v_action.payload -> 'step_spec' ->> 'sid' is not null
          and s ->> 'sid' = v_action.payload -> 'step_spec' ->> 'sid')
      or ((v_action.payload -> 'step_spec' ->> 'sid' is null)
          and (s ->> 'index')::integer = v_action.step_index)
   limit 1;
```

Everything else byte-identical; grants block.

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `advance_journey_sid_resolution`).

- [ ] **Step 3: Verify the exact bug this kills:** synthetic journey with steps `0(wait) → 1(wait, sid 'aaaa1111') → exit` where step 0's edge is `{ next_sid: 'aaaa1111', next_step: 99 }` (deliberately wrong index, as after a renumber). Enroll a throwaway lead, flush twice → run `completed` with `current_step = 1` — the sid pointer overrode the broken index. Control: same spec without `next_sid` → run completes immediately at step 0 (missing-step handling), proving the legacy path unchanged. Clean up.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260708091000_advance_journey_sid_resolution.sql
git commit -m "feat(engine): advance_journey resolves edges by stable sid, index fallback"
```

---

### Task 3: Spec identity helpers (TDD) + builder wiring

**Files:**
- Create: `dashboard/src/lib/journeySpecIdentity.js`, `dashboard/tests/journey-spec-identity.test.mjs`
- Modify: `dashboard/src/app/journeys/builder/page.jsx`

- [ ] **Step 1: Failing tests first** (`journey-spec-identity.test.mjs`):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { ensureStepSids, allocateStepIndex } from "../src/lib/journeySpecIdentity.js";

test("ensureStepSids assigns sids only to steps lacking one, and keeps them stable", () => {
  const steps = [{ index: 0, type: "wait" }, { index: 1, type: "sms", sid: "aaaa1111" }];
  const out = ensureStepSids(steps);
  assert.match(out[0].sid, /^[0-9a-f]{8}$/);
  assert.equal(out[1].sid, "aaaa1111");
  const again = ensureStepSids(out);
  assert.equal(again[0].sid, out[0].sid);
});

test("ensureStepSids never assigns duplicate sids", () => {
  const steps = Array.from({ length: 50 }, (_, i) => ({ index: i, type: "wait" }));
  const sids = ensureStepSids(steps).map((s) => s.sid);
  assert.equal(new Set(sids).size, 50);
});

test("allocateStepIndex returns max+1 and never reuses gaps", () => {
  assert.equal(allocateStepIndex([{ index: 0 }, { index: 4 }]), 5);
  assert.equal(allocateStepIndex([]), 0);
});
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement**

```js
// Stable step identity for journey specs.
// sid: assigned once, never derived from position — the runtime resolves
// on_outcome edges by sid first (advance_journey, Phase 5), so deleting or
// reordering steps can no longer re-point in-flight leads.

function randomSid(taken) {
  let sid;
  do {
    sid = Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  } while (taken.has(sid));
  return sid;
}

export function ensureStepSids(steps = []) {
  const taken = new Set(steps.map((s) => s?.sid).filter(Boolean));
  return steps.map((step) => {
    if (step?.sid) return step;
    const sid = randomSid(taken);
    taken.add(sid);
    return { ...step, sid };
  });
}

export function allocateStepIndex(steps = []) {
  if (!steps.length) return 0;
  return Math.max(...steps.map((s) => Number(s?.index) || 0)) + 1;
}

export function stepBySid(steps = [], sid) {
  if (!sid) return null;
  return steps.find((s) => s?.sid === sid) || null;
}
```

Run → PASS.

- [ ] **Step 3: Builder wiring** in `builder/page.jsx` (payload shape recorded in Task 0 Step 3):
  1. On journey load (where `spec.steps` is read into state): `steps = ensureStepSids(loadedSteps)`.
  2. On add-step: index from `allocateStepIndex(steps)` (replace any `steps.length`-based or renumbering logic — grep for where new step indexes are computed and where deletes compact indexes; deletion must ONLY remove the step and clear edges pointing at it, never renumber).
  3. On connecting an edge (where `on_outcome[outcome] = { next_step }` is written): also write `next_sid: targetStep.sid`.
  4. On save: steps serialize with their sids (no stripping).

- [ ] **Step 4:** `npm test` green; `npx eslint` on the touched files clean. Manual smoke: `npm run dev`, open a journey, add + connect + delete a middle step, save, and confirm in the saved spec (SQL: `select spec from journeys where ...`) that surviving indexes did NOT renumber and edges carry `next_sid`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/journeySpecIdentity.js dashboard/tests/journey-spec-identity.test.mjs dashboard/src/app/journeys/builder/page.jsx
git commit -m "feat(builder): stable step sids, immutable index allocation, dual-pointer edges"
```

---

### Task 4: Save-as-draft + publish UX (and kill the silent mock fallback)

**Files:**
- Create: `dashboard/src/app/api/journeys/[id]/publish/route.js`
- Modify: `dashboard/src/app/api/journeys/route.js`, `dashboard/src/app/journeys/builder/page.jsx`, `dashboard/src/app/journeys/page.jsx`

- [ ] **Step 1: PUT saves drafts.** In `route.js` PUT: when the body contains `spec`, write it to `draft_spec` + `draft_updated_at: new Date().toISOString()` instead of `spec` (name/active/ai_agent_id keep updating directly — they are not versioned). **Remove the mock-DB fallback from PUT**: on Supabase error return 500 with the error message (the current fallback returns 200 after writing to a mock — that is silent data loss; Task 0 recorded this at `route.js` PUT error branch).

- [ ] **Step 2: Publish endpoint** (`[id]/publish/route.js`, complete):

```js
import { NextResponse } from "next/server";
import { requireOperator } from "@/utils/role";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";

export async function POST(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { data, error } = await supabase.rpc("publish_journey_draft", {
      p_journey_id: id,
      p_tenant_id: tenantId,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (data?.status !== "published") {
      return NextResponse.json({ error: data?.status || "publish_failed", detail: data }, { status: 409 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}

// Discard the draft.
export async function DELETE(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { error } = await supabase
      .from("journeys")
      .update({ draft_spec: null, draft_updated_at: null })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: { discarded: true } });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Builder UX:** header gains `Publish` (primary) next to Save; Save toast becomes "Draft saved — not live yet" when a spec change was saved; Publish is disabled while `validateJourneySpec(...).status === 'invalid'` (surface the blocking errors); on click, call the publish endpoint and show a confirm-style toast/dialog with `running_runs` from the response ("Published v{version}. {n} lead(s) currently running will use the new version on their next step."). A `Discard draft` action calls DELETE. When loading the builder, prefer `draft_spec` over `spec` for editing (fall back to `spec` when no draft).

- [ ] **Step 4: Journeys list:** show a small `Draft` badge when `draft_spec` is non-null (GET already returns the row; include `draft_updated_at` in the list payload).

- [ ] **Step 5: Verify live:** in the dev dashboard — edit a synthetic journey, Save (SQL: `draft_spec` set, `spec` unchanged, engine still enrolls old spec), Publish (spec updated, version bumped, `journey_versions` row, badge clears), Discard path, and PUT with Supabase intentionally erroring (temporarily bad column in the update object) returns 500 — not a fake 200.

- [ ] **Step 6:** `npm test` green; commit all four files.

```bash
git commit -m "feat(builder): save-as-draft + publish with running-run confirm; no silent mock writes"
```

---

### Task 5: E2E + decision record

- [ ] **Step 1: The full scenario the phase exists for:** synthetic 3-step journey (wait0 → wait1 → wait2 → exit), enroll lead A, let it reach step 1's wait (long duration so it parks). Edit the draft: delete step 2, add a replacement step (new index = 3 per immutable allocation), reconnect step 1 → new step via sid edge. Publish. Flush the dispatcher: lead A's parked action completes and the run advances to the NEW step 3 by sid — no misrouting, no completion-by-missing-step. Verify `journey_versions` has both versions. Clean up.
- [ ] **Step 2:** `error_logs` clean for 15 min; advisors no ERROR-level; zero test rows left.
- [ ] **Step 3:** `docs/decisions/006-safe-journey-editing.md`:

```markdown
# 006 — Safe journey editing (Phase 5)

**Date:** (execution date)
**Status:** Accepted

## Decision
Steps carry stable sids; on_outcome edges store next_sid + legacy next_step;
advance_journey resolves sid-first. Builder never renumbers indexes
(allocation = max+1). journeys.draft_spec holds edits; publish_journey_draft
atomically promotes draft -> spec, bumps version, and appends to
journey_versions. Engine reads spec only. Mock-DB fallback removed from
journey write paths.

## Deferred
- Rollback UI over journey_versions; spec diff view; sid pointers for
  wait.on_passed_step / goal goto_step (safe now that indexes are immutable)
```

- [ ] **Step 4: Commit** the record.

---

## Post-Plan Checklist

- [ ] `npm test` fully green; advisors clean; error_logs clean over 24h; test data purged
- [ ] **Phase 2 Task 8 (decommission) — STILL PENDING as of 2026-07-04 morning** (3 cron jobs, no archived table; drain has been zero since 2026-07-03). Its gate has passed; execute it or explicitly decide to keep the old machinery
- [ ] Memory/PRD updated

## Known Risks

1. **Builder renumbering hunts** — the monolithic `builder/page.jsx` may compute indexes in more than one place (add-step, paste/duplicate, sync-from-canvas). Task 3 Step 3.2's grep must cover ALL of them; a single missed site quietly reintroduces renumbering and the sid layer masks it until specs disagree. The Task 5 E2E (delete-middle-step) is the canary.
2. **Draft semantics for `webhook_mapping`/trigger config** — those live inside `spec` too, so webhook mapping changes now also wait for publish. That is correct-but-surprising; the "Draft saved — not live yet" toast is the mitigation. Document in /docs.
3. **`journey_versions` growth** — one row per publish, tiny; no pruning needed below thousands of publishes.
4. **Concurrent editors** — last-writer-wins on `draft_spec` (same as today's `spec`). Real locking is out of scope; the `draft_updated_at` timestamp enables a cheap "draft changed since you loaded" warning later.
