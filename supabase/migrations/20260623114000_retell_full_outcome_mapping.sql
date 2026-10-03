-- Maps every Retell disconnection_reason from the official docs to a
-- canonical builder outcome. Previously busy/failed sockets were drawn
-- in the builder but never fired because the RPC only ever emitted
-- answered/no_answer/voicemail/invalid_number. Now every reason routes
-- explicitly; unknown reasons default to 'failed'.
--
-- Reference: https://docs.retellai.com/reliability/debug-call-disconnect
-- Function body in deployed Postgres.

select 1 where false;
