# Phase 2: Single-Queue Engine (merge workflow_actions into actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One queue (`actions`), one guarded dispatcher (`dispatch_pending_actions`), one advancement function (`advance_journey`) for both lead journeys and webhook event workflows; `workflow_actions`, `dispatch_pending_workflow_actions`, `advance_workflow_run`, and the bridge are drained and decommissioned.

**Architecture:** Event workflows become journeys whose actions live in `actions` with `run_id` set and `lead_id` initially NULL (until a create/find-lead step attaches one). The event-native handlers (`create_lead_from_payload`, `find_lead_from_payload`, payload-mode `conditional_split`) are ported to actions-based `process_action_*` functions that keep using the run-scoped expression resolver. `advance_journey` gains a leadless branch. The webhook event branch enqueues into `actions` and processes due inline steps immediately. Old `workflow_actions` rows drain through the existing cron, then the parallel machinery is unscheduled and dropped.

**Tech Stack:** Supabase Postgres 17 (plpgsql migrations), Next.js API routes (JS), `node --test`.

---

## Environment & Working Agreements

- **Repo:** `<repo-root>` (branch `main`). Only `git add` files named in each commit step.
- **Migrations:** file in `supabase/migrations/` + apply identical SQL to dev project `your-project-ref` via Supabase MCP `apply_migration`. Verification via `execute_sql`.
- **JS tests:** `cd dashboard && npm test`.
- **Dev-data caution:** never enroll test data into journeys with real send steps. Synthetic verification uses `webhook_test` (create-lead only) and throwaway `*.invalid` leads; delete all test rows at the end of every task that creates them.

## Hard Rules (lessons from Phase 1 — each caused a production bug when violated)

1. **Never `CREATE OR REPLACE` a function without first diffing the DEPLOYED body** (`pg_get_functiondef`) against the repo's latest version. Task 0 automates this. Phase 1 Task 5 skipped it and clobbered the event-workflow webhook intake (fixed in `20260704110000`).
2. **Never introduce a function overload.** Replace exact signatures; `drop function if exists` the old signature in the same migration when a signature must change. The June 27 guard overload left the dispatcher unguarded for a week.
3. **Every column a function writes must exist** — grep the target table's real columns (`information_schema.columns`) for every UPDATE/INSERT you port (`updated_at` and `last_error` both bit us).
4. **Every new/replaced function carries the grants block** (`revoke ... from public, anon, authenticated; grant ... to service_role;`).

## Locked Design Decisions

1. **`actions.lead_id` becomes nullable.** A CHECK constraint keeps lead identity mandatory for every lead-touching type; only the event-native types may be leadless.
2. **Next-step actions inherit `journey_runs.lead_id` at creation time** — after a create/find-lead step attaches a lead to the run, downstream actions are lead-bound automatically.
3. **`http_request` unifies on the existing actions pipeline** (`process_action_http_request` fire + `process_action_http_collector` poll). The event-specific `dispatch-workflow-http-request` edge function is retired after the drain. The SSRF URL guard from the event runtime is kept as the single shared validator.
4. **Old `workflow_actions` rows are drained, not migrated.** New event runs go to `actions` immediately; in-flight `workflow_actions` finish on the old cron; decommission happens only at zero in-flight (Task 8).
5. **`journey_webhook_samples` result columns keep working** — the event intake keeps writing `result_workflow_action_id` (now storing the `actions.id`) so the builder's sample panel needs no change this phase.
6. **Out of scope:** trigger system (tag_added etc.), per-run stop-on-response, multi-run UI, inline-action guarding (inline steps still bypass `should_dispatch`; acceptable because engagement-cancel and run-failure now clean up — revisit in Phase 3).

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260705090000_phase2_preflight_snapshot.sql` | none — Task 0 produces a report, not a migration |
| `supabase/migrations/20260705091000_actions_leadless_support.sql` | Create: nullable lead_id + type CHECK + indexes |
| `supabase/migrations/20260705092000_advance_journey_leadless.sql` | Create: leadless branch in advance_journey |
| `supabase/migrations/20260705093000_port_event_handlers_to_actions.sql` | Create: 3 ported handlers + shared URL guard wiring |
| `supabase/migrations/20260705094000_dispatcher_routes_event_types.sql` | Create: inline routing for the new types |
| `supabase/migrations/20260705095000_event_webhook_intake_unified.sql` | Create: event branch of process_journey_webhook → actions |
| `supabase/migrations/20260705096000_replay_sample_unified.sql` | Create: replay_webhook_sample → unified path |
| `supabase/migrations/2026070610xxxx_decommission_workflow_actions.sql` | Create in Task 8 (timestamp at execution, AFTER drain) |
| `dashboard/src/lib/journeyValidation.js` | Modify: collapse BRIDGED/NATIVE sets |
| `dashboard/tests/journey-validation.test.mjs` | Modify: update event-workflow expectations |
| `dashboard/src/app/api/journeys/[id]/executions/route.js` | Modify: read unified queue for event runs |
| `docs/decisions/003-single-queue-engine.md` | Create: decision record |

---

### Task 0: Preflight — deployed-vs-repo diff of every function this plan replaces

**Files:** none (report only, goes in the task notes)

- [ ] **Step 1: Snapshot deployed bodies**

Run via `execute_sql` and save the output to the task notes:

```sql
select p.proname, md5(pg_get_functiondef(p.oid)) as deployed_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
  and p.proname in (
    'advance_journey', 'process_journey_webhook', 'replay_webhook_sample',
    'dispatch_pending_actions', 'process_wait_action',
    'process_action_conditional_split', 'process_action_http_request',
    'process_workflow_create_lead_action', 'process_workflow_find_lead_action',
    'process_workflow_conditional_split_action', 'process_workflow_wait_action',
    'process_workflow_http_request_action',
    'dispatch_pending_workflow_actions', 'dispatch_workflow_run_actions',
    'advance_workflow_run', 'create_journey_run',
    'resolve_workflow_expression'
  )
