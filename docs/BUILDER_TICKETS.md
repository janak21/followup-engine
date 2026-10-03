# Journey Builder — Implementation Tickets (from BUILDER_UX_AUDIT.md)

Orchestrator: Claude (review) · Implementers: coding agents. Run in order. **B1 must land and be
approved before B2** — inline "+" is unusable until new steps auto-place.

Global rules (apply to every builder ticket, even if not repeated):
- These are **UI-behavior** changes. `npm run build` + `npm run test` + `npm run lint` passing is
  NECESSARY BUT NOT SUFFICIENT. Every ticket also requires a **live click-through** in a running app
  (`npm run dev` against the DEV Supabase project) with the checks listed. If you cannot run the app,
  STOP and report — do not mark done on static checks alone.
- Do NOT touch the dispatch engine, SQL/RPCs, edge functions, or anything outside the builder page and
  its `components/`. This is a canvas/UI-layer effort only.
- Do NOT change the step data model: steps stay `{ index, sid, x, y, type, template_key,
  on_outcome: { [outcomeKey]: { next_step, next_sid } | { exit } } }`. Branching stays outcome-keyed.
- Do NOT remove existing capabilities: manual drag-to-connect (`onConnect`), manual node drag
  (`onNodeDragStop`), edge delete, draft/publish, validation. You are ADDING guided ergonomics on top.
- Reuse existing helpers/state: `getCurrentSteps()`, `replaceStepsState(nextSteps, dirty)`,
  `handleNodeClick`, `setIsDrawerOpen`, the step registry in `src/lib/journeyStepTypes.js`, and the
  React Flow instance ref (`reactFlowInstanceRef`).
- Minimal diff. No renames, no unrelated refactors. If you find a bug, note it separately; do not fix
  it inline.
- Output every time: files changed, diff summary, commands run + results, and the live click-through
  results.

Data-model reference (verified in `page.jsx` `syncCanvasFromSteps`):
- Node ids: trigger node id = `"trigger"` (type `"customTrigger"`); step node id = `String(step.index)`
  (type `"customStep"`).
- Edges: type `"buttonEdge"`, `source`/`target` are node ids, `sourceHandle` = the outcome key,
  `data.outcomeKey` = same. Trigger→first step uses `sourceHandle: "default"` and is driven by the
  `triggerNextStep` state (not `on_outcome`).
- An outcome with no next step is stored as `on_outcome[key] = { exit: "completed" }` (see the edge-delete
  handler). A connected outcome is `on_outcome[key] = { next_step: <index>, next_sid: <sid> }`.
- Outcomes per step type come from `journeyStepTypes.js` (`outcomes: [{ id, label, color, hint }]`).

---

## TICKET-B1 — Top-down auto-layout engine for the journey graph

