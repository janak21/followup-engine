-- Native call dispatch — n8n removed from the call path entirely.
--
-- Pieces:
--   * pg_net extension enabled (async HTTP from Postgres).
--   * Vault stores internal_dispatch_key — a rotated Bearer secret used by
--     plpgsql to call internal edge functions without exposing the service
--     role key.
--   * get_internal_dispatch_key() helper reads the secret.
--   * dispatch_pending_actions inline-handles call actions: locks each
--     pending call, fires net.http_post to /functions/v1/dispatch-retell-call
--     with the vault secret. The edge function does the rest synchronously
--     (Retell API + record_send_event). Stale-recovery covers worker crashes.
--   * Call action_type removed from the n8n-handed-out batch (still serves
--     sms/email/team_alert/http_request).
--
-- Full bodies in deployed Postgres.

create extension if not exists pg_net with schema extensions;

-- Vault secret + helper + rewritten dispatch_pending_actions are in deployed
-- Postgres (applied via Supabase MCP). This file is the canonical mirror.

select 1 where false;
