# Journey Builder — UX Audit vs GoHighLevel (GHL)

Author: orchestrator review · Reference standard: GHL Workflow Builder · Scope: `dashboard/src/app/journeys/builder/`
Chosen direction (already decided): **keep the React Flow canvas + the outcome-based data model, add GHL-style
inline "+" add-and-auto-connect plus an auto-layout pass.** This document is the audit that precedes the
implementation plan; it does not itself contain tickets.

---

## 1. Method and the one finding that matters

I read the actual builder code path (canvas, `onConnect`, the step-type registry in `journeyStepTypes.js`,
the config drawer, validation via `validateJourneySpec`, draft/publish, webhook samples, funnel/executions
drawers) and benchmarked each interaction against how GHL's workflow builder handles the same job.

**The single most important finding:** your builder is a *free-form graph editor*; GHL is a *guided flow
composer*. Your data model is competitive — arguably richer than GHL. Your **interaction model is where the
ease-of-use gap lives**, and it concentrates in one place: **adding a step and connecting it.** Today a user
must (a) get a new step onto the canvas, (b) drag it into position, and (c) drag a line from the correct
outcome handle to the correct target. GHL collapses all three into a single click on a "+" that inserts,
places, and links the step automatically. Everything else in this audit is secondary to closing that gap.

---

## 2. What to preserve (do not "fix" these — they are strengths)

Before the critique, the parts that are genuinely good and must survive any redesign:

- **The outcome data model.** Each step type declares typed, color-coded outcomes (a call has 7: answered,
  no-answer, voicemail, busy, failed, invalid, wrong-number; SMS has sent/failed/opted-out; email
  sent/bounced; wait-for-reply replied/timeout). This is first-class per-outcome branching and is *more*
  expressive than GHL's generic If/Else. Keep it. The inline-"+" work must build on this, not replace it.
- **Draft → Publish with versioning.** Publishing versions the spec and lets in-flight leads finish on their
  current version and pick up the new one on their next step. That is correct, safe semantics that many
  competitors get wrong. Keep the model; only improve how it's surfaced.
- **Pre-publish validation.** `validateJourneySpec` produces a readiness status that blocks saving/publishing
  an active workflow with errors. The guardrail exists; the audit is about making it *guide* rather than
  just *block*.
- **Testing affordances.** Webhook sample capture + a JSON-path explorer for payload mapping, and per-sender
  test-send, are real strengths GHL users often lack. Keep and surface them better.
- **Observability.** The executions and funnel drawers (per-step reach, drop-off) are a differentiator. Keep.

---

## 3. Screen-by-screen / dimension audit

Each item: **Current** (what the code does today) → **GHL standard** → **Gap & severity** → **Direction**
(aligned to the chosen inline-"+" + auto-layout model).

### 3.1 First run / empty state — severity: HIGH

**Current.** A new journey opens to a near-empty canvas with a trigger node placed at a fixed coordinate
(`triggerPos = {x:250, y:50}`). There is no explicit "empty state" guidance; the code even notes saved nodes
can sit off-screen "looking empty." A first-time user sees a canvas and a trigger and must infer what to do.

**GHL.** Opens with the trigger slot and an obvious, labeled "+ Add your first action" affordance directly
beneath it. The next action is never ambiguous.

**Gap & severity.** HIGH. The hardest moment in any builder is the first 10 seconds. Right now there is no
directed call-to-action, and off-screen nodes can make a non-empty journey look broken.

**Direction.** A designed empty state: trigger card at top with a single prominent "+" beneath it and one line
of copy ("Add the first step of your follow-up"). Always `fitView` on load so nothing hides off-screen.

### 3.2 Adding a step — severity: CRITICAL (the core gap)

**Current.** There is no inline add affordance between steps. New steps are created and then must be
positioned; branching is wired by hand. There is no categorized, searchable action picker — the user works
from the canvas outward.

**GHL.** A "+" sits between every pair of connected steps and after the last step. Clicking it opens a
categorized, searchable action picker (Communication, Conditions/Wait, Contact/Internal, etc.). Choosing an
action inserts it *in sequence*, auto-places it, and auto-connects it. The user never thinks about coordinates
or edges.

**Gap & severity.** CRITICAL. This is the difference between "a tool a non-technical operator enjoys" and "a
tool that needs a training call." It is the highest-leverage change in the entire builder.

**Direction.** Add inline "+" buttons rendered on edges and after leaf nodes. Clicking opens an action picker
grouped by the categories your step registry already implies (Communication: SMS/email/call/team-alert;
Timing: wait/wait-for-reply; Logic: condition-split/ab-split; Lead ops: add/remove-tag, create/update/find
lead; Integrations: webhook). On select: create the step, insert it into the sequence, set the source step's
`on_outcome[default]` (or the chosen outcome) to the new step, and run the auto-layout pass so it lands in the
right place. For multi-outcome steps (call/SMS), the "+" should appear per outcome handle so users add a
branch by clicking the "+" under "no answer," not by drawing a line.