```PROMPT
ROLE: Senior React/React Flow engineer. You are adding automatic graph layout to an existing
@xyflow/react canvas WITHOUT changing the data model or removing manual positioning. Pure-function core,
thin integration. Minimal diff.

CONTEXT (verified in dashboard/src/app/journeys/builder/page.jsx):
- The builder renders a trigger node (id "trigger") plus step nodes (id = String(step.index)) on a React
  Flow canvas. Node positions come from step.x / step.y today, set by manual drag (onNodeDragStop persists
  x/y into each step via replaceStepsState).
- Graph edges are derived from: triggerNextStep (trigger -> that step index) and each step's
  on_outcome[outcomeKey].next_step (step -> target index). Terminal outcomes are { exit: "completed" }.
- Steps: { index:number, sid, x, y, type, template_key, on_outcome }. Read via getCurrentSteps(), write
  via replaceStepsState(nextSteps, dirty=true).
- React Flow instance is available via reactFlowInstanceRef; fitView is already called after load.

DEPENDENCY DECISION (approved by orchestrator): you MAY add `@dagrejs/dagre` (the standard React Flow
layout companion) as a dependency for this ticket. Pin an exact version. Do NOT add any other dependency.
If you prefer a self-contained layered BFS layout and can correctly handle branches AND merges (a step
targeted by multiple outcomes) AND back-edges (a later step looping to an earlier one, e.g. wait-for-reply
retry), you may hand-roll it instead — but it MUST handle those three cases. State which you chose and why.

TASK:
  1. Create a PURE, side-effect-free module `src/app/journeys/builder/lib/autoLayout.js` exporting
     `computeLayout({ triggerNextStep, steps })` -> `{ trigger: {x,y}, steps: { [index]: {x,y} } }`.
       - Build the directed graph: root = "trigger"; edge trigger->triggerNextStep if set; for each step,
         edges step.index -> on_outcome[k].next_step for every outcome with a numeric next_step.
       - Lay out TOP-DOWN (vertical): trigger at top, depth increases downward. Siblings (multiple outcomes
         of one step, or multiple steps at the same depth) spread horizontally without overlap.
       - Handle merges (a node with multiple parents): place at a sensible single position (e.g. dagre
         default, or for the hand-rolled version, max parent depth + 1, x = average of parents clamped to
         avoid overlap).
       - Handle back-edges / cycles WITHOUT infinite-looping (dagre handles this; hand-rolled must break
         cycles via a visited set).
       - Use consistent spacing constants (e.g. vertical gap ~140px, horizontal gap ~260px) exported as
         named constants so they can be tuned.
       - Deterministic: same input -> same output.
  2. Integrate in page.jsx:
       - Add `applyAutoLayout()` that calls computeLayout on the current trigger+steps, writes the new x/y
         back into every step via replaceStepsState (preserving all other step fields), sets triggerPos,
         and then calls reactFlowInstanceRef.current?.fitView({ padding: 0.2, maxZoom: 1.2 }).
       - Call applyAutoLayout automatically after a journey loads (replacing reliance on stored x/y for
         initial render is acceptable; do NOT wipe stored x/y silently — recompute and persist).
       - Add a visible "Tidy up" button in the canvas controls area that calls applyAutoLayout on click.
       - Preserve manual drag: onNodeDragStop still persists x/y; auto-layout only runs on load, on the
         Tidy-up click, and (in B2) on add/delete. Do not fight the user by re-laying-out on every change.
  3. Do not alter edges, outcomes, validation, or the drawer.

DEFINITION OF DONE:
  - New file `lib/autoLayout.js` is pure (no imports of React/DOM/state).
  - Add `dashboard/tests/journey-autolayout.test.mjs` (node:test) covering: linear chain (n steps ->
    strictly increasing y, equal x), a branch (two outcomes -> two children at same depth, different x, no
    overlap), a merge (two parents -> one child, single position, deeper than both parents), and a cycle
    (back-edge -> terminates, all nodes get a position). Assert determinism (two calls equal).
  - `npm run build`, `npm run test`, `npm run lint` pass.
  - LIVE CHECK (report each): (a) open an existing multi-step journey -> nodes render tidy, no overlap,
    trigger at top; (b) click "Tidy up" on a messily-dragged journey -> it reorganizes; (c) manually drag a
    node -> it stays where dragged until next Tidy up; (d) save -> reload -> layout stable.

FORBIDDEN: changing the step schema, removing manual drag, re-laying-out on every state change, adding any
dependency other than a pinned @dagrejs/dagre, touching non-builder files.

OUTPUT: layout approach + why, files changed, test results, and the four live-check results.
```

**Reviewer check (me):** read `autoLayout.js` for purity + cycle handling; run the unit test; confirm
manual drag still persists and auto-layout isn't firing on every keystroke.

---

## TICKET-B2 — Inline "+" add-and-auto-connect with a categorized action picker

