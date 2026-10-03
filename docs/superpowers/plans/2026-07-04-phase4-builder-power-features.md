# Phase 4: Builder Power Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the day-to-day GHL gaps inside the journey builder: write SMS/email content directly in the node (template optional), multi-branch If/Else conditions, an A/B percentage split step, and reply-goals (lead replies → run exits or jumps to a chosen step).

**Architecture:** All four features ride the unified engine from Phases 1-2 with no schema changes. Inline content: the payload RPCs already honor `payload.inline.body` (composer path) — they gain a `step_spec.inline_body`/`inline_subject` fallback and the builder gains a "write it here" mode. Multi-branch: `conditional_split` steps optionally carry `branches: [{id, label, condition}]` walked in order with an `else` fallback; node handles and validation become branch-driven for this type. A/B: a new inline `ab_split` action type with a deterministic per-(lead,step) hash pick, so re-runs are stable. Goals: `spec.goals` (replied-goal only this phase) applied inside the inbound processors with an explicit capture→cancel→redirect ordering around the existing engagement cancel.

**Tech Stack:** Supabase Postgres 17 (plpgsql), Next.js dashboard (JS), `node --test`.

---

## Environment & Working Agreements

- **Repo:** `<repo-root>` (branch `main`). Only `git add` files named in each commit step.
- **Migrations:** file in `supabase/migrations/` + apply identical SQL to dev `your-project-ref` via MCP `apply_migration`. Verify via `execute_sql`.
- **JS tests:** `cd dashboard && npm test`.
- **Dev-data caution:** synthetic wait/split→exit journeys and `*.invalid` leads only; clean up per task. Never enroll test data into journeys with live provider steps.

## Hard Rules (violations caused production bugs in Phases 1-2)

1. **Never `CREATE OR REPLACE` a function without first diffing the DEPLOYED body** (`pg_get_functiondef`) against the repo's newest version — Task 0 enforces this for every function replaced here.
2. **Never introduce a function overload** — replace exact signatures.
3. **Verify every column a function writes exists.**
4. **Every new/replaced function gets the grants block** (`revoke ... from public, anon, authenticated; grant ... to service_role;`).

## Cross-Plan Dependency Warning

Phase 3 (trigger system, deferred) also replaces `process_inbound_sms` / `process_inbound_email` and Phase 2 Task 8 (decommission, gated) touches the dispatcher's environment. **Whichever plan executes later MUST re-run its Task 0 reconciliation against the then-deployed bodies** — the Task 0s exist precisely so these plans compose in any order. Phase 4's Task 5 (goals) and Phase 3's Task 4 (firing points) edit the same two processors; executing both means the second one re-bases its insertions on the merged body.

## Locked Design Decisions

1. **Inline content is per-step, template optional.** Step spec gains `content_mode: 'template' | 'inline'` (default `template` for existing steps), `inline_body` (SMS + email), `inline_subject` (email). Validation requires `template_key` OR non-empty `inline_body`. Merge tags work in inline content (the payload RPCs already `render_template()` inline bodies).
2. **Multi-branch spec shape (backward compatible):**
   ```json
   { "type": "conditional_split",
     "branches": [
       { "id": "branch_1", "label": "Hot lead", "condition": { "combinator": "and", "rules": [...] } },
       { "id": "branch_2", "label": "Warm", "condition": { ... } }
     ],
     "on_outcome": { "branch_1": {...}, "branch_2": {...}, "else": {...} } }
   ```
   Branches evaluate in array order; first match wins; no match → outcome `else`. Steps **without** `branches` keep the legacy `condition` + `yes`/`no` contract untouched. Branch ids are stable slugs generated once at creation (`branch_<n>`), never re-derived from labels — labels are display-only.
