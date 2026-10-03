-- Hydrate event workflow run context from saved webhook/workflow variables.
--
-- Product model:
--   1. Capture/pin a sample payload in the builder.
--   2. Save variables like { key: "leadRecordId", path: "payload.leadRecordId" }.
--   3. Every webhook run resolves those paths against the incoming payload and
--      stores values in journey_runs.context so later event-aware steps can use
--      context.leadRecordId or context.variables.leadRecordId.

create or replace function public.build_workflow_run_context(
  p_spec jsonb,
  p_payload jsonb,
  p_base_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $$
declare
  v_context jsonb := coalesce(p_base_context, '{}'::jsonb);
  v_variables jsonb := '{}'::jsonb;
  v_item jsonb;
  v_key text;
  v_path text;
  v_value text;
begin
  for v_item in
    select value
      from jsonb_array_elements(coalesce(p_spec -> 'workflow_variables', '[]'::jsonb))
  loop
    v_key := lower(btrim(coalesce(v_item ->> 'key', '')));
    v_key := regexp_replace(v_key, '[^a-z0-9_]', '_', 'g');
    v_key := regexp_replace(v_key, '^_+|_+$', '', 'g');

    if v_key = '' or v_key in ('steps', 'variables') then
      continue;
    end if;

    v_path := coalesce(
      nullif(btrim(v_item ->> 'path'), ''),
      nullif(btrim(v_item ->> 'source'), '')
    );

    if v_path is null and jsonb_typeof(v_item -> 'source') = 'object' then
      v_path := nullif(btrim(v_item #>> '{source,source}'), '');
    end if;

    if v_path is null then
      continue;
    end if;

    if v_path = 'payload' then
      v_path := '';
    elsif left(v_path, 8) = 'payload.' then
      v_path := substring(v_path from 9);
    elsif left(v_path, 8) = 'payload[' then
      v_path := substring(v_path from 8);
    end if;

    v_value := public._extract_json_path(coalesce(p_payload, '{}'::jsonb), v_path);

    if v_value is not null then
      v_variables := jsonb_set(v_variables, array[v_key], to_jsonb(v_value), true);
    end if;
  end loop;

  if v_variables <> '{}'::jsonb then
    v_context := v_context || v_variables;
    v_context := jsonb_set(
      v_context,
      array['variables'],
      coalesce(v_context -> 'variables', '{}'::jsonb) || v_variables,
      true
    );
  end if;

  return v_context;
exception
  when others then
    return coalesce(p_base_context, '{}'::jsonb);
end;
$$;

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
  v_context jsonb;
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

  v_context := public.build_workflow_run_context(
    coalesce(v_journey.spec, '{}'::jsonb),
    coalesce(p_raw_payload, '{}'::jsonb),
    coalesce(p_context, '{}'::jsonb)
  );

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
    v_context,
    coalesce(p_raw_payload, '{}'::jsonb),
    nullif(trim(coalesce(p_idempotency_key, '')), '')
  )
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null
  do update set context = public.journey_runs.context
  returning id into v_run_id;

  return v_run_id;
end;
$$;
