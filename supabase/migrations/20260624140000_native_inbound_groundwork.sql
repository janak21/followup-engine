-- Native inbound groundwork:
--   * dashboard_summary "Recent Replies" filtered to leads-in-system
--     (lead_id NOT NULL) and excludes bounce events.
--   * get_email_payload + get_sms_payload honor payload.inline = {subject,
--     body, body_plain?, body_format?} for operator-typed inline replies.
--     Sentinel template_key '__inline_reply__' carries the queue
--     (throttle, retry, sender selection) without needing a per-reply
--     template row.
--   * senders gains gmail_history_id (delta cursor), gmail_last_polled_at,
--     gmail_poll_error, gmail_readonly_granted. Together they power the
--     new poll-gmail-inbox edge function.
--
-- Function bodies in deployed Postgres. Edge fn deployed separately.

select 1 where false;