order by 1;
```

- [ ] **Step 2: For each function a later task replaces, fetch `pg_get_functiondef` and diff against the newest repo migration defining it.** If the deployed body differs from the repo (out-of-band change), STOP and reconcile the repo first (commit the deployed body as a sync migration) before proceeding. Do not write any Task 2-7 migration from a repo body that fails this check.

- [ ] **Step 3: Confirm the exact name of the event URL guard function** (repo says it lives in `20260702065642_event_workflow_http_request.sql` — the function that returns `{allowed, reason, host}` and blocks localhost/private/metadata hosts). Record its exact signature; Task 3 reuses it. Also confirm whether `process_action_http_request` (legacy path, defined in `20260626100000_native_dispatch_handlers.sql`) already validates URLs — if not, Task 3 adds the guard call there.

---

### Task 1: Schema — leadless actions

**Files:**
- Create: `supabase/migrations/20260705091000_actions_leadless_support.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 2: actions is the single queue. Event-native steps may run before a
-- lead exists, so lead_id becomes nullable — but every lead-touching type
-- still requires it. journey_runs.lead_id is the handoff: create/find-lead
-- handlers set it, and advance_journey stamps it onto subsequent actions.

alter table public.actions
  alter column lead_id drop not null;

alter table public.actions
  add constraint actions_lead_required_types check (
    lead_id is not null
    or action_type in (
      'create_lead_from_payload',
      'find_lead_from_payload',
      'conditional_split',
      'wait',
      'http_request',
      'exit_flow',
      'team_alert'
    )
  );

-- Leadless actions can only be located via run; index the pair.
create index if not exists actions_run_pending_idx
  on public.actions (run_id, status)
  where run_id is not null;
```

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `actions_leadless_support`). Expected `{"success": true}`.

- [ ] **Step 3: Verify**

```sql
select
  (select is_nullable from information_schema.columns
    where table_schema='public' and table_name='actions' and column_name='lead_id') as lead_nullable,
  (select count(*) from pg_constraint where conname='actions_lead_required_types') as chk;
```

Expected: `lead_nullable = 'YES'`, `chk = 1`. Then confirm the constraint bites:

```sql
-- must FAIL with check violation:
insert into actions (tenant_id, action_type, step_index, run_at, status, idempotency_key)
select id, 'email', 0, now(), 'pending', 'phase2-chk-test' from tenants limit 1;
```

Expected: ERROR `violates check constraint "actions_lead_required_types"`. (Nothing to clean up — the insert failed.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260705091000_actions_leadless_support.sql
git commit -m "feat(engine): actions supports leadless event-native steps"
```

---

### Task 2: `advance_journey` leadless branch

**Files:**
- Create: `supabase/migrations/20260705092000_advance_journey_leadless.sql`

