-- [Applied to PROD 2026-07-19] Additive column reconciliation with dev. These
-- columns exist on dev and are written by the dashboard / edge functions;
-- without them the same code errors on prod. All idempotent, nullable or
-- defaulted — safe on live data.

-- AI reply audit trail detail
alter table public.ai_reply_events add column if not exists inbound_event_id uuid;
alter table public.ai_reply_events add column if not exists prompt_tokens integer;
alter table public.ai_reply_events add column if not exists completion_tokens integer;
alter table public.ai_reply_events add column if not exists raw_response jsonb;
alter table public.ai_reply_events add column if not exists reasoning text;

-- Legacy n8n error-log context fields still populated by some writers
alter table public.error_logs add column if not exists execution_id text;
alter table public.error_logs add column if not exists node_name text;

-- Retell agent sync metadata written by the dashboard's agent-sync flow
alter table public.retell_agents add column if not exists language text;
alter table public.retell_agents add column if not exists voice_id text;
alter table public.retell_agents add column if not exists last_synced_at timestamp with time zone;
alter table public.retell_agents add column if not exists raw jsonb default '{}'::jsonb;

-- Segment authorship
alter table public.lead_segments add column if not exists created_by uuid;
