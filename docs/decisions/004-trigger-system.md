# 004 - Event-driven trigger system (Phase 3)

**Date:** 2026-07-04
**Status:** Accepted

## Decision

`journey_triggers` is the indexed registry, synced from `journeys.spec` by a DB trigger on save. `fire_journey_triggers` evaluates per-type filters and enrolls through `enroll_lead_in_journey`.

Firing points are DB triggers on `leads` for `lead_created` and `tag_added`, plus explicit calls in `process_inbound_sms` and `process_inbound_email` for `incoming_sms` and `email_replied`.

Loop protection uses the one-running-run index, same-trigger cooldown with a default of 60 minutes, and a transaction-local depth guard capped at 2.

## Re-enrollment Policy

`spec.reenrollment` supports `allow` by default and `once_ever`. The policy is enforced inside `enroll_lead_in_journey`, so every enrollment path gets the same behavior.

## Deferred

- Multiple triggers per journey; the registry supports it, but the builder remains single-trigger.
- `field_changed` and `missed_call` triggers.
- `form_submitted` alias for webhook.
- Goal events, multi-branch conditions, and A/B split were handled separately in Phase 4.
