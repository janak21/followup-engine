-- SUPERSEDED. Do not apply.
-- The deployed journey-trigger edge function + process_journey_webhook RPC
-- already implement the result-journey webhook receiver. The remaining gap
-- (call_id lookup + find_only mode) is handled by
-- 20260619150000_journey_webhook_lookup_strategies.sql.
select 1 where false;
