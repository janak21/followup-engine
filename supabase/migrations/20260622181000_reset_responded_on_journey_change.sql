-- AFTER UPDATE trigger on leads: when journey_template changes (re-enrollment
-- into a different journey), reset responded / callback_requested / callback_at
-- and clear the _skip_outbound_until_wait flag. These flags are per-enrollment
-- semantics, not per-lead-forever. A lead that answered a Retell call in
-- Journey A should remain reachable when re-enrolled into Journey B (an SMS
-- test, a nurture flow, a win-back).
-- Function body in deployed Postgres; canonical mirror.

select 1 where false;