The base body is the Phase-1 version (`20260704092000_advance_journey_run_centric.sql`) — Task 0 must have confirmed deployed == repo. The migration replaces the function with these exact changes (full body in the migration; the diff below is normative):

- [ ] **Step 1: Write the migration** — copy the full body from `20260704092000` and apply these changes:

**Change A — lead loading tolerates NULL (after the `returning * into v_action` block):**

```sql
  -- Phase 2: event-native actions may be leadless. Load the lead only when
  -- the action has one; otherwise operate purely on the run.
  if v_action.lead_id is not null then
    select * into v_lead
      from public.leads
     where id = v_action.lead_id
     for update;

    if not found then
      update public.actions
         set status = 'failed_permanent',
             error_message = 'lead not found',
             last_error = 'lead not found',
             locked_until = null,
             locked_by = null
       where id = v_action.id;
      return null;
    end if;
  end if;
```

**Change B — mirror flag: leadless actions never mirror:**

```sql
  if v_action.lead_id is null then
    v_mirror := false;
  elsif v_has_event_run and v_journey.id is not null
     and coalesce(v_journey.journey_key, '') <> coalesce(v_lead.journey_template, '') then
    v_mirror := false;
  end if;
```

**Change C — timezone fallback (v_lead may be unset):**

```sql
  v_clamp_tz := coalesce(nullif(v_lead.timezone, ''), v_tenant.timezone, 'UTC');
```

**Change D — journey fallback via lead only when a lead exists** (wrap the `journey_key = v_lead.journey_template` lookup in `if v_action.lead_id is not null then ... end if;`).

**Change E — next-action insert inherits the run's lead** (replace the `insert into public.actions` values for `lead_id` and the idempotency key):

```sql
    coalesce(v_lead.id, v_run.lead_id),           -- lead_id: run may have attached one mid-run
    ...
    coalesce(v_lead.id::text, coalesce(v_run.id::text, 'norun')) || ':' || v_journey.journey_key || ':' || v_next_index::text || ':' || p_action_id::text,
```

**Change F — `skip_outbound` wait handling only when a lead exists** (wrap that `update public.leads` in `if v_action.lead_id is not null then ... end if;`).

End the migration with the standard grants block for `advance_journey(uuid, text)`.

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `advance_journey_leadless`).

- [ ] **Step 3: Verify with a synthetic leadless chain**

```sql
-- run + leadless wait->wait chain through the REAL dispatcher path
with t as (select id from tenants order by created_at limit 1),
j as (
  insert into journeys (tenant_id, journey_key, name, version, active, spec)
  select id, 'phase2_verify_leadless', 'P2 Leadless', 1, true,
    '{"mode":"event_workflow","steps":[{"index":0,"type":"wait","duration":{"amount":0,"unit":"minutes"},"on_outcome":{"default":{"next_step":1}}},{"index":1,"type":"wait","duration":{"amount":0,"unit":"minutes"},"on_outcome":{"default":{"exit":"completed"}}}]}'::jsonb
  from t returning id, tenant_id, journey_key
),
r as (
  insert into journey_runs (tenant_id, journey_id, journey_key, mode, trigger_type, status, raw_payload)
  select tenant_id, id, journey_key, 'event_workflow', 'verify', 'running', '{}'::jsonb
  from j returning id, tenant_id
)
insert into actions (tenant_id, run_id, action_type, step_index, run_at, status, idempotency_key, payload)
select tenant_id, id, 'wait', 0, now(), 'pending', 'phase2-leadless:' || id::text,
       (select jsonb_build_object('step_spec', jsonb_path_query_first(spec, '$.steps[0]')) from journeys where journey_key='phase2_verify_leadless')
from r returning run_id;
```

Then flush twice and check:

```sql
select count(*) from dispatch_pending_actions('phase2-verify', 50);
select count(*) from dispatch_pending_actions('phase2-verify', 50);
select status, current_step from journey_runs where journey_key = 'phase2_verify_leadless';
```

Expected: run `completed`, `current_step = 1`, no error_logs rows. Keep the journey for Task 4's verification; delete the run + actions:

```sql
delete from actions where idempotency_key like 'phase2-leadless:%'
   or run_id in (select id from journey_runs where journey_key='phase2_verify_leadless');
delete from journey_runs where journey_key = 'phase2_verify_leadless';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260705092000_advance_journey_leadless.sql
git commit -m "feat(engine): advance_journey handles leadless event-native actions"
```

---

### Task 3: Port the event-native handlers to `actions`