### 3.3 Connecting & branching — severity: HIGH

**Current.** `onConnect` requires the user to drag from an outcome handle to a target node; only then is
`on_outcome[handle] = { next_step }` written. Forgetting to connect an outcome silently leaves a dead branch.

**GHL.** Branches are created by the structure itself (If/Else, Split) and are always visibly connected;
there is no way to leave an "unwired" outcome dangling because the UI builds the connection for you.

**Gap & severity.** HIGH. Manual edge-drawing is the #2 source of user error after step-adding, and the two
are the same underlying problem. Unconnected outcomes are a correctness footgun that validation catches only
at save time.

**Direction.** With inline "+", the common path (add-and-auto-connect) removes most manual edge-drawing. Keep
manual drag-to-connect as a power feature for re-wiring, but make **unconnected outcomes visually obvious on
the canvas** (e.g. a dashed "+ add step" stub hanging off every unwired outcome handle) rather than invisible
until validation.

### 3.4 Auto-layout & canvas ergonomics — severity: HIGH

**Current.** Nodes are manually positioned; `onNodeDragStop` persists x/y back to each step. There is a
MiniMap, Controls, and `fitView` on load, but no automatic layout — a journey's readability depends entirely
on the user's manual arrangement. Complex journeys drift into crossing edges and overlap.

**GHL.** Fully automatic vertical layout. Users never position anything; the graph is always tidy.

**Gap & severity.** HIGH. Auto-layout is the other half of the inline-"+" change — without it, auto-inserted
steps have nowhere sensible to go.

**Direction.** Introduce a layered top-down auto-layout (e.g. dagre-style) computed from the `on_outcome`
graph. Run it on add/delete and expose a manual "Tidy up" button. Preserve the ability to nudge nodes for
users who want it, but default to auto. This keeps your React Flow canvas while delivering GHL's tidiness.

### 3.5 Configuring a step — the drawer — severity: MEDIUM

**Current.** A single right-side drawer (~2,100 lines pre-refactor) renders a bespoke editor per step type:
trigger config, wait, sms/email/team-alert with inline template editing, http_request, tag ops,
conditional_split (with an inline rule editor), ab_split, and the create/update/find-lead family with payload
mapping. It is feature-rich and the per-type editors are thorough.

**GHL.** A right panel with a consistent header (icon, action name, rename), a compact body, and a clear
primary save. Config density is lower per screen; advanced options are progressively disclosed.

**Gap & severity.** MEDIUM. Your drawer is *more* capable than GHL but denser and less consistent — each step
type is its own layout. The risk is cognitive load, not missing capability.

**Direction.** Standardize the drawer chrome across step types: same header pattern (icon + editable step
name + outcome legend), same primary-action placement, progressive disclosure of advanced fields (e.g. hide
payload-mapping until the user expands "Advanced"). This is where the deferred NodePanel sub-split (builder
Phase 3) pays off — do the standardization and the file split together, once.

### 3.6 Trigger setup — severity: MEDIUM

**Current.** Trigger configuration lives in the drawer; e.g. a source-value trigger with copy "Starts when a
new lead is created with this source value. Leave empty to trigger on any source." Functional but terse, and
the trigger is one node among many rather than a distinguished entry point.