3. **A/B split:** new step type `ab_split`, spec `{ "split_percent_a": 50 }`, outcomes `a`/`b`. Deterministic assignment: `hashtext(lead_id::text || ':' || step_index::text) % 100 < split_percent_a → 'a'` — a re-fired action lands on the same side (idempotent with the advance guard). Leadless event runs hash `run_id` instead.
4. **Goals, replied-only this phase.** `spec.goals = [{ "id": "goal_1", "event": "replied", "action": "exit" | "goto", "goto_step": <index> }]` (max one replied-goal per journey this phase). Semantics on an inbound reply from a lead: for each of the lead's runs that was `running` at reply time and whose journey has a replied-goal — `exit`: run → `responded` (what engagement-cancel already effectively does, now explicit and per-journey); `goto`: the run's pending actions are already cancelled by engagement-cancel, then the run is flipped back to `running` and the goto step is enqueued immediately. Runs whose journey has no goal keep today's behavior exactly (blanket engagement cancel → run `responded`).
5. **Ordering contract for goals (the subtle part):** inside the inbound processors — (a) capture the lead's `running` run ids BEFORE `cancel_pending_on_engagement`; (b) let the cancel run untouched (safety stays blanket); (c) `apply_journey_goals` afterwards re-activates and redirects only captured runs with a `goto` goal. Goals never suppress the cancel — they redirect after it.
6. **Out of scope:** condition groups nested deeper than one level (rules stay a flat list per branch), goal events other than `replied` (tag/appointment goals need Phase 3's registry), stable step IDs (Phase 5 candidate), draft/publish versioning, per-run stop-on-response.

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260707090000_inline_step_content.sql` | Create: payload RPCs read step_spec inline content |
| `supabase/migrations/20260707091000_multibranch_conditional_split.sql` | Create: branch-walking in the split handler |
| `supabase/migrations/20260707092000_ab_split_step.sql` | Create: handler + dispatcher route |
| `supabase/migrations/20260707093000_reply_goals.sql` | Create: apply_journey_goals + processor wiring |
| `dashboard/src/lib/journeyStepTypes.js` | Modify: ab_split type; conditional_split dynamic outcomes helper |
| `dashboard/src/lib/journeyValidation.js` | Modify: inline-content rule, branch validation, ab_split, goals |
| `dashboard/src/app/journeys/builder/page.jsx` | Modify: inline editor, branch editor, ab_split panel, goals panel, dynamic handles |
| `dashboard/tests/journey-step-types.test.mjs` | Modify: ab_split + dynamic outcomes tests |
| `dashboard/tests/journey-validation.test.mjs` | Modify: inline/branch/goal validation tests |
| `docs/decisions/005-builder-power-features.md` | Create: decision record |

---

### Task 0: Preflight — deployed-vs-repo diff (mandatory)

- [ ] **Step 1:** Diff deployed vs repo for every function this plan replaces: `get_sms_payload`, `get_email_payload`, `process_action_conditional_split`, `dispatch_pending_actions`, `process_inbound_sms`, `process_inbound_email`, `cancel_pending_on_engagement`. Reconcile any drift into a sync migration BEFORE writing Task 1-5 migrations. (If Phase 3 ran in the meantime, the inbound processors contain its `fire_journey_triggers` calls — preserve them.)
- [ ] **Step 2:** Record the deployed `process_action_conditional_split` body — Phase 2 made it dual-mode (lead conditions + event-run payload expressions); Task 2's branch-walk extends THAT body, not the 2026-06-26 backfill version.
- [ ] **Step 3:** Record how `get_email_payload` resolves subject + inline overrides (`payload.inline.*`) — Task 1's fallback chain slots in beside it, never before it (operator/AI inline replies must keep priority over step content).

---

### Task 1: Inline step content (SMS + email)

**Files:**
- Create: `supabase/migrations/20260707090000_inline_step_content.sql`
- Modify: `dashboard/src/lib/journeyValidation.js`, `dashboard/tests/journey-validation.test.mjs`, `dashboard/src/app/journeys/builder/page.jsx`

- [ ] **Step 1 (SQL): resolution order becomes** `payload.inline.body` (composer/AI, unchanged priority) → `payload.step_spec.inline_body` (NEW) → template. In `get_sms_payload` (base = Task 0 reconciled), replace:

```sql
  v_inline_body := v_action.payload->'inline'->>'body';
```

with:

```sql
  -- Inline priority: operator/AI inline reply > step-authored content > template.
  v_inline_body := coalesce(
    nullif(v_action.payload->'inline'->>'body', ''),
    nullif(v_action.payload->'step_spec'->>'inline_body', '')
  );
```

Apply the same pattern in `get_email_payload` for body, and extend its subject resolution with `payload.step_spec->>'inline_subject'` at the same fallback position (after inline overrides, before template subject — exact splice point recorded in Task 0 Step 3). Also relax both RPCs' "Template not found" error to fire only when BOTH inline content and template are absent. Full function bodies in the migration; grants blocks.

- [ ] **Step 2 (validation, TDD):** failing tests first:

```js
test("sms and email steps accept inline content without a template", () => {
  const result = validateJourneySpec({
    steps: [{ index: 0, type: "sms", content_mode: "inline", inline_body: "Hey {{first_name}} — quick question", on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "opted_out" } } }],
    triggerNextStep: 0,
  }, { templates: [] });
  assert.ok(!result.checks.some((c) => c.title.includes("missing a template")));
});

