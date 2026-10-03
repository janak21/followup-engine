-- Enable required extensions
create extension if not exists "uuid-ossp";

-- Auto-update updated_at on row update function
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- 1. tenants
create table tenants (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text unique not null,
  status          text not null default 'active',
  timezone        text not null default 'America/New_York',
  business_hours  jsonb not null default '{"start":"09:00","end":"17:00","days":["Mon","Tue","Wed","Thu","Fri"]}'::jsonb,
  dedup_key       text not null default 'email',
  config          jsonb not null default '{}'::jsonb,
  team_alert_email text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger trg_tenants_updated_at before update on tenants
  for each row execute function set_updated_at();

alter table tenants enable row level security;
create policy "service role full access" on tenants for all using (auth.role() = 'service_role');
create policy "tenants see own row" on tenants for select using (id::text = auth.jwt() ->> 'tenant_id');

-- 2. tenant_credentials
create table tenant_credentials (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  provider        text not null,
  n8n_credential_name text not null,
  config          jsonb not null default '{}'::jsonb,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique(tenant_id, provider)
);

alter table tenant_credentials enable row level security;
create policy "service role full access" on tenant_credentials for all using (auth.role() = 'service_role');
create policy "tenants see own tenant_credentials" on tenant_credentials for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 3. senders
create table senders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  sender_slot     text not null,
  sender_email    text not null,
  sender_name     text not null,
  n8n_credential_name text not null,
  domain          text not null,
  active          boolean not null default true,
  daily_limit     int not null default 30,
  sent_today      int not null default 0,
  last_reset_date date not null default current_date,
  min_seconds_between_sends int not null default 1200,
  last_sent_at    timestamptz,
  warmup_stage    text not null default 'active',
  health_status   text not null default 'green',
  pause_until     timestamptz,
  total_sent      int not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique(tenant_id, sender_slot)
);

alter table senders enable row level security;
create policy "service role full access" on senders for all using (auth.role() = 'service_role');
create policy "tenants see own senders" on senders for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 4. import_batches
create table import_batches (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  source          text not null,
  source_filename text,
  storage_path    text,
  campaign_type   text,
  template_key    text,
  status          text not null default 'pending',
  total_rows      int,
  inserted        int default 0,
  updated         int default 0,
  skipped         int default 0,
  errors          int default 0,
  error_log       jsonb default '[]'::jsonb,
  uploaded_by     text,
  uploaded_at     timestamptz not null default now(),
  processed_at    timestamptz,
  notes           text
);

alter table import_batches enable row level security;
create policy "service role full access" on import_batches for all using (auth.role() = 'service_role');
create policy "tenants see own import_batches" on import_batches for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 5. leads
create table leads (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  external_id     text,
  source          text not null,
  source_batch_id uuid references import_batches(id),
  first_name      text,
  last_name       text,
  email           text,
  phone_e164      text,
  phone_raw       text,
  address_line1   text,
  city            text,
  state           text,
  zip_code        text,
  timezone        text,
  campaign_type   text,
  journey_template text,
  journey_status  text not null default 'new',
  current_step    int not null default 0,
  last_action_at  timestamptz,
  next_action_at  timestamptz,
  email_thread_id text,
  last_email_message_id text,
  assigned_sender_id uuid references senders(id),
  sms_conversation_count int not null default 0,
  email_conversation_count int not null default 0,
  responded       boolean not null default false,
  opt_out         boolean not null default false,
  opt_out_channel text,
  callback_requested boolean not null default false,
  callback_at     timestamptz,
  raw_payload     jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index leads_tenant_email_uniq on leads(tenant_id, email) where email is not null;
create index leads_tenant_phone_idx on leads(tenant_id, phone_e164) where phone_e164 is not null;
create index leads_next_action_idx on leads(tenant_id, next_action_at) where journey_status = 'active';

create trigger trg_leads_updated_at before update on leads
  for each row execute function set_updated_at();

alter table leads enable row level security;
create policy "service role full access" on leads for all using (auth.role() = 'service_role');
create policy "tenants see own leads" on leads for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 6. actions
create table actions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  lead_id         uuid not null references leads(id) on delete cascade,
  action_type     text not null,
  step_index      int not null,
  template_key    text,
  run_at          timestamptz not null,
  status          text not null default 'pending',
  attempt_number  int not null default 0,
  locked_until    timestamptz,
  locked_by       text,
  idempotency_key text not null,
  provider        text,
  provider_id     text,
  error_message   text,
  payload         jsonb not null default '{}'::jsonb,
  result          jsonb default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique(tenant_id, idempotency_key)
);

create index actions_due_idx on actions(run_at, status) where status = 'pending';
create index actions_lead_idx on actions(lead_id);

alter table actions enable row level security;
create policy "service role full access" on actions for all using (auth.role() = 'service_role');
create policy "tenants see own actions" on actions for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 7. events
create table events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  lead_id         uuid references leads(id) on delete cascade,
  action_id       uuid references actions(id),
  channel         text not null,
  direction       text not null,
  provider        text not null,
  provider_id     text,
  from_address    text,
  to_address      text,
  subject         text,
  body            text,
  call_duration_seconds int,
  call_outcome    text,
  call_disposition text,
  call_recording_url text,
  call_transcript text,
  call_summary    text,
  disconnection_reason text,
  is_ai_reply     boolean default false,
  ai_model        text,
  needs_human_review boolean default false,
  raw_payload     jsonb,
  created_at      timestamptz not null default now()
);

create index events_lead_idx on events(lead_id, created_at desc);
create index events_provider_id_idx on events(provider, provider_id);

alter table events enable row level security;
create policy "service role full access" on events for all using (auth.role() = 'service_role');
create policy "tenants see own events" on events for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 8. templates
create table templates (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  template_key    text not null,
  channel         text not null,
  subject         text,
  body            text not null,
  variables       jsonb default '[]'::jsonb,
  notes           text,
  version         int not null default 1,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique(tenant_id, template_key, version)
);

alter table templates enable row level security;
create policy "service role full access" on templates for all using (auth.role() = 'service_role');
create policy "tenants see own templates" on templates for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 9. suppressions
create table suppressions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  channel         text,
  email           text,
  phone_e164      text,
  reason          text not null,
  source          text,
  lead_id         uuid references leads(id),
  notes           text,
  created_at      timestamptz not null default now()
);

create index suppressions_email_idx on suppressions(tenant_id, email) where email is not null;
create index suppressions_phone_idx on suppressions(tenant_id, phone_e164) where phone_e164 is not null;

alter table suppressions enable row level security;
create policy "service role full access" on suppressions for all using (auth.role() = 'service_role');
create policy "tenants see own suppressions" on suppressions for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 10. journeys
create table journeys (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  journey_key     text not null,
  name            text not null,
  spec            jsonb not null,
  version         int not null default 1,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique(tenant_id, journey_key, version)
);

alter table journeys enable row level security;
create policy "service role full access" on journeys for all using (auth.role() = 'service_role');
create policy "tenants see own journeys" on journeys for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 11. error_logs
create table error_logs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid,
  workflow_name   text,
  execution_id    text,
  node_name       text,
  error_message   text not null,
  raw_error       jsonb,
  severity        text not null default 'error',
  status          text not null default 'open',
  created_at      timestamptz not null default now()
);

alter table error_logs enable row level security;
create policy "service role full access" on error_logs for all using (auth.role() = 'service_role');
-- (Internal only table, no tenant access required per PRD)
