-- Add n8n/Make-style $json aliases for webhook payload expressions.
--
-- This does not add arbitrary expression execution. It only treats:
--   $json.email
--   {{ $json.email }}
--   {{ $json.data.fields[3].value }}
-- as aliases for payload.email / payload.data.fields[3].value.

create or replace function public.resolve_workflow_expr(
  p_expr text,
  p_run_id uuid,
  p_lead_id uuid default null,
  p_action_result jsonb default '{}'::jsonb
)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_expr text;
  v_path text;
  v_namespace text;
  v_subpath text;
  v_run public.journey_runs%rowtype;
  v_lead public.leads%rowtype;
  v_source jsonb;
begin
  if p_expr is null then
    return null;
  end if;

  v_expr := btrim(p_expr);

  if v_expr ~ '^\{\{.*\}\}$' then
    v_expr := btrim(substring(v_expr from 3 for char_length(v_expr) - 4));
  end if;

  if left(v_expr, 6) = '$json.' then
    v_expr := 'payload.' || substring(v_expr from 7);
  elsif v_expr = '$json' then
    v_expr := 'payload';
  end if;

  if v_expr = '' then
    return '';
  end if;

  if v_expr = 'payload' then
    select *
      into v_run
      from public.journey_runs
     where id = p_run_id;

    if not found then
      return null;
    end if;

    return coalesce(v_run.raw_payload, '{}'::jsonb) #>> '{}';
  end if;

  -- Only simple namespace.path expressions are resolved. Static strings that
  -- do not look like a namespace path return unchanged.
  if v_expr !~ '^[A-Za-z_][A-Za-z0-9_]*\.' then
    return p_expr;
  end if;

  v_namespace := split_part(v_expr, '.', 1);
  v_subpath := substring(v_expr from char_length(v_namespace) + 2);

  if nullif(v_subpath, '') is null then
    return null;
  end if;

  if v_namespace not in ('payload', 'context', 'steps', 'lead', 'custom') then
    return null;
  end if;

  select *
    into v_run
    from public.journey_runs
   where id = p_run_id;

  if not found then
    return null;
  end if;

  if v_namespace = 'payload' then
    v_source := coalesce(v_run.raw_payload, '{}'::jsonb);
    v_path := v_subpath;
  elsif v_namespace = 'context' then
    v_source := coalesce(v_run.context, '{}'::jsonb);
    v_path := v_subpath;
  elsif v_namespace = 'steps' then
    v_source := coalesce(v_run.context -> 'steps', '{}'::jsonb);
    v_path := v_subpath;
  elsif v_namespace in ('lead', 'custom') then
    if p_lead_id is null then
      return null;
    end if;

    select *
      into v_lead
      from public.leads
     where id = p_lead_id
       and tenant_id = v_run.tenant_id;

    if not found then
      return null;
    end if;

    if v_namespace = 'lead' then
      v_source := to_jsonb(v_lead);
      v_path := v_subpath;
    else
      v_source := coalesce(v_lead.custom_fields, '{}'::jsonb);
      v_path := v_subpath;
    end if;
  end if;

  return public._extract_json_path(v_source, v_path);
exception
  when others then
    return null;
end;
$$;

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

    if v_path ~ '^\{\{.*\}\}$' then
      v_path := btrim(substring(v_path from 3 for char_length(v_path) - 4));
    end if;

    if v_path = '$json' then
      v_path := '';
    elsif left(v_path, 6) = '$json.' then
      v_path := substring(v_path from 7);
    elsif v_path = 'payload' then
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
