-- Migration: Per-tenant Retell agent registry + per-step agent selection
-- Created at: 2026-06-18
--
-- Adds the retell_agents table (per-tenant registry of voice agents that call
-- nodes can target) and extends get_call_payload so each call step can target
-- a specific agent via step_spec.retell_agent_id.
--
-- Preserves the upstream `already_completed` short-circuit added in the
-- deployed version of get_call_payload — we only add the per-step agent
-- resolution on top of that.

create table if not exists retell_agents (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  name            text not null,
  agent_id        text not null,                  -- Retell-assigned identifier
  from_number     text,
  description     text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(tenant_id, agent_id)
);

create trigger trg_retell_agents_updated_at before update on retell_agents
  for each row execute function set_updated_at();

alter table retell_agents enable row level security;
create policy "service role full access" on retell_agents
  for all using (auth.role() = 'service_role');
create policy "tenants see own retell_agents" on retell_agents
  for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Backfill from the single-agent credentials path that's been in use until now.
insert into retell_agents (tenant_id, name, agent_id, from_number, description)
select
  tc.tenant_id,
  'Default (from credentials)' as name,
  tc.config->>'agent_id' as agent_id,
  tc.config->>'from_number' as from_number,
  'Auto-backfilled from tenant_credentials on retell_agents migration'
from tenant_credentials tc
where tc.provider = 'retell'
  and tc.active = true
  and tc.config->>'agent_id' is not null
on conflict (tenant_id, agent_id) do nothing;


-- Redefine get_call_payload.
-- Behavior preserved: action-not-found, already-completed short-circuit,
-- lead-not-found, retell-credentials-not-found.
-- Added:  step-spec retell_agent_id override resolved against retell_agents.
create or replace function get_call_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action      actions;
  v_lead        leads;
  v_credentials tenant_credentials;
  v_step_agent_id text;
  v_agent       retell_agents;
  v_resolved_agent_id text;
  v_resolved_from_number text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Action not found');
  end if;

  if v_action.status = 'completed' then
    return jsonb_build_object(
      'outcome',     'already_completed',
      'action_id',   v_action.id,
      'provider_id', v_action.provider_id,
      'reason',      'Action already completed; nothing to do.'
    );
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Lead not found');
  end if;

  select * into v_credentials from tenant_credentials
   where tenant_id = v_action.tenant_id
     and provider  = 'retell'
     and active    = true;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Retell credentials not found');
  end if;

  -- 1. Per-step retell_agent_id override (when the call node picked one in the builder).
  v_step_agent_id := v_action.payload -> 'step_spec' ->> 'retell_agent_id';

  if v_step_agent_id is not null and v_step_agent_id <> '' then
    select * into v_agent
      from retell_agents
     where tenant_id = v_action.tenant_id
       and agent_id  = v_step_agent_id
       and active    = true
     limit 1;
    if found then
      v_resolved_agent_id    := v_agent.agent_id;
      v_resolved_from_number := coalesce(v_agent.from_number, v_credentials.config->>'from_number');
    else
      return jsonb_build_object(
        'outcome', 'failed',
        'reason',  'retell_agent_not_found: ' || v_step_agent_id
      );
    end if;
  else
    -- 2. Legacy single-agent credentials fallback.
    v_resolved_agent_id    := v_credentials.config->>'agent_id';
    v_resolved_from_number := v_credentials.config->>'from_number';
  end if;

  if v_resolved_agent_id is null or v_resolved_agent_id = '' then
    return jsonb_build_object('outcome', 'failed', 'reason', 'No Retell agent configured');
  end if;

  return jsonb_build_object(
    'outcome',                 'success',
    'action_id',               v_action.id,
    'provider_id',             v_action.provider_id,
    'phone_to',                v_lead.phone_e164,
    'first_name',              v_lead.first_name,
    'retell_credential_name',  v_credentials.n8n_credential_name,
    'retell_from_number',      v_resolved_from_number,
    'retell_agent_id',         v_resolved_agent_id
  );
end;
$$;

grant execute on function get_call_payload(uuid) to anon, authenticated, service_role;