test("sms steps with neither template nor inline body are invalid", () => {
  const result = validateJourneySpec({
    steps: [{ index: 0, type: "sms", content_mode: "inline", inline_body: "", on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "opted_out" } } }],
    triggerNextStep: 0,
  }, { templates: [] });
  assert.equal(result.status, "invalid");
});
```

Run → FAIL. Then in `validateStepConfiguration` replace the template-required check for `TEMPLATE_STEP_TYPES`:

```js
    if (TEMPLATE_STEP_TYPES.has(step.type)) {
      const channel = templateChannelFor(step.type);
      const hasInline = String(step.inline_body || "").trim().length > 0;
      const matchingTemplate = step.template_key
        ? templates.some((template) => template.template_key === step.template_key && (!channel || template.channel === channel))
        : false;

      if (!step.template_key && !hasInline) {
        add(checks, "error", `${stepLabel} has no message content.`, "Choose a template or write the message in the step.", stepId, stepLabel);
      } else if (step.template_key && templates.length > 0 && !matchingTemplate) {
        add(checks, "warning", `${stepLabel} uses a template that was not found.`, "Confirm the selected template still exists.", stepId, stepLabel);
      }
    }
```

Run → PASS. (`team_alert` keeps working: inline_body counts as content for it too.)

- [ ] **Step 3 (builder):** in the side panel for template-bearing steps, add a two-tab control (`Template` / `Write message`): Write mode shows a textarea bound to `step.inline_body` (+ subject input for email bound to `step.inline_subject`), sets `content_mode: 'inline'`, and clears `template_key`; Template mode is current behavior and clears `inline_body`. Node body hint shows the first 40 chars of inline content when present (`bodyHint` fallback in the node renderer). Follow the existing panel patterns in `builder/page.jsx` (the template selector block).

- [ ] **Step 4 (verify live):** synthetic journey with an inline SMS step is NOT sendable safely — instead verify at the RPC layer: create a throwaway lead + a pending sms action whose `payload.step_spec = {"inline_body":"Hi {{first_name}}"}` and NO template_key; `select get_sms_payload('<action_id>')` → `body = 'Hi <first name>'`. Same for `get_email_payload` with `inline_subject`. Delete the test rows.

- [ ] **Step 5:** `npm test` green; commit:

```bash
git add supabase/migrations/20260707090000_inline_step_content.sql dashboard/src/lib/journeyValidation.js dashboard/tests/journey-validation.test.mjs dashboard/src/app/journeys/builder/page.jsx
git commit -m "feat(builder): write SMS/email content directly in the step — template optional"
```

---

### Task 2: Multi-branch conditional split

**Files:**
- Create: `supabase/migrations/20260707091000_multibranch_conditional_split.sql`
- Modify: `dashboard/src/lib/journeyStepTypes.js`, `dashboard/src/lib/journeyValidation.js`, tests, `builder/page.jsx`

- [ ] **Step 1 (SQL):** replace `process_action_conditional_split` (base = Task 0 Step 2's deployed dual-mode body). Insert the branch walk BEFORE the legacy condition evaluation; everything below stays byte-identical:

```sql
  -- PHASE4: multi-branch. When step_spec.branches exists, walk in order;
  -- first matching branch's id is the outcome; no match -> 'else'.
  -- Steps without branches keep the legacy condition -> yes/no contract.
  v_branches := v_action.payload -> 'step_spec' -> 'branches';
  if v_branches is not null and jsonb_typeof(v_branches) = 'array' and jsonb_array_length(v_branches) > 0 then
    v_outcome := 'else';
    for v_branch in select * from jsonb_array_elements(v_branches) loop
      -- event-workflow runs evaluate payload/context expressions via the
      -- run-scoped resolver (same mechanism as the dual-mode block below);
      -- lead journeys evaluate against the lead. Reuse the SAME evaluation
      -- helper this function already uses for its single condition, passing
      -- v_branch -> 'condition' instead.
      if <existing-evaluation-helper>(v_branch -> 'condition', ...) then
        v_outcome := coalesce(v_branch ->> 'id', 'else');
        exit;
      end if;
    end loop;

    update public.actions
       set status = 'completed', completed_at = now(),
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('branch_outcome', v_outcome)
     where id = p_action_id and status in ('pending', 'in_progress');
    perform public.advance_journey(p_action_id, v_outcome);
    return <match the function's existing return convention>;
  end if;
