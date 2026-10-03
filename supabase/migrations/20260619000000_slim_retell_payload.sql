-- SUPERSEDED. Do not apply.
-- The deployed process_retell_call_result already splats every
-- call_analysis.custom_analysis_data key into leads.custom_fields and
-- mirrors last_call_* metadata (migration 20260617112915). No per-agent
-- schema declaration is needed. The retell_agents.analysis_schema column
-- introduced in this file is unused.
select 1 where false;