**Files:**
- Create: `supabase/migrations/20260705093000_port_event_handlers_to_actions.sql`

Three new functions, one modification. The port sources are the newest definitions of the `process_workflow_*` handlers (per Task 0's reconciliation): `process_workflow_create_lead_action` and `process_workflow_find_lead_action` (in `20260629110000` / `20260629180000` + repairs), and `process_workflow_conditional_split_action` (in `20260630173000` + `20260630174000`).

- [ ] **Step 1: Extract each source body** (from the reconciled repo file confirmed in Task 0) and create the actions-based version by applying this exact substitution table — no other logic changes:

| Source (workflow_actions version) | Target (actions version) |
|---|---|
| function name `process_workflow_create_lead_action` | `process_action_create_lead_from_payload` |
| function name `process_workflow_find_lead_action` | `process_action_find_lead_from_payload` |
| function name `process_workflow_conditional_split_action` | `process_action_event_conditional_split` |
| `public.workflow_actions%rowtype` / `from public.workflow_actions` / `update public.workflow_actions` | `public.actions` equivalents |
| `perform public.advance_workflow_run(<id>, <outcome>)` / `select public.advance_workflow_run(...)` | `perform public.advance_journey(<id>, <outcome>)` (returns uuid — drop any jsonb result inspection and rely on run status) |
| writes to `updated_at` on the action row | **delete** (actions has no updated_at) |
| writes to `failed_at` on the action row | **delete** (actions has no failed_at; keep `completed_at`, `error_message`, `last_error`) |
| `attempt_number` / `retry_count` handling | keep `retry_count` (exists on actions); delete `attempt_number` writes only if the source used a column actions lacks — check `information_schema.columns` per Hard Rule 3 |

Lead attachment invariant (both create/find handlers already do this on the run — keep it, and ADD the same stamp onto the action row):

```sql
  update public.journey_runs set lead_id = v_lead_id, ... where id = v_action.run_id;
  update public.actions set lead_id = v_lead_id where id = p_action_id and lead_id is null;
```

- [ ] **Step 2: `conditional_split` dual-mode.** Replace `process_action_conditional_split` (deployed body confirmed in Task 0; base in `20260626140000` backfill lines 1959-2031) so it delegates: if the action's `run_id` belongs to a `mode='event_workflow'` run AND the step spec uses payload expressions, evaluate via the run-scoped resolver (exact logic from `process_workflow_conditional_split_action`); otherwise keep the existing lead-based `evaluate_condition` path unchanged. One function, one dispatcher route.

- [ ] **Step 3: URL guard sharing.** If Task 0 found `process_action_http_request` lacks URL validation, add a call to the event guard function (exact name recorded in Task 0) at its top, failing the action permanently with reason `blocked_url:<reason>` when not allowed.

- [ ] **Step 3b: `http_request` dual-mode rendering.** The legacy `process_action_http_request` renders URL/headers/body merge tags from the LEAD only (`render_template(text, leads)`); event steps use run-scoped payload expressions (`{{payload.x}}`, `{{context.y}}`). Mirror the conditional_split pattern: when the action's `run_id` belongs to a `mode='event_workflow'` run, resolve expressions through the run-scoped resolver (exact resolution logic from `process_workflow_http_request_action`, reconciled in Task 0) before falling back to lead merge tags for any remaining `{{...}}` tokens when a lead is attached. Same function, no new dispatcher route.

- [ ] **Step 4:** every function in this migration gets the grants block. Apply to dev (`apply_migration`, name `port_event_handlers_to_actions`).

- [ ] **Step 5: Unit-verify each handler in isolation** with a synthetic run + action per handler (pattern from Task 2 Step 3; `create_lead_from_payload` fixture uses `raw_payload = {"email":"phase2-h1@example.invalid","first_name":"H1"}` and `field_mappings` pointing at `payload.email` / `payload.first_name`). Expected per handler: action `completed`, correct `result.outcome` (`created` / `found` or `not_found` / `yes` or `no`), run advanced. Delete all `*.invalid` leads + their runs/actions afterward.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260705093000_port_event_handlers_to_actions.sql
git commit -m "feat(engine): event-native handlers run on the unified actions queue"
```

---

### Task 4: Dispatcher routes the new inline types

**Files:**
- Create: `supabase/migrations/20260705094000_dispatcher_routes_event_types.sql`

- [ ] **Step 1: Write the migration.** Full replacement of `dispatch_pending_actions(text, integer, integer)` — body verbatim from `20260704101000_restore_guarded_dispatcher.sql` (Task 0 confirmed deployed == repo) with exactly two changes:

1. Both inline `action_type in (...)` lists gain the new types:

```sql
'wait','create_lead','update_lead','find_lead','team_alert',
'conditional_split','exit_flow','add_tag','remove_tag','wait_reply',
'create_lead_from_payload','find_lead_from_payload'
```

2. The inline `if/elsif` chain gains:

```sql
      elsif v_inline_type = 'create_lead_from_payload' then perform public.process_action_create_lead_from_payload(v_inline_id);
      elsif v_inline_type = 'find_lead_from_payload' then perform public.process_action_find_lead_from_payload(v_inline_id);
```

(`conditional_split` already routes to `process_action_conditional_split`, which is now dual-mode. The final catch-all query's `not in (...)` list gains the two new types as well.)

Grants block at the end. **Same signature — no overload** (Hard Rule 2).

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `dispatcher_routes_event_types`).

- [ ] **Step 3: Verify end-to-end leadless→lead chain through the cron path:** synthetic event journey `create_lead_from_payload(index 0) → wait(index 1) → exit`, run + step-0 action in `actions` with `raw_payload` on the run, flush twice. Expected: lead created, run completed with `lead_id` set, step-1 action carried `lead_id` (inherited via advance). Clean up `*.invalid` rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260705094000_dispatcher_routes_event_types.sql
git commit -m "feat(engine): unified dispatcher processes event-native step types"
```

---

### Task 5: Webhook event intake → unified queue

**Files:**
- Create: `supabase/migrations/20260705095000_event_webhook_intake_unified.sql`

- [ ] **Step 1: Write the migration.** Full replacement of `process_journey_webhook(text, jsonb, jsonb, text)` — base body verbatim from `20260704110000_restore_event_workflow_webhook_intake.sql` (Task 0 confirmed) with exactly these changes inside the `v_mode = 'event_workflow'` branch:

1. The `insert into public.workflow_actions (...)` becomes:

```sql
    insert into public.actions (
      tenant_id, run_id, lead_id, action_type, step_index,
      run_at, status, payload, idempotency_key
    ) values (
      v_journey.tenant_id, v_run_id, null,
      v_step0->>'type', v_trigger_step_index,
      now(), 'pending',
      jsonb_build_object('enrolled_via', 'webhook', 'step_spec', v_step0),
      'event-webhook-action:' || v_run_id::text || ':' || v_trigger_step_index::text
    )
    on conflict (tenant_id, idempotency_key) do nothing
    returning id into v_action_id;
```

2. The duplicate lookup reads `public.actions` (same idempotency key).

3. Immediate dispatch: replace `v_dispatch := public.dispatch_workflow_run_actions(...)` with direct inline processing of the just-queued step (both allowed start types are inline-safe):

```sql
    if v_action_id is not null then
      begin
        if v_step0->>'type' = 'create_lead_from_payload' then
          perform public.process_action_create_lead_from_payload(v_action_id);
        else
          perform public.process_action_find_lead_from_payload(v_action_id);
        end if;
        v_dispatch := jsonb_build_object('processed', 1, 'failed', 0);
      exception when others then
        v_dispatch := jsonb_build_object('processed', 0, 'failed', 1, 'error', sqlerrm);
      end;
    end if;
```

4. The post-dispatch status reads switch from `workflow_actions` to `actions` (same columns: `status, result, lead_id`).

Everything else in the function — auth, samples, both response shapes, the entire lead-journey path — stays byte-identical to the base. Grants block at the end.

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `event_webhook_intake_unified`).

