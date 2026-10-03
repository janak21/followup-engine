-- Four targeted fixes from the speed-to-lead-janak debug session:
--   1. _extract_json_path accepts bare numeric path segments as array indices
--      (data.fields.0.value now works, not just data.fields[0].value).
--   2. resolve_merge_tags delegates the {{raw_payload.path}} walk to
--      _extract_json_path — one walker, consistent array support.
--   3. process_journey_webhook updates email on existing-lead match.
--   4. advance_journey idempotency key includes the parent action id so
--      re-enrollments queue fresh downstream actions.
--
-- Full bodies live in the deployed Postgres. This mirror records what was
-- applied via the Supabase MCP. See the deployed functions for canonical SQL.

create or replace function _extract_json_path(p_payload jsonb, p_path text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_clean text;
  v_cur jsonb := p_payload;
  v_result text;
  v_idx int;
  v_pat text := '(\[(-?\d+)\])|(-?\d+)|([a-zA-Z_][a-zA-Z0-9_]*)';
  v_match text[];
begin
  if p_path is null or trim(p_path) = '' then return null; end if;
  v_clean := trim(p_path);

  if v_clean like '$%' then
    begin
      select jsonb_path_query_first(p_payload, v_clean::jsonpath) #>> '{}' into v_result;
      return v_result;
    exception when others then return null; end;
  end if;

  for v_match in
    select regexp_matches(v_clean, v_pat, 'g')
  loop
    if v_match[2] is not null then
      if v_cur is null then return null; end if;
      if jsonb_typeof(v_cur) <> 'array' then return null; end if;
      v_idx := v_match[2]::int;
      if v_idx < 0 then v_idx := jsonb_array_length(v_cur) + v_idx; end if;
      v_cur := v_cur -> v_idx;
    elsif v_match[3] is not null then
      if v_cur is null then return null; end if;
      if jsonb_typeof(v_cur) = 'array' then
        v_idx := v_match[3]::int;
        if v_idx < 0 then v_idx := jsonb_array_length(v_cur) + v_idx; end if;
        v_cur := v_cur -> v_idx;
      elsif jsonb_typeof(v_cur) = 'object' then
        v_cur := v_cur -> v_match[3];
      else
        return null;
      end if;
    elsif v_match[4] is not null then
      if v_cur is null then return null; end if;
      if jsonb_typeof(v_cur) <> 'object' then return null; end if;
      v_cur := v_cur -> v_match[4];
    end if;
  end loop;

  if v_cur is null or jsonb_typeof(v_cur) = 'null' then return null; end if;
  return v_cur #>> '{}';
end;
$$;

create or replace function resolve_merge_tags(p_body text, p_lead leads)
returns text
language plpgsql
stable
security definer
set search_path to public
as $$
declare
  v_res text;
  v_match text[];
  v_full text;
  v_path text;
  v_val text;
begin
  v_res := render_template(p_body, p_lead);
  if v_res is null then return null; end if;

  for v_match in
    select regexp_matches(v_res, '\{\{raw_payload\.([^}]+)\}\}', 'g')
  loop
    v_path := v_match[1];
    v_full := '{{raw_payload.' || v_path || '}}';
    v_val  := _extract_json_path(p_lead.raw_payload, v_path);
    v_res  := replace(v_res, v_full, coalesce(v_val, ''));
  end loop;

  return v_res;
end;
$$;

-- process_journey_webhook: one-line behavior change on the existing-lead
-- UPDATE path — refresh email when the incoming submission carries a
-- non-empty one. Match-by-phone now corrects stale emails. Full function
-- body is in the deployed Postgres (also includes the followup_lead_id
-- fixed-path branch from 20260619160000).

-- advance_journey: idempotency_key now includes the parent action id so
-- a lead can be re-enrolled in the same journey repeatedly without
-- downstream actions being silently blocked. Full body in deployed Postgres.

-- See deployed Supabase for canonical implementations of both.
