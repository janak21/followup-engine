-- get_call_payload renders step-declared dynamic variables and returns them
-- as retell_dynamic_variables. Baseline always includes followup_lead_id,
-- lead_id, first_name so step config is additive. Values are merge-tag
-- rendered against the lead via resolve_merge_tags — one agent can be
-- reused across many journeys with different runtime context.
-- Full function body in deployed Postgres.

select 1 where false;
