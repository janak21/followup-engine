-- Phase 5: draft/publish for journeys. Edits land in draft_spec; the engine
-- reads spec only. Publishing is atomic: copy, bump version, audit, clear.

alter table public.journeys
  add column if not exists draft_spec jsonb,
  add column if not exists draft_updated_at timestamptz;

create table if not exists public.journey_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  version integer not null,
  spec jsonb not null,
  published_at timestamptz not null default now(),
  published_by uuid,
  unique (journey_id, version)
);

alter table public.journey_versions enable row level security;
create policy "service role full access on journey_versions"
  on public.journey_versions for all using (auth.role() = 'service_role');

create or replace function public.publish_journey_draft(
  p_journey_id uuid,
  p_tenant_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_journey public.journeys%rowtype;
  v_new_version integer;
  v_running integer;
  v_trigger_next text;
begin
  select * into v_journey
    from public.journeys
   where id = p_journey_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_journey.draft_spec is null then
    return jsonb_build_object('status', 'no_draft');
  end if;

  -- Structural gate — the DB never trusts the client's validation.
  if jsonb_typeof(v_journey.draft_spec -> 'steps') <> 'array'
     or jsonb_array_length(v_journey.draft_spec -> 'steps') = 0 then
    return jsonb_build_object('status', 'invalid_draft', 'reason', 'no_steps');
  end if;
  v_trigger_next := coalesce(v_journey.draft_spec ->> 'trigger_next_step',
                             v_journey.draft_spec ->> 'triggerNextStep');
  if v_trigger_next is null or not exists (
    select 1 from jsonb_array_elements(v_journey.draft_spec -> 'steps') s
     where (s ->> 'index')::integer = v_trigger_next::integer
  ) then
    return jsonb_build_object('status', 'invalid_draft', 'reason', 'unresolvable_start_step');
  end if;

  v_new_version := v_journey.version + 1;

  update public.journeys
     set spec = v_journey.draft_spec,
         version = v_new_version,
         draft_spec = null,
         draft_updated_at = null
   where id = p_journey_id;

  insert into public.journey_versions (tenant_id, journey_id, version, spec, published_by)
  values (p_tenant_id, p_journey_id, v_new_version, v_journey.draft_spec, p_actor);

  select count(*) into v_running
    from public.journey_runs
   where journey_id = p_journey_id and status = 'running';

  return jsonb_build_object(
    'status', 'published',
    'version', v_new_version,
    'running_runs', v_running
  );
end;
$$;

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'publish_journey_draft'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;