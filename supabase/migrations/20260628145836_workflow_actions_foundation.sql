-- Foundation for future event workflow actions.
-- This intentionally does not alter the existing lead-action table, scheduler,
-- journey advancement, webhook intake, or any provider dispatch behavior.

create extension if not exists pgcrypto;

create table if not exists public.workflow_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.journey_runs(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  action_type text not null,
  step_index integer not null,
  run_at timestamptz not null default now(),
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  retry_count integer not null default 0,
  max_retries integer not null default 3,
  next_retry_at timestamptz,
  locked_until timestamptz,
  locked_by text,
  last_error text,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workflow_actions
  add column if not exists tenant_id uuid,
  add column if not exists run_id uuid,
  add column if not exists lead_id uuid,
  add column if not exists action_type text,
  add column if not exists step_index integer,
  add column if not exists run_at timestamptz not null default now(),
  add column if not exists status text not null default 'pending',
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists result jsonb not null default '{}'::jsonb,
  add column if not exists idempotency_key text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retries integer not null default 3,
  add column if not exists next_retry_at timestamptz,
  add column if not exists locked_until timestamptz,
  add column if not exists locked_by text,
  add column if not exists last_error text,
  add column if not exists completed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_tenant_id_fkey'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_tenant_id_fkey
      foreign key (tenant_id) references public.tenants(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_run_id_fkey'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_run_id_fkey
      foreign key (run_id) references public.journey_runs(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_lead_id_fkey'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_lead_id_fkey
      foreign key (lead_id) references public.leads(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_tenant_id_not_null'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_tenant_id_not_null check (tenant_id is not null) not valid;
    alter table public.workflow_actions validate constraint workflow_actions_tenant_id_not_null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_run_id_not_null'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_run_id_not_null check (run_id is not null) not valid;
    alter table public.workflow_actions validate constraint workflow_actions_run_id_not_null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_action_type_not_null'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_action_type_not_null check (action_type is not null and btrim(action_type) <> '') not valid;
    alter table public.workflow_actions validate constraint workflow_actions_action_type_not_null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_step_index_not_null'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_step_index_not_null check (step_index is not null) not valid;
    alter table public.workflow_actions validate constraint workflow_actions_step_index_not_null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_actions_idempotency_key_not_null'
       and conrelid = 'public.workflow_actions'::regclass
  ) then
    alter table public.workflow_actions
      add constraint workflow_actions_idempotency_key_not_null check (idempotency_key is not null and btrim(idempotency_key) <> '') not valid;
    alter table public.workflow_actions validate constraint workflow_actions_idempotency_key_not_null;
  end if;
end $$;

create unique index if not exists workflow_actions_tenant_idempotency_key_uniq
  on public.workflow_actions(tenant_id, idempotency_key);

create index if not exists workflow_actions_tenant_run_idx
  on public.workflow_actions(tenant_id, run_id);

create index if not exists workflow_actions_lead_id_idx
  on public.workflow_actions(lead_id)
  where lead_id is not null;

create index if not exists workflow_actions_pending_due_idx
  on public.workflow_actions(status, run_at)
  where status = 'pending';

create index if not exists workflow_actions_tenant_type_status_idx
  on public.workflow_actions(tenant_id, action_type, status);

drop trigger if exists trg_workflow_actions_updated_at on public.workflow_actions;
create trigger trg_workflow_actions_updated_at
  before update on public.workflow_actions
  for each row execute function public.set_updated_at();

alter table public.workflow_actions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'workflow_actions'
       and policyname = 'service role full access'
  ) then
    create policy "service role full access" on public.workflow_actions
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'workflow_actions'
       and policyname = 'tenants see own workflow_actions'
  ) then
    create policy "tenants see own workflow_actions" on public.workflow_actions
      for select
      to authenticated
      using (tenant_id::text = (select auth.jwt()) ->> 'tenant_id');
  end if;
end $$;

create or replace function public.reschedule_workflow_action(
  p_workflow_action_id uuid,
  p_run_at timestamptz,
  p_reason text default null
)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
begin
  if p_workflow_action_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_run_at is null then
    raise exception 'p_run_at is required';
  end if;

  update public.workflow_actions
     set status = 'pending',
         run_at = p_run_at,
         next_retry_at = null,
         locked_until = null,
         locked_by = null,
         last_error = left(coalesce(p_reason, last_error), 2000),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'rescheduled_at', now(),
           'reschedule_reason', p_reason
         )
   where id = p_workflow_action_id
   returning * into v_action;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  return jsonb_build_object(
    'status', 'rescheduled',
    'workflow_action_id', v_action.id,
    'run_at', v_action.run_at,
    'retry_count', v_action.retry_count
  );
end;
$$;

create or replace function public.mark_workflow_action_failed(
  p_workflow_action_id uuid,
  p_error_message text,
  p_max_retries integer default null
)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_max integer;
  v_new_count integer;
  v_next timestamptz;
begin
  select *
    into v_action
    from public.workflow_actions
   where id = p_workflow_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_action.status in ('completed', 'failed_permanent', 'cancelled') then
    return jsonb_build_object('status', 'already_terminal', 'existing_status', v_action.status);
  end if;

  v_max := greatest(coalesce(p_max_retries, v_action.max_retries, 3), 0);
  v_new_count := coalesce(v_action.retry_count, 0) + 1;

  if v_new_count < v_max then
    v_next := case v_new_count
      when 1 then now() + interval '1 minute'
      when 2 then now() + interval '5 minutes'
      when 3 then now() + interval '30 minutes'
      else now() + interval '2 hours'
    end;

    update public.workflow_actions
       set status = 'pending',
           retry_count = v_new_count,
           next_retry_at = v_next,
           run_at = v_next,
           locked_until = null,
           locked_by = null,
           last_error = left(p_error_message, 2000),
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'last_failure_at', now(),
             'last_failure_message', left(p_error_message, 2000)
           )
     where id = p_workflow_action_id;

    return jsonb_build_object(
      'status', 'rescheduled',
      'retry_count', v_new_count,
      'next_retry_at', v_next
    );
  end if;

  update public.workflow_actions
     set status = 'failed_permanent',
         retry_count = v_new_count,
         next_retry_at = null,
         locked_until = null,
         locked_by = null,
         failed_at = now(),
         last_error = left(p_error_message, 2000),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'failed_permanent_at', now(),
           'failure_message', left(p_error_message, 2000)
         )
   where id = p_workflow_action_id;

  insert into public.error_logs (
    tenant_id, workflow_name, error_message, raw_error, severity, status
  ) values (
    v_action.tenant_id,
    'workflow_action_failed_permanent',
    coalesce(p_error_message, 'unspecified'),
    jsonb_build_object(
      'workflow_action_id', p_workflow_action_id,
      'action_type', v_action.action_type,
      'retry_count', v_new_count,
      'max_retries', v_max,
      'step_index', v_action.step_index,
      'run_id', v_action.run_id,
      'lead_id', v_action.lead_id
    ),
    'error',
    'open'
  );

  return jsonb_build_object(
    'status', 'failed_permanent',
    'retry_count', v_new_count,
    'max_retries', v_max
  );
end;
$$;
