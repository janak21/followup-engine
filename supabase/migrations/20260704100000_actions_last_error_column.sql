-- actions.last_error never existed, but dispatch_guard_external_action
-- (since 20260627092000) and advance_journey (lead-not-found path) write it.
-- Latent 42703 that fires the first time a guard blocks an action — the guard
-- has never fired in production yet (0 guard rows in error_logs). Same bug
-- class as 20260703130000 (process_wait_action / updated_at). Adding the
-- column matches workflow_actions and leads, and makes every deployed
-- function body valid without touching them.
--
-- Applied to follow-up-dev via Supabase MCP on 2026-07-03.

alter table public.actions
  add column if not exists last_error text;
