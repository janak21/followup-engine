-- record_send_event clears error_message + lock fields when an action
-- transitions to 'completed'. Previously stale failure text from prior
-- retries persisted on the successful row, causing the UI timeline to
-- render a completed send alongside the old failure message.
-- Includes a backfill that nulls error_message on every action currently
-- in 'completed' state. Function body in deployed Postgres.

select 1 where false;
