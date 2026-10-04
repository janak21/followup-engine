-- [Applied to DEV 2026-07-19] Additive column reconciliation with prod. These
-- columns exist on prod (added during the 2026-07-12 prod repair) and were
-- missing on dev. All idempotent, nullable or defaulted — safe on live data.

alter table public.events add column if not exists email_thread_id text;
alter table public.journeys add column if not exists webhook_last_used_at timestamp with time zone;
alter table public.ai_agent_knowledge add column if not exists updated_at timestamp with time zone not null default now();
alter table public.tenant_invites add column if not exists updated_at timestamp with time zone not null default now();
alter table public.tenant_members add column if not exists updated_at timestamp with time zone not null default now();
