-- SUPERSEDED / REVERTED. Do not apply.
-- This migration introduced trigger_config.lookup_kind/lookup_path/find_only and
-- _queue_journey_step0 as a way to do per-journey lead-lookup strategies. The
-- approach was over-engineered — webhooks should be dumb. Replaced by a single
-- system-wide convention in 20260619160000_followup_lead_id_convention.sql:
-- outbound stamps followup_lead_id, inbound reads it from a known set of paths.
--
-- The deployed objects from this migration have been dropped via
-- revert_journey_webhook_lookup_strategies on Supabase.
select 1 where false;
