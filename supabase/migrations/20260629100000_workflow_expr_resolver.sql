-- Event workflow expression resolver.
--
-- This is intentionally separate from resolve_merge_tags so existing
-- lead-based journey rendering remains unchanged.
--
-- Supported expression forms are whole-value paths only:
--   payload.email, {{payload.email}}
--   context.some_key, {{context.some_key}}
--   steps.create_lead.lead_id, {{steps.create_lead.lead_id}}
--   lead.email, {{lead.email}}
--   custom.policy_type, {{custom.policy_type}}
--
-- Unknown namespaces return null rather than being treated as executable
-- expressions. Non-path/static strings return unchanged.

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

  if v_expr = '' then
    return '';
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

create or replace function public.resolve_workflow_mapping_value(
  p_source jsonb,
  p_run_id uuid,
  p_lead_id uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_source is null or jsonb_typeof(p_source) <> 'object' then
    return null;
  end if;

  if p_source ? 'static' then
    return p_source ->> 'static';
  end if;

  if p_source ? 'source' then
    return public.resolve_workflow_expr(p_source ->> 'source', p_run_id, p_lead_id);
  end if;

  return null;
end;
$$;