**GHL.** Triggers are a visually distinct top section with human-readable summaries ("Contact created where
source = Webinar") and multiple triggers supported.

**Gap & severity.** MEDIUM. The trigger reads as "just another node," and its configuration language is
system-oriented rather than outcome-oriented.

**Direction.** Give the trigger a distinct visual treatment at the top of the flow, a plain-language summary
on the card ("Starts when: new lead, source = …"), and clearer copy. Multiple triggers is a later scope
question, not part of this pass.

### 3.7 Validation & error prevention — severity: MEDIUM

**Current.** `validateJourneySpec` yields a readiness status; an "invalid" status blocks saving/publishing an
active workflow ("Fix journey readiness errors before saving an active workflow"). Validation is a gate at
save/publish time.

**GHL.** Prevents most invalid states by construction (you can't leave a branch unwired), and flags the rest
inline on the offending step.

**Gap & severity.** MEDIUM. Blocking at save is correct but late — the user learns about problems after
building, not while building.

**Direction.** Surface readiness errors **on the specific nodes** (a warning badge on the step that's
misconfigured, with the message on hover/click) in addition to the save-time gate. Pair with 3.3 so unwired
outcomes show as visible stubs. Move from "gate" to "guide + gate."

### 3.8 Testing a journey — severity: MEDIUM

**Current.** Webhook sample capture, a JSON-path explorer for mapping payload fields, sample replay, and
per-sender test-send exist but are somewhat buried in the drawer/panels.

**GHL.** A visible "Test" action and enrollment history make it easy to prove a flow works before going live.

**Gap & severity.** MEDIUM — capability is present, discoverability is low. This is a strength you're
under-selling.

**Direction.** Elevate testing to a visible builder-level action ("Test with sample") near Save/Publish, and
make the sample-driven payload mapping a guided step rather than an expert affordance.

### 3.9 Save / draft / publish — severity: LOW–MEDIUM

**Current.** `SaveControls` shows last-saved time; draft save produces "Draft saved — not live yet. Publish to
make it live." Publish reports the version and how many running leads are affected. Semantics are excellent.

**GHL.** Draft/Publish toggle with a clear live/unpublished indicator.

**Gap & severity.** LOW–MEDIUM. The model is strong; the surfacing can be clearer about *live vs draft vs
unpublished-changes* at a glance.

**Direction.** A persistent status pill in the header (Live / Draft / Unpublished changes) with the version
number, so the user always knows what state the journey is in without reading a toast.

### 3.10 Observability — executions & funnel — severity: LOW

**Current.** Executions tab (recent enrolled leads + their action chain) and a funnel drawer (per-step reach,
median time-to-next, drop-off). Genuinely strong.

**GHL.** Enrollment history and basic stats.

**Gap & severity.** LOW. You're at or ahead of parity. Just make the funnel more discoverable from the canvas
(e.g. show per-step reach counts on the node cards once a journey is live).

### 3.11 Visual hierarchy & polish — severity: MEDIUM

**Current.** Node cards render icon + label + a template preview; outcomes are color-coded. Reasonable, but
density and consistency vary by node type, and the free layout undermines visual rhythm.

**GHL.** Uniform card sizing, consistent iconography, generous vertical rhythm from the enforced layout.

**Gap & severity.** MEDIUM, and largely *downstream* of auto-layout (3.4) — tidy layout does most of the
visual-polish work for free.

**Direction.** After auto-layout lands, standardize card dimensions and the outcome-chip treatment so every
step reads at a glance.

---

## 4. Severity-ranked summary

| # | Area | Severity | Why it matters |
|---|------|----------|----------------|
| 3.2 | Adding a step (inline "+") | CRITICAL | The core ease-of-use gap; one click should insert+place+connect |
| 3.1 | First-run / empty state | HIGH | Worst friction is the first 10 seconds; no directed CTA today |
| 3.3 | Connecting & branching | HIGH | Manual edge-drawing = #2 error source; unwired outcomes invisible |
| 3.4 | Auto-layout | HIGH | The other half of inline-"+"; without it new steps have no home |
| 3.5 | Config drawer consistency | MEDIUM | More capable than GHL but dense/inconsistent; pair with Phase 3 split |
| 3.6 | Trigger setup | MEDIUM | Trigger reads as "just a node"; copy is system-oriented |
| 3.7 | Validation surfacing | MEDIUM | Blocks at save; should guide inline on nodes while building |
| 3.8 | Testing discoverability | MEDIUM | Strength that's buried; elevate to a visible action |
| 3.11 | Visual hierarchy | MEDIUM | Mostly solved for free once auto-layout lands |
| 3.9 | Save/draft/publish surfacing | LOW–MED | Great semantics; needs an at-a-glance status pill |
| 3.10 | Observability | LOW | At/above parity; surface funnel on canvas |

---

## 5. Recommended implementation sequence (preview — full tickets come next)

Not tickets yet, but the order the tickets should follow, because dependencies matter:

1. **Auto-layout engine first (3.4).** Inline-"+" is not usable until new steps auto-place. Build the
   top-down layered layout over the `on_outcome` graph, with a "Tidy up" button, before the add-flow.
2. **Inline "+" add-and-auto-connect (3.2, 3.3).** The headline change. Per-outcome "+" stubs, categorized
   searchable picker, insert+connect+relayout on select. Depends on #1.
3. **Empty state + always-fitView (3.1).** Small, high-impact, do alongside #2.
4. **On-node validation + unwired-outcome stubs (3.7, 3.3).** Turn the save-gate into inline guidance.
5. **Drawer standardization + NodePanel sub-split (3.5).** Do the consistency pass and the deferred Phase-3
   file split together.
6. **Status pill, trigger polish, testing elevation, card standardization (3.9, 3.6, 3.8, 3.11).** Polish
   tier, after the structural wins.

Each of these will become a self-contained agent ticket with acceptance criteria and live click-through
verification (these are behavioral UI changes — build+test+lint is necessary but not sufficient; each needs
the app running and a manual parity/behavior check).

---

## 6. Assumptions & open questions

- **GHL as "standard" means its interaction ergonomics, not a pixel copy.** The recommendations adopt GHL's
  add-and-auto-connect and auto-layout model while keeping your richer outcome branching and your
  draft/publish/versioning — do not discard those to look more like GHL.
- **Single trigger per journey** is assumed for this pass (matches current model). Multiple triggers is a
  separate scope decision.
- **Auto-layout library:** a dagre-style layered layout is the likely fit for a React Flow graph; final
  choice is an implementation-ticket decision, not an audit decision.
- **Risk framing:** every change here is UI-layer and does not touch the dispatch engine, the RPCs, or the
  secrets/isolation work already hardened. The regression risk is contained to the builder page and its
  components, and each ticket must be verified with a live click-through because static diff cannot prove UI
  behavior.
