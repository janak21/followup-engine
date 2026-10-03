-- Foundational schema repair for fresh migration replay.
-- Adds low-risk columns and app support tables referenced by checked-in code.

create extension if not exists pgcrypto;

-- Actions retry/lock columns used by mark_action_failed and operations views.
alter table public.actions
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retries integer not null default 3,
  add column if not exists next_retry_at timestamptz,
  add column if not exists locked_until timestamptz,
  add column if not exists locked_by text,
  add column if not exists last_error text;

-- Sender Gmail/OAuth/throttle columns used by native Gmail dispatch and polling.
alter table public.senders
  add column if not exists google_refresh_token text,
  add column if not exists google_access_token text,
  add column if not exists google_token_expires_at timestamptz,
  add column if not exists google_client_id text,
  add column if not exists google_client_secret text,
  add column if not exists google_connected_at timestamptz,
  add column if not exists google_scopes text,
  add column if not exists gmail_readonly_granted boolean not null default false,
  add column if not exists gmail_history_id text,
  add column if not exists gmail_last_polled_at timestamptz,
  add column if not exists gmail_poll_error text,
  add column if not exists sent_today integer not null default 0,
  add column if not exists daily_limit integer not null default 50,
  add column if not exists last_reset_date date,
  add column if not exists min_seconds_between_sends integer not null default 60,
  add column if not exists pause_until timestamptz,
  add column if not exists warmup_stage text default 'active',
  add column if not exists health_status text default 'green',
  add column if not exists last_sent_at timestamptz,
  add column if not exists active boolean not null default true;

-- Event columns used by Gmail inbound dedupe/threading paths.
alter table public.events
  add column if not exists gmail_api_message_id text,
  add column if not exists email_thread_id text,
  add column if not exists raw_payload jsonb default '{}'::jsonb;

create unique index if not exists events_gmail_inbound_message_uniq
  on public.events (tenant_id, channel, direction, gmail_api_message_id)
  where channel = 'email'
    and direction = 'inbound'
    and gmail_api_message_id is not null;

-- Journey webhook columns used by dashboard webhook routes and process_journey_webhook.
alter table public.journeys
  add column if not exists webhook_token text,
  add column if not exists webhook_enabled boolean not null default true,
  add column if not exists webhook_last_used_at timestamptz,
  add column if not exists webhook_auth_mode text not null default 'none',
  add column if not exists webhook_secret text,
  add column if not exists ai_agent_id uuid;

create unique index if not exists journeys_webhook_token_uniq
  on public.journeys (webhook_token)
  where webhook_token is not null;

-- Template body-format columns used by native email payload rendering.
alter table public.templates
  add column if not exists body_plain text,
  add column if not exists body_format text not null default 'plain';

-- Minimal app support tables referenced by dashboard API routes.
create table if not exists public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  role text not null default 'client_viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table if not exists public.tenant_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  email text not null,
  role text not null default 'client_viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email, tenant_id)
);

create table if not exists public.tenant_usage_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  day date not null,
  channel text not null,
  msg_count integer not null default 0,
  units numeric not null default 0,
  est_cost_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, day, channel)
);

create table if not exists public.lead_segments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists public.google_oauth_states (
  state text primary key,
  tenant_id uuid not null,
  sender_id uuid not null,
  redirect_after text,
  created_at timestamptz not null default now()
);

create table if not exists public.retell_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  phone_number text not null,
  phone_number_pretty text,
  nickname text,
  inbound_agent_id text,
  outbound_agent_id text,
  area_code integer,
  active boolean not null default true,
  last_synced_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, phone_number)
);

alter table public.tenant_members enable row level security;
alter table public.tenant_invites enable row level security;
alter table public.tenant_usage_daily enable row level security;
alter table public.lead_segments enable row level security;
alter table public.google_oauth_states enable row level security;
alter table public.retell_phone_numbers enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'tenant_members'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.tenant_members
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'tenant_invites'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.tenant_invites
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'tenant_usage_daily'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.tenant_usage_daily
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'lead_segments'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.lead_segments
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'google_oauth_states'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.google_oauth_states
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'retell_phone_numbers'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.retell_phone_numbers
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

create index if not exists tenant_members_tenant_idx on public.tenant_members (tenant_id);
create index if not exists tenant_invites_tenant_idx on public.tenant_invites (tenant_id);
create index if not exists tenant_usage_daily_tenant_day_idx on public.tenant_usage_daily (tenant_id, day);
create index if not exists lead_segments_tenant_idx on public.lead_segments (tenant_id);
create index if not exists google_oauth_states_created_at_idx on public.google_oauth_states (created_at);
create index if not exists retell_phone_numbers_tenant_idx on public.retell_phone_numbers (tenant_id);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_members_updated_at') then
    create trigger trg_tenant_members_updated_at
      before update on public.tenant_members
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_invites_updated_at') then
    create trigger trg_tenant_invites_updated_at
      before update on public.tenant_invites
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_usage_daily_updated_at') then
    create trigger trg_tenant_usage_daily_updated_at
      before update on public.tenant_usage_daily
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_lead_segments_updated_at') then
    create trigger trg_lead_segments_updated_at
      before update on public.lead_segments
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_retell_phone_numbers_updated_at') then
    create trigger trg_retell_phone_numbers_updated_at
      before update on public.retell_phone_numbers
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Token helpers used by dashboard webhook routes.
create or replace function public.ensure_journey_webhook_token(p_journey_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  select webhook_token
    into v_token
    from public.journeys
   where id = p_journey_id
   for update;

  if not found then
    raise exception 'journey not found: %', p_journey_id;
  end if;

  if v_token is null or v_token = '' then
    v_token := 'jwh_' || encode(gen_random_bytes(24), 'hex');
    update public.journeys
       set webhook_token = v_token
     where id = p_journey_id;
  end if;

  return v_token;
end;
$$;

create or replace function public.rotate_journey_webhook_token(p_journey_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if not exists (select 1 from public.journeys where id = p_journey_id) then
    raise exception 'journey not found: %', p_journey_id;
  end if;

  v_token := 'jwh_' || encode(gen_random_bytes(24), 'hex');
  update public.journeys
     set webhook_token = v_token
   where id = p_journey_id;

  return v_token;
end;
$$;