- [ ] **Step 3: Verify with the real `webhook_test` journey** (token `select webhook_token from journeys where journey_key='webhook_test'`), Tally-shaped payload with email `phase2-intake@example.invalid` (7-entry `data.fields` array — see `journey_webhook_samples` for the shape). Expected: `mode=event_workflow`, `status=processed`, `result.outcome=created`, and the queued row is in **`actions`** (`select action_type, status from actions where run_id = '<run_id>'`), zero rows added to `workflow_actions`. Clean up lead/run/actions/sample.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260705095000_event_webhook_intake_unified.sql
git commit -m "feat(engine): event webhook intake enqueues into the unified actions queue"
```

---

### Task 6: `replay_webhook_sample` + executions API on the unified path

**Files:**
- Create: `supabase/migrations/20260705096000_replay_sample_unified.sql`
- Modify: `dashboard/src/app/api/journeys/[id]/executions/route.js`

- [ ] **Step 1:** Fetch the deployed `replay_webhook_sample` (Task 0). It re-invokes `process_journey_webhook` with a stored sample (`20260630163500_replay_webhook_sample_fresh_run.sql`). If it only delegates to `process_journey_webhook`, no SQL change is needed — verify by replaying a sample and confirming the new run's actions land in `actions`. If it writes `workflow_actions` directly, apply the same substitutions as Task 5 and ship the migration; otherwise skip the migration file entirely (delete it from the plan's file map in the commit message).

- [ ] **Step 2:** Update the executions API route: where it reads `workflow_actions` for event runs, read `actions` filtered by `run_id` **union** legacy `workflow_actions` rows (drained runs still display during the transition):

```js
const [{ data: unified }, { data: legacy }] = await Promise.all([
  supabase.from("actions").select(EXEC_SELECT).eq("tenant_id", tenantId).eq("run_id", runId).order("created_at"),
  supabase.from("workflow_actions").select(EXEC_SELECT).eq("tenant_id", tenantId).eq("run_id", runId).order("created_at"),
]);
const rows = [...(legacy || []), ...(unified || [])];
```

(Adapt `EXEC_SELECT` to the route's existing column list; read the file first — it was not touched by Phase 1.)

- [ ] **Step 3:** `cd dashboard && npm test` — green. Commit:

```bash
git add supabase/migrations/20260705096000_replay_sample_unified.sql dashboard/src/app/api/journeys/[id]/executions/route.js
git commit -m "feat(engine): sample replay + executions view on the unified queue"
```

---

### Task 7: Builder validation collapses the bridge distinction

**Files:**
- Modify: `dashboard/src/lib/journeyValidation.js`
- Modify: `dashboard/tests/journey-validation.test.mjs`

- [ ] **Step 1: Write the failing test** (append):

```js
test("event workflows treat provider steps as native after queue unification", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [
      { index: 0, type: "create_lead_from_payload", field_mappings: [{ destination: "email", source: { source: "payload.email" } }], on_outcome: { created: { next_step: 1 }, updated: { next_step: 1 }, skipped: { exit: "completed" }, failed: { exit: "failed" } } },
      { index: 1, type: "sms", template_key: "sms_1", on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "opted_out" } } },
    ],
    triggerNextStep: 0,
  }, { templates: [{ template_key: "sms_1", channel: "sms" }] });

  assert.equal(result.summary.error, 0);
});
```

- [ ] **Step 2:** Run: `cd dashboard && npm test` — the new test must FAIL only if current validation rejects this shape; if it already passes, keep the test as a regression guard and continue.

- [ ] **Step 3:** In `journeyValidation.js`: merge `EVENT_WORKFLOW_BRIDGED_STEP_TYPES` into `EVENT_WORKFLOW_NATIVE_STEP_TYPES` (single `EVENT_WORKFLOW_STEP_TYPES` set), delete the bridged set and any distinct "bridge" error messages. **Keep** the `hasWebhookLeadContextBefore` requirement — lead-required steps still need a create/find-lead step upstream (that invariant is now enforced by the CHECK constraint at runtime too).

- [ ] **Step 4:** `npm test` green. Commit:

```bash
git add dashboard/src/lib/journeyValidation.js dashboard/tests/journey-validation.test.mjs
git commit -m "feat(builder): event workflows validate against the unified engine"
```

---

### Task 8: Drain and decommission (GATED — do not run same-day)

**Files:**
- Create: `supabase/migrations/2026070610xxxx_decommission_workflow_actions.sql` (timestamp when executed)

- [ ] **Step 1: Confirm drain complete** (all of these must hold, at least 24h after Task 5 shipped):

```sql
select
  (select count(*) from workflow_actions where status in ('pending','in_progress')) as in_flight,
  (select count(*) from workflow_actions where created_at > now() - interval '24 hours') as new_rows_24h,
  (select count(*) from error_logs where workflow_name like '%workflow%' and severity='error' and created_at > now() - interval '24 hours') as wf_errors_24h;
