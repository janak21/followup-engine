-- Native Twilio SMS dispatch — n8n removed from the SMS path.
-- Mirrors the call-dispatch pattern from 20260623130000:
--   * Edge function /functions/v1/dispatch-twilio-sms does the Retell-equivalent
--     job for Twilio (reads tenant creds, POSTs to Twilio /Messages.json with
--     StatusCallback wired to twilio-status, calls record_send_event).
--   * dispatch_pending_actions inline-handles sms via pg_net.
--   * action_type='sms' is no longer returned to n8n's batch.
--
-- Full dispatch_pending_actions body in deployed Postgres (canonical source).

select 1 where false;
