-- Create AI Agents table
create table if not exists ai_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade not null,
  name text not null,
  description text,
  enabled boolean default true not null,
  provider text not null,
  model text not null,
  system_prompt text,
  temperature numeric default 0.7,
  max_tokens integer default 2048,
  escalate_on_intents text[] default '{}'::text[],
  confidence_threshold numeric default 0.7,
  max_replies_per_lead integer default 5,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  unique (tenant_id, name)
);

-- Create AI Agent Knowledge table
create table if not exists ai_agent_knowledge (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references ai_agents(id) on delete cascade not null,
  title text not null,
  content text not null,
  active boolean default true not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- Create AI Reply Events table
create table if not exists ai_reply_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade not null,
  agent_id uuid references ai_agents(id) on delete set null,
  lead_id uuid references leads(id) on delete cascade not null,
  intent text,
  confidence numeric,
  escalation_reason text,
  outbound_action_id uuid references actions(id) on delete set null,
  cost_estimate_usd numeric,
  created_at timestamp with time zone default now() not null
);

-- Add columns to tenants table
alter table tenants add column if not exists default_ai_agent_id uuid references ai_agents(id) on delete set null;
alter table tenants add column if not exists ai_replies_enabled boolean default false not null;

-- Add columns to journeys table
alter table journeys add column if not exists ai_agent_id uuid references ai_agents(id) on delete set null;