```PROMPT
ROLE: Senior React/React Flow engineer. You are adding GHL-style guided step insertion on top of the
existing canvas. Depends on TICKET-B1 (auto-layout) being merged. Minimal diff, no data-model change.

CONTEXT (verified in dashboard/src/app/journeys/builder/page.jsx and src/lib/journeyStepTypes.js):
- Adding a step today has no inline affordance; branching requires manually dragging an edge from an
  outcome handle (onConnect writes on_outcome[handle] = { next_step, next_sid }). triggerNextStep links the
  trigger to the first step.
- Step registry (journeyStepTypes.js) defines each type's outcomes. Step shape: { index, sid, x, y, type,
  template_key, on_outcome }. Read getCurrentSteps(), write replaceStepsState(nextSteps).
- handleNodeClick opens the config drawer (setIsDrawerOpen). applyAutoLayout() exists from B1.

GOAL: A user adds a step by clicking a "+" that INSERTS, AUTO-CONNECTS, and AUTO-PLACES it — never by
dragging a node then drawing a line. Manual drag-to-connect remains as a power feature.

TASK:
  1. Unwired-outcome "+" stubs. For every outcome of every step that is NOT connected (no numeric next_step
     — i.e. missing or { exit }), AND for the trigger when triggerNextStep is null, render a small dashed
     "+" affordance hanging off that outcome handle on the canvas. (Implement as a React Flow node or an
     edge-end add-button; choose the cleaner approach for @xyflow/react v12 and explain.) This makes
     "what's unfinished" visible (audit 3.3/3.7).
  2. Action picker. Clicking any "+" opens a categorized, searchable picker (modal or popover). Build the
     categories FROM the registry, grouped as:
       - Communication: sms, email, call, team_alert
       - Timing: wait, wait_for_reply
       - Logic: conditional_split, ab_split
       - Lead ops: add_tag, remove_tag, update_lead, create_update_lead (create/update),
         create_lead_from_payload, find_lead, find_lead_from_payload
       - Integrations: http_request (webhook)
     Each item shows the registry icon + label + one-line hint. Include a text filter that matches label.
     Derive the grouping from the registry; do not hardcode a second source of truth for labels/icons.
  3. Insert + connect + place. On selecting an action:
       a. Create a new step: next free integer index, a fresh sid, type = chosen type, sensible default
          config (reuse whatever new-step defaults already exist in the code; if none, create the minimal
          valid shape the registry + validation expect — verify against validateJourneySpec).
       b. Wire the source: if the "+" was on the trigger, set triggerNextStep = newIndex; else set the
          source step's on_outcome[thatOutcomeKey] = { next_step: newIndex, next_sid: newSid }.
       c. replaceStepsState with the new steps array, then call applyAutoLayout() so the new step lands in
          the right place.
       d. Open the config drawer for the new step (handleNodeClick / setIsDrawerOpen) so the user configures
          it immediately — GHL behavior.
  4. Keep onConnect (manual drag), edge delete, and onNodeDragStop working unchanged. Adding via "+" and
     wiring via drag must both end in the same on_outcome data.
  5. Empty state (audit 3.1): when a journey has a trigger and zero steps, show the trigger with a single
     prominent "+" beneath it and one line of copy ("Add the first step of your follow-up"). Reuse the same
     picker.

DEFINITION OF DONE:
  - Every unconnected outcome (and an unlinked trigger) shows a "+" stub; connected outcomes do not.
  - Selecting an action from a "+" inserts a step, auto-connects it to that exact outcome, auto-lays-out,
    and opens its drawer — with zero manual dragging.
  - The resulting on_outcome / triggerNextStep data is identical to what manual drag-to-connect would have
    produced (verify by adding one step via "+" and one via drag and comparing the saved spec shape).
  - Manual drag-to-connect, edge delete, node drag, save/draft/publish, and validation all still work.
  - Add `dashboard/tests/journey-add-step.test.mjs` covering the PURE insert logic if you extract it (e.g.
    a helper `insertStepAfter({ steps, triggerNextStep, sourceNodeId, outcomeKey, newType })` ->
    { steps, triggerNextStep }); assert the new step exists, the source outcome points to it, and existing
    steps/outcomes are untouched. Keep the helper pure and UI-free so it is testable.
  - `npm run build`, `npm run test`, `npm run lint` pass.
  - LIVE CHECK (report each): (a) new journey -> empty-state "+" -> pick "Send SMS" -> step appears,
    connected to trigger, drawer opens; (b) on a call step, the "+" under "no answer" adds a branch step
    wired to the no_answer outcome; (c) add a step via "+" and another via manual drag -> both save and
    reload correctly; (d) delete a step -> its "+" stub reappears on the now-unwired outcome; (e) save ->
    publish -> reload -> everything intact.

FORBIDDEN: changing the step schema or outcome semantics, removing manual drag/connect, adding a second
source of truth for step labels/icons, adding dependencies, touching non-builder files, or auto-connecting
to the wrong outcome.

OUTPUT: the "+" implementation approach + why, the insert-helper (if extracted), files changed, test
results, and the five live-check results.
```

