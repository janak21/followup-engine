-- Repair event workflow payload path resolution for real webhook payloads.
--
-- The builder emits paths like payload.data.fields[3].value for nested array
-- payloads. Event workflow mappings resolve through _extract_json_path, so the
-- shared path walker must support bracket indexes and dotted numeric indexes.
-- This is additive/idempotent and only replaces the shared JSON path helper.

create or replace function public._extract_json_path(p_payload jsonb, p_path text)
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
  if p_payload is null or p_path is null or btrim(p_path) = '' then
    return null;
  end if;

  v_clean := btrim(p_path);

  if v_clean like '$%' then
    begin
      select jsonb_path_query_first(p_payload, v_clean::jsonpath) #>> '{}'
        into v_result;
      return v_result;
    exception
      when others then
        return null;
    end;
  end if;

  for v_match in
    select regexp_matches(v_clean, v_pat, 'g')
  loop
    if v_cur is null or jsonb_typeof(v_cur) = 'null' then
      return null;
    end if;

    if v_match[2] is not null then
      if jsonb_typeof(v_cur) <> 'array' then
        return null;
      end if;
      v_idx := v_match[2]::int;
      if v_idx < 0 then
        v_idx := jsonb_array_length(v_cur) + v_idx;
      end if;
      if v_idx < 0 or v_idx >= jsonb_array_length(v_cur) then
        return null;
      end if;
      v_cur := v_cur -> v_idx;
    elsif v_match[3] is not null then
      if jsonb_typeof(v_cur) = 'array' then
        v_idx := v_match[3]::int;
        if v_idx < 0 then
          v_idx := jsonb_array_length(v_cur) + v_idx;
        end if;
        if v_idx < 0 or v_idx >= jsonb_array_length(v_cur) then
          return null;
        end if;
        v_cur := v_cur -> v_idx;
      elsif jsonb_typeof(v_cur) = 'object' then
        v_cur := v_cur -> v_match[3];
      else
        return null;
      end if;
    elsif v_match[4] is not null then
      if jsonb_typeof(v_cur) <> 'object' then
        return null;
      end if;
      v_cur := v_cur -> v_match[4];
    end if;
  end loop;

  if v_cur is null or jsonb_typeof(v_cur) = 'null' then
    return null;
  end if;

  return v_cur #>> '{}';
exception
  when others then
    return null;
end;
$$;
