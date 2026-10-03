# 007 — Multi-run operations (Phase 6)

**Date:** 2026-07-04
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