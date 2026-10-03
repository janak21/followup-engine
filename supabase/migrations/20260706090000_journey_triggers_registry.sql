-- Phase 3: indexed trigger subscriptions, synced from journeys.spec.
-- The spec remains the source of truth; this table exists so event-time
-- lookups are O(index) instead of scanning every journey's jsonb.

create table if not exists public.journey_triggers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  journey_key text not null,
  trigger_type text not null,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journey_id, trigger_type)
);

create index if not exists journey_triggers_lookup_idx
  on public.journey_triggers (tenant_id, trigger_type)
  where enabled;

create trigger trg_journey_triggers_updated_at
  before update on public.journey_triggers
  for each row execute function set_updated_at();

-- Event-driven trigger types the engine fires. lead_enrolled (manual/bulk)
-- and webhook are handled by their own intake paths, not this registry.
create or replace function public.sync_journey_triggers(p_journey_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_journey public.journeys%rowtype;
  v_type text;
  v_config jsonb;
begin
  select * into v_journey from public.journeys where id = p_journey_id;
  if not found then
    delete from public.journey_triggers where journey_id = p_journey_id;
    return;
  end if;

  v_type := v_journey.spec ->> 'trigger_type';
  v_config := coalesce(v_journey.spec -> 'trigger_config', '{}'::jsonb);

  if v_journey.active
     and v_type in ('tag_added', 'incoming_sms', 'email_replied', 'lead_created') then
    insert into public.journey_triggers (tenant_id, journey_id, journey_key, trigger_type, config, enabled)
    values (v_journey.tenant_id, v_journey.id, v_journey.journey_key, v_type, v_config, true)
    on conflict (journey_id, trigger_type)
    do update set config = excluded.config,
                  journey_key = excluded.journey_key,
                  enabled = true;
    -- one trigger per journey this phase: drop rows of other types
    delete from public.journey_triggers
     where journey_id = p_journey_id and trigger_type <> v_type;
  else
    -- journey inactive, deleted trigger, or non-event trigger type
    delete from public.journey_triggers where journey_id = p_journey_id;
  end if;
end;
$$;

create or replace function public.on_journey_saved_sync_triggers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.sync_journey_triggers(new.id);
  return new;
end;
$$;

drop trigger if exists trg_journeys_sync_triggers on public.journeys;
create trigger trg_journeys_sync_triggers
  after insert or update of spec, active on public.journeys
  for each row execute function public.on_journey_saved_sync_triggers();

-- Backfill from existing specs.
do $do$
declare j record;
begin
  for j in select id from public.journeys loop
    perform public.sync_journey_triggers(j.id);
  end loop;
end
$do$;

do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('sync_journey_triggers', 'on_journey_saved_sync_triggers')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;