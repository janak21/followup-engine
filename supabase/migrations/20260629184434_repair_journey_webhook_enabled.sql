-- Repair remote schema drift for webhook-triggered automations.
-- Local migration 20260627090000_foundational_schema_repair.sql already added
-- this column, but the linked remote project has later event workflow functions
-- without the column they reference. Keep this additive and idempotent.

alter table public.journeys
  add column if not exists webhook_enabled boolean not null default true;
