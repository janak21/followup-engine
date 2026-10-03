-- Phase 1 schema for AI Agents (data model + UI; LLM wiring is Phase 2).
--
-- Tables created:
--   ai_agents             — operator-configured agents (per tenant)
--   ai_agent_knowledge    — text snippets for prompt grounding (v1 = no embeddings)
--   ai_reply_events       — audit trail of every AI decision (reply or escalate)
--
-- Columns added:
--   tenants.default_ai_agent_id  — fallback agent when journey has no override
--   tenants.ai_replies_enabled   — master kill switch per tenant (default OFF)
--   journeys.ai_agent_id         — optional per-journey override
--
-- All new tables have service-role-only RLS policies. The dashboard
-- reaches them through API routes that scope by tenant_id.
--
-- Function bodies + indexes in deployed Postgres.

select 1 where false;
