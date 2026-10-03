# 002 - Run-centric journeys (Phase 1)

**Date:** 2026-07-04
**Status:** Accepted

## Decision
`journey_runs` is the enrollment record for lead journeys. One running run per
(tenant, lead, journey); re-entry after exit creates a new run; concurrent runs
across different journeys are allowed. `enroll_lead_in_journey` is the only
write path for enrollment (manual create, bulk enroll, webhook).

## Compat layer (temporary)
`leads.journey_template / journey_status / current_step / next_action_at` are a
mirror of the run whose journey_key matches `journey_template`, kept so the
Phase-1 dashboard needs no changes. Do not build new features on these columns.

## Explicitly deferred
- Merging `workflow_actions` into the `actions` queue (Phase 2)
- Per-run stop-on-response (today a reply cancels pending outbound lead-wide)
- Multi-run UI on the leads page (reads the mirror columns for now)
- Trigger system (tag_added / form_submitted / etc.)