```

`<existing-evaluation-helper>` is literal-copied from how the deployed body evaluates its single `condition` (lead mode: `evaluate_condition(v_branch->'condition', v_lead.id)`; event mode: the Phase 2 expression path) — Task 0 Step 2 recorded it; substitute exactly, once per mode. Declare `v_branches jsonb; v_branch jsonb;` (and `v_outcome` if not already declared). Grants block.

- [ ] **Step 2 (step types):** in `journeyStepTypes.js`, add the dynamic-outcomes helper and use it everywhere outcomes are read for rendering/validation:

```js
// conditional_split outcomes are branch-driven when the step defines branches.
export function outcomesForStep(step) {
  const cfg = STEP_TYPES[step?.type];
  if (step?.type === "conditional_split" && Array.isArray(step.branches) && step.branches.length > 0) {
    return [
      ...step.branches.map((branch, i) => ({
        id: branch.id || `branch_${i + 1}`,
        label: branch.label || `Branch ${i + 1}`,
        color: "#06b6d4",
        hint: "First matching branch wins",
      })),
      { id: "else", label: "Else", color: "#94a3b8", hint: "No branch matched" },
    ];
  }
  return cfg?.outcomes || [];
}
```

- [ ] **Step 3 (validation):** `validateBranches` switches from `STEP_TYPES[step.type].outcomes` to `outcomesForStep(step)`; add checks: branch ids unique per step (error), every branch has ≥1 rule (warning), `on_outcome` keys ⊆ branch ids + `else` (error). TDD: write the three tests first (fixtures with two branches + else routing), watch them fail, implement, pass.

- [ ] **Step 4 (builder):** conditional_split side panel gains an "Advanced: multiple branches" toggle — on enable, converts the current single condition into `branches: [{id:'branch_1', label:'Branch 1', condition:<existing>}]`; branch list UI = add/remove/reorder + per-branch rule editor (reuse the existing rule-row components) + rename. Node handles render from `outcomesForStep(step)`. Existing yes/no steps stay untouched until the user opts in.

- [ ] **Step 5 (verify live):** synthetic 3-branch journey on a throwaway lead (branch_1: `custom.score > 70`, branch_2: `custom.score > 40`, else) with each outcome routed to a distinct wait→exit chain; three leads with scores 90/50/10 → each run completes via its expected branch (`result.branch_outcome` on the split action = `branch_1`/`branch_2`/`else`). Clean up.

- [ ] **Step 6:** `npm test` green; commit (migration + 4 dashboard files):

```bash
git commit -m "feat(builder): multi-branch If/Else conditions — first match wins, else fallback"
```

---

### Task 3: A/B split step

**Files:**
- Create: `supabase/migrations/20260707092000_ab_split_step.sql`
- Modify: `dashboard/src/lib/journeyStepTypes.js`, `builder/page.jsx`, `dashboard/tests/journey-step-types.test.mjs`

- [ ] **Step 1 (SQL):** new handler (complete):

```sql
-- Phase 4: A/B percentage split. Deterministic per (lead|run, step) so
-- retries land on the same side. split_percent_a in [0..100], default 50.
create or replace function public.process_action_ab_split(p_action_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_percent integer;
  v_seed text;
  v_bucket integer;
  v_outcome text;
begin
  select * into v_action from public.actions where id = p_action_id for update;
  if not found or v_action.status not in ('pending', 'in_progress') then
    return null;
  end if;

  v_percent := least(100, greatest(0, coalesce(
    nullif(v_action.payload -> 'step_spec' ->> 'split_percent_a', '')::integer, 50)));
  v_seed := coalesce(v_action.lead_id::text, v_action.run_id::text, v_action.id::text)
            || ':' || v_action.step_index::text;
  v_bucket := abs(hashtext(v_seed)) % 100;
  v_outcome := case when v_bucket < v_percent then 'a' else 'b' end;

  update public.actions
     set status = 'completed', completed_at = now(),
         result = coalesce(result, '{}'::jsonb)
                  || jsonb_build_object('ab_bucket', v_bucket, 'ab_outcome', v_outcome),
         locked_until = null, locked_by = null
   where id = p_action_id;

  return public.advance_journey(p_action_id, v_outcome);
end;
$$;

revoke execute on function public.process_action_ab_split(uuid)
  from public, anon, authenticated;
grant execute on function public.process_action_ab_split(uuid)
  to service_role;
```

Plus the dispatcher replacement (base = Task 0 reconciled `dispatch_pending_actions`): add `'ab_split'` to both inline type lists and the catch-all exclusion list, and one routing line `elsif v_inline_type='ab_split' then perform public.process_action_ab_split(v_inline_id);`. Same signature; grants block.

Also extend Phase 2's leadless allowlist — `ab_split` is deterministic on `run_id` when no lead exists, so it is legal in leadless event runs:

```sql
alter table public.actions drop constraint actions_lead_required_types;
alter table public.actions
  add constraint actions_lead_required_types check (
    lead_id is not null
    or action_type in (
      'create_lead_from_payload', 'find_lead_from_payload',
      'conditional_split', 'wait', 'http_request', 'exit_flow',
      'team_alert', 'ab_split'
    )
  );
```

- [ ] **Step 2 (step types + builder):** add to `STEP_TYPES`:

```js
  ab_split: {
    label: "A/B Split",
    icon: "GitMerge",
    borderClass: "border-fuchsia-500/10 dark:border-fuchsia-500/20",
    iconClass: "bg-fuchsia-500/10 text-fuchsia-500",
    paletteClass: "bg-fuchsia-500/10 text-fuchsia-500 border-fuchsia-500/20 hover:bg-fuchsia-500/20",
    supportsTemplate: false,
    customSidePanel: "ab_split",
    defaultDelay: { amount: 0, unit: "minutes" },
    defaultsExtra: { split_percent_a: 50, action_name: "A/B split" },
    outcomes: [
      { id: "a", label: "Variant A", color: "#d946ef", hint: "split_percent_a % of leads" },
      { id: "b", label: "Variant B", color: "#8b5cf6", hint: "Remainder" },
    ],
  },
```

Add `"ab_split"` to `PALETTE_ORDER` (after `conditional_split`). Side panel: one percentage slider/input bound to `split_percent_a` showing "A gets N% / B gets (100-N)%". Test (TDD): `STEP_TYPES.ab_split.outcomes` ids `["a","b"]` + palette inclusion.

- [ ] **Step 3 (verify live):** synthetic split journey (`split_percent_a: 50`, both outcomes → wait→exit); enroll 20 throwaway leads via the enroll RPC, flush, then `select result->>'ab_outcome', count(*) from actions where action_type='ab_split' and ... group by 1` → both buckets non-empty, and re-running the handler on a completed action changes nothing (advance guard). Clean up.

- [ ] **Step 4:** `npm test` green; commit.

```bash
git commit -m "feat(builder): A/B percentage split step with deterministic assignment"
```

---

### Task 4: Reply goals

**Files:**
- Create: `supabase/migrations/20260707093000_reply_goals.sql`
- Modify: `dashboard/src/lib/journeyValidation.js`, tests, `builder/page.jsx`

- [ ] **Step 1 (SQL — apply_journey_goals, complete):**

```sql
-- Phase 4: replied-goals. Called by the inbound processors AFTER
-- cancel_pending_on_engagement, with the run ids that were running BEFORE
-- the cancel. 'exit' goals: the cancel already parked the run as
-- 'responded' — record the goal hit. 'goto' goals: re-activate the run and
-- enqueue the goal step immediately.
create or replace function public.apply_journey_goals(
  p_lead_id uuid,
  p_run_ids uuid[],
  p_event_type text,
  p_event jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_journey public.journeys%rowtype;
  v_goal jsonb;
  v_goto integer;
  v_step jsonb;
  v_action_id uuid;
  v_applied jsonb := '[]'::jsonb;
begin
  if p_run_ids is null or array_length(p_run_ids, 1) is null then
    return jsonb_build_object('applied', v_applied);
  end if;

  for v_run in
    select * from public.journey_runs where id = any(p_run_ids) for update
  loop
    select * into v_journey from public.journeys
     where id = v_run.journey_id limit 1;
    if v_journey.id is null then continue; end if;

    select g into v_goal
      from jsonb_array_elements(coalesce(v_journey.spec -> 'goals', '[]'::jsonb)) g
     where g ->> 'event' = p_event_type
     limit 1;
    if v_goal is null then continue; end if;

    if coalesce(v_goal ->> 'action', 'exit') = 'goto' then
      v_goto := nullif(v_goal ->> 'goto_step', '')::integer;
      select s into v_step
        from jsonb_array_elements(coalesce(v_journey.spec -> 'steps', '[]'::jsonb)) s
       where (s ->> 'index')::integer = v_goto
       limit 1;
      if v_step is null then continue; end if;

      update public.journey_runs
         set status = 'running',
             responded = true,
             completed_at = null,
             current_step = v_goto,
             next_action_at = now(),
             last_error = null
       where id = v_run.id;

      insert into public.actions (
        tenant_id, lead_id, run_id, action_type, step_index, template_key,
        run_at, status, idempotency_key, payload
      ) values (
        v_run.tenant_id, p_lead_id, v_run.id, v_step ->> 'type', v_goto,
        v_step ->> 'template_key', now(), 'pending',
        'goal:' || v_run.id::text || ':' || v_goto::text || ':' || coalesce(p_event ->> 'event_id', md5(clock_timestamp()::text)),
        jsonb_build_object('enrolled_via', v_journey.journey_key,
                           'step_spec', v_step,
                           'goal_id', v_goal ->> 'id',
                           'goal_event', p_event_type)
      )
      on conflict (tenant_id, idempotency_key) do nothing
      returning id into v_action_id;

      v_applied := v_applied || jsonb_build_object(
        'run_id', v_run.id, 'goal', v_goal ->> 'id', 'action', 'goto',
        'goto_step', v_goto, 'action_id', v_action_id);
    else
      -- exit goal: engagement cancel already parked the run; stamp the goal.
      update public.journey_runs
         set responded = true,
             last_error = null
       where id = v_run.id;
      v_applied := v_applied || jsonb_build_object(
        'run_id', v_run.id, 'goal', v_goal ->> 'id', 'action', 'exit');
    end if;

    insert into public.events (tenant_id, lead_id, channel, direction, provider, body, raw_payload)
    values (v_run.tenant_id, p_lead_id, 'system', 'internal', 'engine',
            'Goal ' || coalesce(v_goal ->> 'id', '?') || ' met (' || p_event_type || ')',
            jsonb_build_object('run_id', v_run.id, 'goal', v_goal, 'event', p_event));
  end loop;

  return jsonb_build_object('applied', v_applied);
end;
$$;

revoke execute on function public.apply_journey_goals(uuid, uuid[], text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_journey_goals(uuid, uuid[], text, jsonb)
  to service_role;
```

- [ ] **Step 2 (processor wiring):** replace `process_inbound_sms` and `process_inbound_email` (bases = Task 0 reconciled — including Phase 3 insertions if present). Two insertions each, per the ordering contract: (a) immediately BEFORE the `cancel_pending_on_engagement` call: `select array_agg(id) into v_goal_run_ids from journey_runs where tenant_id = <tenant var> and lead_id = <lead var> and status = 'running';` (declare `v_goal_run_ids uuid[];`); (b) immediately AFTER the cancel call: `perform apply_journey_goals(<lead var>, v_goal_run_ids, 'replied', jsonb_build_object('event_id', <event var>::text));` wrapped in the same begin/exception→error_logs pattern used elsewhere. Grants blocks; same signatures.

- [ ] **Step 3 (validation + builder):** validation: if `spec.goals` present — max 1 goal, `event='replied'`, `action∈{exit,goto}`, `goto` requires `goto_step` pointing at an existing step (error otherwise). TDD with two tests (valid goto goal passes; goto to missing step invalid). Builder: a "Goal" section in the journey settings panel — toggle, action select (End journey / Jump to step), step dropdown (existing step list) — writing `spec.goals`.

- [ ] **Step 4 (verify live):** synthetic journey: step0 wait(0)→step1 wait(60min)→exit, goal `{event:'replied', action:'goto', goto_step:2}` where step2 is wait(0)→exit. Enroll throwaway lead with a real-format phone owned by the test tenant mapping; call `process_inbound_sms('<lead phone>', '<tenant number>', 'test reply', 'SM_test_goal_1')` directly. Expected: pending step-1 action cancelled by engagement cancel, run flipped back to `running` with `current_step=2`, goal action enqueued, then completes on flush; `events` has the "Goal goal_1 met" row. Verify a control journey WITHOUT goals still ends `responded`. Clean up (leads, runs, actions, events test rows).

- [ ] **Step 5:** `npm test` green; commit.

```bash
git commit -m "feat(engine): reply goals — lead replies exit the run or jump it to a goal step"
```

---

### Task 5: Decision record + close-out

- [ ] **Step 1:** Full suite green; 15-minute error_logs watch = zero errors; security advisors = no ERROR-level findings; zero `*.invalid` test rows left.
- [ ] **Step 2:** `docs/decisions/005-builder-power-features.md`:

```markdown
# 005 — Builder power features (Phase 4)

**Date:** (execution date)
**Status:** Accepted

## Decision
Inline step content (payload RPC fallback chain: operator inline > step
inline > template), multi-branch conditional_split (ordered branches +
else, legacy yes/no untouched), deterministic ab_split, replied-goals with
capture→cancel→redirect ordering around engagement cancel.

## Deferred
- Nested condition groups; goal events beyond 'replied' (need Phase 3
  registry); stable step IDs; draft/publish (Phase 5 candidates)
```

- [ ] **Step 3: Commit** the record.

---

## Post-Plan Checklist

- [ ] `npm test` fully green; advisors clean; error_logs clean over 24h; test data purged
- [ ] Phase 2 Task 8 (decommission) executed if its gate has passed — independent but still pending
- [ ] Memory/PRD updated

## Known Risks

1. **Multi-branch handles in the canvas** — the builder renders outcome handles from static STEP_TYPES today; the `outcomesForStep` refactor (Task 2 Step 2) must be applied at every render/validation site that reads outcomes, or a branch handle simply won't appear. Grep for `\.outcomes` in `builder/page.jsx` and `journeyValidation.js` and route all hits through the helper.
2. **Goal goto + engagement cancel ordering** — the capture-before-cancel contract is load-bearing; if the capture runs after the cancel, `status='running'` matches nothing and goals silently never fire. The Task 4 Step 4 verification exists specifically to catch this.
3. **Inline content bypasses template versioning** — an inline body lives in the journey spec; editing the journey changes in-flight sends only for actions not yet payload-resolved (payload RPCs read `step_spec` snapshotted on the action, so in-flight actions keep the content they were enqueued with — consistent with existing step_spec semantics; document it).
4. **`hashtext()` is Postgres-version-stable but not portable** across major engine swaps; acceptable — buckets only need stability within a run's lifetime.
