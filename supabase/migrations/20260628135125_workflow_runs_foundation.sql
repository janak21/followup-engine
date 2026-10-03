-- Foundation for future event-based workflows.
-- This migration intentionally does not make actions.lead_id nullable and does
-- not change existing lead-based journey execution behavior.

create extension if not exists pgcrypto;

create table if not exists public.journey_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid references public.journeys(id) on delete set null,
  journey_key text,
  journey_version integer,
  mode text not null default 'lead_journey',
  trigger_type text not null default 'manual',
  status text not null default 'running',
  lead_id uuid references public.leads(id) on delete set null,
  context jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.journey_runs
  add column if not exists journey_id uuid,
  add column if not exists journey_key text,
  add column if not exists journey_version integer,
  add column if not exists mode text not null default 'lead_journey',
  add column if not exists trigger_type text not null default 'manual',
  add column if not exists status text not null default 'running',
  add column if not exists lead_id uuid,
  add column if not exists context jsonb not null default '{}'::jsonb,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists idempotency_key text,
  add column if not exists started_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists last_error text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'journey_runs_tenant_id_fkey'
       and conrelid = 'public.journey_runs'::regclass
  ) then
    alter table public.journey_runs
      add constraint journey_runs_tenant_id_fkey
      foreign key (tenant_id) references public.tenants(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'journey_runs_journey_id_fkey'
       and conrelid = 'public.journey_runs'::regclass
  ) then
    alter table public.journey_runs
      add constraint journey_runs_journey_id_fkey
      foreign key (journey_id) references public.journeys(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'journey_runs_lead_id_fkey'
       and conrelid = 'public.journey_runs'::regclass
  ) then
    alter table public.journey_runs
      add constraint journey_runs_lead_id_fkey
      foreign key (lead_id) references public.leads(id) on delete set null;
  end if;
end $$;

create index if not exists journey_runs_tenant_id_idx on public.journey_runs(tenant_id);
create index if not exists journey_runs_journey_id_idx on public.journey_runs(journey_id);
create index if not exists journey_runs_lead_id_idx on public.journey_runs(lead_id);
create index if not exists journey_runs_status_idx on public.journey_runs(status);
create unique index if not exists journey_runs_tenant_idempotency_key_uniq
  on public.journey_runs(tenant_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists trg_journey_runs_updated_at on public.journey_runs;
create trigger trg_journey_runs_updated_at
  before update on public.journey_runs
  for each row execute function public.set_updated_at();

alter table public.journey_runs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'journey_runs'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.journey_runs
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'journey_runs'
       and policyname = 'tenants see own journey_runs'
  ) then
    create policy "tenants see own journey_runs" on public.journey_runs
      for select
      to authenticated
      using (tenant_id::text = (select auth.jwt()) ->> 'tenant_id');
  end if;
end $$;

alter table public.actions
  add column if not exists run_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'actions_run_id_fkey'
       and conrelid = 'public.actions'::regclass
  ) then
    alter table public.actions
      add constraint actions_run_id_fkey
      foreign key (run_id) references public.journey_runs(id) on delete set null;
  end if;
end $$;

create index if not exists actions_run_id_idx on public.actions(run_id);

create or replace function public.create_journey_run(
  p_tenant_id uuid,
  p_journey_id uuid default null,
  p_journey_key text default null,
  p_journey_version integer default null,
  p_mode text default 'lead_journey',
  p_trigger_type text default 'manual',
  p_lead_id uuid default null,
  p_context jsonb default '{}'::jsonb,
  p_raw_payload jsonb default '{}'::jsonb,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_journey public.journeys;
  v_lead public.leads;
  v_run_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'tenant_id is required';
  end if;

  if p_journey_id is not null then
    select * into v_journey
      from public.journeys
     where id = p_journey_id
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'journey does not belong to tenant';
    end if;
  elsif nullif(trim(coalesce(p_journey_key, '')), '') is not null then
    select * into v_journey
      from public.journeys
     where tenant_id = p_tenant_id
       and journey_key = p_journey_key
     order by version desc
     limit 1;
  end if;

  if p_lead_id is not null then
    select * into v_lead
      from public.leads
     where id = p_lead_id
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'lead does not belong to tenant';
    end if;
  end if;

  insert into public.journey_runs (
    tenant_id,
    journey_id,
    journey_key,
    journey_version,
    mode,
    trigger_type,
    status,
    lead_id,
    context,
    raw_payload,
    idempotency_key
  ) values (
    p_tenant_id,
    coalesce(p_journey_id, v_journey.id),
    coalesce(nullif(trim(coalesce(p_journey_key, '')), ''), v_journey.journey_key),
    coalesce(p_journey_version, v_journey.version),
    coalesce(nullif(trim(coalesce(p_mode, '')), ''), 'lead_journey'),
    coalesce(nullif(trim(coalesce(p_trigger_type, '')), ''), 'manual'),
    'running',
    p_lead_id,
    coalesce(p_context, '{}'::jsonb),
    coalesce(p_raw_payload, '{}'::jsonb),
    nullif(trim(coalesce(p_idempotency_key, '')), '')
  )
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null
  do update set context = public.journey_runs.context
  returning id into v_run_id;

  return v_run_id;
end;
$$;

create or replace function public.attach_lead_to_journey_run(
  p_tenant_id uuid,
  p_run_id uuid,
  p_lead_id uuid
)
returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_run public.journey_runs;
  v_lead public.leads;
begin
  select * into v_run
    from public.journey_runs
   where id = p_run_id
     and tenant_id = p_tenant_id;
  if not found then
    raise exception 'journey run does not belong to tenant';
  end if;

  select * into v_lead
    from public.leads
   where id = p_lead_id
     and tenant_id = p_tenant_id;
  if not found then
    raise exception 'lead does not belong to tenant';
  end if;

  update public.journey_runs
     set lead_id = p_lead_id,
         updated_at = now()
   where id = p_run_id
     and tenant_id = p_tenant_id
  returning id into p_run_id;

  return p_run_id;
end;
$$;

create or replace function public.update_journey_run_context(
  p_tenant_id uuid,
  p_run_id uuid,
  p_patch jsonb
)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_context jsonb;
begin
  update public.journey_runs
     set context = coalesce(context, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb),
         updated_at = now()
   where id = p_run_id
     and tenant_id = p_tenant_id
  returning context into v_context;

  if not found then
    raise exception 'journey run does not belong to tenant';
  end if;

  return v_context;
end;
$$;