**Reviewer check (me):** confirm "+" appears only on unwired outcomes; add one step via "+" and one via
drag and diff the saved spec (must be identical shape); confirm the new-step defaults pass
`validateJourneySpec`; confirm delete restores the stub.

---

## TICKET-B3 — Inline email composer (compose subject/body + merge fields without a template)

Goal: match GHL's email node where a user can EITHER pick a template OR compose the email inline
(subject + body with merge fields), choose which connected sender it goes from, optionally override the
From display name, and test-send it. Spans UI (email node drawer) + SQL (`get_email_payload`) + edge
(`dispatch-gmail-email`). SQL/edge changes are DEV-only; reviewer promotes to prod.

IMPORTANT architectural truth to encode (do not deviate): email sends via the **Gmail API using a
connected sender's OAuth**. The From *address* is therefore constrained to a connected sender's verified
Gmail address — it CANNOT be an arbitrary typed address. The From *display name* CAN be overridden (it is
just a header). So "From" in this UI = a **sender picker** (connected senders) + an **optional display-name
override**, NOT a free-text email field. Do not add a free-text from-email field.

```PROMPT
ROLE: Senior full-stack engineer (React + Postgres/PLpgSQL + Deno edge). You are adding an inline email
composer to the journey builder's email node, reusing the inline-content model that already exists.
Minimal diff. SQL/edge changes target the DEV Supabase project only.

CONTEXT (verified in this repo):
- BACKEND ALREADY SUPPORTS INLINE EMAIL CONTENT. `get_email_payload` (migration
  20260707090000_inline_step_content.sql) resolves subject/body in priority order:
  operator/AI inline (payload->'inline') > step-authored (payload->'step_spec'->>'inline_subject' /
  'inline_body') > template. It renders merge fields via `render_template(text, lead)` (supports
  {{first_name}}, custom fields, and dotted/array payload paths). So inline SUBJECT and BODY are already
  wired end-to-end — the builder just needs to WRITE step_spec.inline_subject / inline_body and the
  dispatcher will render+send them.
- FROM HEADER: `dispatch-gmail-email/index.ts` builds it as
  formatFromHeader(sender.sender_name, sender.sender_email) (~line 378). The address is the connected
  sender's Gmail; sends use that sender's OAuth refresh token. Gmail only permits sending as the
  authenticated account, so the address is NOT free-text.
- Steps carry a step_spec; the email node editor lives in the config drawer (the sms/email/team_alert
  editor). Template inline editing already exists (setTplEditForm). Test-send exists at
  dashboard/src/app/api/senders/[id]/test-send/route.js. Sender selection currently happens inside
  get_email_payload.

WHAT'S MISSING (this ticket adds exactly these): a UI to author inline content on the step, an optional
per-step From display-name override, and optional pinning of WHICH sender the step sends from. Two small
backend wires for the override + sender pin.

TASK:
  UI (dashboard/src/app/journeys/builder — email node editor):
  1. Add a mode toggle on the email step: "Use template" | "Compose inline". Persist the choice on the
     step_spec (e.g. step_spec.email_mode = 'template' | 'inline').
  2. Inline mode fields, written to step_spec:
       - Subject -> step_spec.inline_subject
       - Body -> step_spec.inline_body (plain text or HTML — the dispatcher already auto-detects HTML vs
         plain, so a simple textarea or lightweight rich editor is fine; do not add a heavy editor dep)
       - An "Insert field" control that inserts merge tokens at the cursor: {{first_name}}, {{last_name}},
         {{email}}, {{phone}}, custom fields (custom.<key>), and available webhook payload paths. Reuse the
         SAME field sources the existing payload/JSON explorers use — do NOT create a second source of
         truth for field lists.
       - "From" = a sender picker (dropdown of the tenant's connected senders, by sender_email/sender_name)
         -> step_spec.sender_id. Plus an optional "From name override" text input -> step_spec.from_name.
         Do NOT add a free-text from-email field; show helper copy: "Emails send from your connected
         sender's address."
  3. Template mode keeps the existing template-selection behavior unchanged.
  4. Validation (src/lib/journeyValidation.js): in inline mode require non-empty inline_subject AND
     inline_body AND a selected sender; in template mode require template_key (as today). Surface via the
     existing journeyReadiness path.
  5. Test-send: add a "Send test" action in the inline composer that posts to the existing test-send route
     using the composed inline subject/body, the selected sender, and the from-name override, rendered
     against a sample lead (reuse the builder's existing sample/lead context). Extend the test-send route
     only as needed to accept inline subject/body + from_name; keep its auth guard (requireOperator) and
     tenant scoping intact.

  BACKEND (DEV only; new migrations, never edit applied ones):
  6. From-name override + sender pin in get_email_payload: return an optional from_name (from
     step_spec.from_name) and honor step_spec.sender_id when present (send from that specific connected
     sender instead of auto-selecting). If sender_id is absent, keep today's selection logic unchanged.
     Preserve existing response shape; add fields, don't rename.
  7. dispatch-gmail-email: if the payload carries a from_name override, use it in formatFromHeader instead
     of sender.sender_name (address still comes from the resolved/pinned sender). No other behavior change.

DEFINITION OF DONE:
  - Inline mode: composing subject+body with merge tags, picking a sender, and (optionally) overriding the
    From name, then saving, produces a step whose step_spec has email_mode='inline', inline_subject,
    inline_body, sender_id, and optional from_name.
  - A real send (DEV) of an inline-composed email renders merge fields correctly, sends from the chosen
    connected sender's address, and shows the overridden display name in the From header. (Verify by
    reading the rendered payload from get_email_payload AND doing one live test-send to yourself.)
  - Template mode is unchanged (regression check: an existing template-based email step still sends).
  - Validation blocks publishing an inline email step missing subject/body/sender; template step rules
    unchanged.
  - Add tests: (a) journeyValidation unit test for inline vs template required-fields; (b) a migration/RPC
    test or a documented DEV query proving get_email_payload returns the pinned sender + from_name and
    renders inline content. dashboard npm run test + lint pass; npm run build passes.
  - LIVE CHECK (report each): compose inline email with a {{first_name}} tag -> Send test -> received email
    has the name rendered, correct sender address, overridden display name; switch a step to template mode
    -> still works; publish a journey with an inline email step -> a real enrolled lead receives it.

FORBIDDEN: a free-text from-EMAIL field (Gmail can't honor it); adding an email-editor or rich-text
dependency; creating a second source of truth for merge-field lists; editing applied migrations; touching
prod; changing template-mode behavior; weakening test-send auth/tenant scoping.

OUTPUT: files changed (UI + new migration + edge), the step_spec shape you settled on, test results, the
DEV get_email_payload verification, and the live-check results.
```

**Reviewer check (me):** confirm no free-text from-email field exists; verify `get_email_payload` on DEV
returns pinned sender + `from_name` and renders `{{first_name}}` in inline content; confirm template mode
regression-tested; confirm test-send still enforces `requireOperator` + tenant scope.

**Note for later (out of scope here):** true arbitrary from-domain sending (GHL parity) requires an ESP
integration (Resend/Postmark/SES/Mailgun) with domain authentication. That is a separate epic, not part of
this ticket. This ticket delivers the inline-compose experience within the Gmail-sender constraint.

---

## After B1 + B2

The remaining audit items (empty-state polish is folded into B2; then on-node validation badges, drawer
standardization + NodePanel sub-split, status pill, trigger polish, testing elevation, card standardization)
become B3+ once these two land and you've click-tested them. I'll write those after B1/B2 are approved —
no point speccing polish on an interaction model that isn't in yet.
