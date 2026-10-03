# 006 — Safe journey editing (Phase 5)

**Date:** 2026-07-04
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