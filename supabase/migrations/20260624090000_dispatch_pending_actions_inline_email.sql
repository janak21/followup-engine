-- Add inline email dispatch (pg_net → dispatch-gmail-email) alongside
-- the existing inline call + sms paths. 'email' is removed from the
-- n8n hand-off set, deprecating W-SEND-EMAIL.
--
-- Same shape as the SMS path:
--   * lock pending emails with status='in_progress' + locked_until
--   * fire-and-forget POST to /functions/v1/dispatch-gmail-email
--   * the edge function calls record_send_event on success or
--     mark_action_failed on any error (retry-with-backoff path)
--
-- Per-tenant Google OAuth client + per-sender refresh token power this;
-- see 20260623160000_gmail_oauth_sender_tokens.sql for the data model.
--
-- W-SEND-EMAIL in n8n should be disabled after this lands to avoid
-- duplicate sends. The status='in_progress' lock would prevent a
-- double-fire anyway, but disabling makes intent explicit.
--
-- Function body in deployed Postgres.

select 1 where false;