```

Expected: all `0`. If `new_rows_24h > 0`, something still writes the old table — find it (`select proname from pg_proc ... where pg_get_functiondef ilike '%insert into public.workflow_actions%'`) and fix before proceeding.

- [ ] **Step 2: Write + apply the decommission migration**

```sql
-- Phase 2 decommission: the unified queue has been sole intake for 24h+
-- with zero in-flight workflow_actions (verified before applying).

select cron.unschedule('dispatch-pending-workflow-actions');

drop function if exists public.dispatch_pending_workflow_actions(text, integer);
drop function if exists public.dispatch_workflow_run_actions(uuid, text, integer);
drop function if exists public.advance_workflow_run(uuid, text);
drop function if exists public.process_workflow_create_lead_action(uuid);
drop function if exists public.process_workflow_find_lead_action(uuid);
drop function if exists public.process_workflow_conditional_split_action(uuid);
drop function if exists public.process_workflow_wait_action(uuid);
drop function if exists public.process_workflow_http_request_action(uuid);
drop trigger if exists trg_workflow_action_failed_permanent on public.workflow_actions;

-- Keep the table as history this phase; rename so nothing writes it silently.
alter table public.workflow_actions rename to workflow_actions_archived;
```

Before applying: re-run the Task 0 caller scan — `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ilike '%workflow_actions%' and p.proname not like 'process_workflow%'` must return only functions being dropped in this migration (plus the executions route reads, which tolerate the rename via its legacy branch → update the route's legacy read to `workflow_actions_archived` in the same commit). Delete the `dispatch-workflow-http-request` edge function from the Supabase dashboard (or `supabase functions delete`) and remove `supabase/functions/dispatch-workflow-http-request/` from the repo in this commit.

- [ ] **Step 3: Verify:** cron list shows 2 jobs (`dispatch-pending-actions`, `poll-gmail-inbox`); fire a `webhook_test` webhook → processed via `actions`; zero error_logs errors over the next 10 minutes.

- [ ] **Step 4: Commit** (migration + executions route rename + edge function removal + decision record):

Create `docs/decisions/003-single-queue-engine.md`:

```markdown
# 003 — Single-queue engine (Phase 2)

