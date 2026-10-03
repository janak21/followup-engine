# 003 — Single-queue engine (Phase 2)

**Date:** 2026-07-04
**Status:** Accepted

## Decision
`actions` is the only work queue. Event workflows run as journey_runs whose
actions live in `actions` (leadless until create/find-lead attaches one).
`workflow_actions` is archived as `workflow_actions_archived`; its dispatcher,
advancement function, and handlers are dropped (11 functions + the run-failure
trigger, exact signatures in `20260704120000_decommission_workflow_actions`).
One dispatcher, one guard, one advancement function.

## Invariants
- `actions.lead_id` nullable ONLY for event-native types (CHECK constraint
  `actions_lead_required_types`)
- next-step actions inherit `journey_runs.lead_id` at insert
- never CREATE OR REPLACE a function without diffing the deployed body first
- never introduce function overloads in migrations

## Decommission gate (met 2026-07-04)
0 in-flight workflow_actions, 0 new rows in 24h, 0 workflow errors in 24h,
0 external callers of the dropped functions (live pg_proc scan).

## Deferred
- Dropping `workflow_actions_archived` — after 30 days (early August 2026)
- `dispatch-workflow-http-request` edge function: removed from the repo; the
  deployed copy must be deleted from the Supabase dashboard (no MCP delete)
