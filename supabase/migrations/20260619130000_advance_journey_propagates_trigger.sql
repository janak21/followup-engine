-- SUPERSEDED. Do not apply.
-- The deployed pipeline writes the webhook payload into leads.raw_payload
-- (in process_journey_webhook), and resolve_merge_tags reads from there for
-- the {{raw_payload.path}} namespace — so payload propagation to downstream
-- steps already works via the leads row rather than per-action payload.
select 1 where false;