**Date:** (execution date)
**Status:** Accepted

## Decision
`actions` is the only work queue. Event workflows run as journey_runs whose
actions live in `actions` (leadless until create/find-lead attaches one).
`workflow_actions` is archived; its dispatcher, advancement function, and
handlers are dropped. One dispatcher, one guard, one advancement function.

## Invariants
- actions.lead_id nullable ONLY for event-native types (CHECK constraint)
- next-step actions inherit journey_runs.lead_id at insert
- never CREATE OR REPLACE a function without diffing the deployed body first
- never introduce function overloads in migrations

## Deferred
- Trigger system (tag_added / form_submitted / …) — Phase 3
- Inline actions bypassing should_dispatch — Phase 3
- Dropping workflow_actions_archived — after 30 days
```

```bash
git add supabase/migrations/<decommission file> dashboard/src/app/api/journeys/[id]/executions/route.js docs/decisions/003-single-queue-engine.md
git rm -r supabase/functions/dispatch-workflow-http-request
git commit -m "feat(engine): decommission workflow_actions machinery — single queue complete"
```

---

## Post-Plan Checklist

- [ ] `cd dashboard && npm test` fully green
- [ ] Supabase security advisors: no ERROR-level findings; all new functions carry grants blocks
- [ ] `error_logs` clean over 24h of cron ticks
- [ ] All `*.invalid` / `phase2_verify*` test data deleted from dev
- [ ] Memory + PRD note updated: single-queue engine live

## Known Risks

1. **Ported-handler fidelity** — the substitution-table ports (Task 3) are mechanical but the sources have had repair migrations; Task 0's reconciliation is the safety net. Do not skip it.
2. **In-flight event runs during cutover** — a run started on `workflow_actions` whose NEXT step is queued after Task 5 will continue on the OLD path (advance_workflow_run queues workflow_actions) until it terminates; that is exactly why the old cron stays until Task 8's drain gate.
3. **`journey_webhook_samples.result_workflow_action_id`** now stores an `actions.id` for new runs — any UI joining it against `workflow_actions` shows blanks for new runs until Task 6's union lands. Ship Tasks 5 and 6 in the same session.
4. **Immediate-dispatch semantics change** (Task 5): only the first step runs synchronously at webhook receipt; subsequent due steps wait for the next 30s cron tick (previously `dispatch_workflow_run_actions` looped up to 10). Acceptable latency; note it in the decision record if anyone notices.
