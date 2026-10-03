-- Per-sender Google OAuth tokens + transient state table.
--
-- Each sender carries its own refresh_token (long-lived, used to mint
-- access_tokens) so dispatching email natively only needs:
--   * sender.google_refresh_token              — for the sender
--   * tenant_credentials.config.google_client_id     — per-tenant OAuth client
--   * tenant_credentials.config.google_client_secret — per-tenant OAuth secret
--
-- Per-tenant OAuth client matches the n8n "internal user type" pattern —
-- each tenant brings their own Google Cloud project so no global Google
-- verification is needed.
--
-- google_oauth_states is short-lived CSRF state used during the OAuth
-- redirect flow. Rows older than 30 min are cleaned up on every /start
-- request. Function bodies + UI in deployed code.

select 1 where false;
