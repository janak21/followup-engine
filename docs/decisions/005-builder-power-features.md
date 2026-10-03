# 005 - Builder power features (Phase 4)

**Date:** 2026-07-04
**Status:** Accepted

## Decision
The journey builder supports four operator-facing power features on top of the
single `actions` queue:

- SMS/email steps can store inline message content on the step. Runtime payload
  RPCs resolve `payload.inline.*` first, then `payload.step_spec.inline_*`, then
  templates.
- Conditional splits remain backward-compatible with legacy `yes`/`no`, and can
  optionally define ordered named branches plus `else`. First matching branch
  wins.
- A/B splits are native inline actions. Assignment is deterministic from
  `(lead_id or run_id, step_index)` and emits `a` or `b`.
- Lead journeys can define one replied goal. On inbound reply, existing blanket
  engagement cancellation still runs first; captured runs with a `goto` goal are
  then reactivated and sent to the configured step.

## Runtime contracts
Builder output is saved in `journeys.spec` only; no schema changes were added.
Every native handler reads the queued action's `payload.step_spec`, so already
queued actions continue using the snapshot created at queue time.

Reply goals intentionally do not suppress engagement cancellation. They redirect
after cancellation so pending outbound work is removed before any goal step is
queued.

## Explicitly deferred
- Stable step IDs separate from canvas indexes
- Multiple replied goals or non-reply goal events
- Draft/publish journey versioning
- Nested condition groups deeper than one flat rule list per branch
