-- Repair event workflow If/Else field expression parsing.
--
-- The first event-native conditional split migration handled braced expressions
-- on the right-hand value, but not on the left-hand field. Users paste paths as
-- {{ $json.foo }} from the builder, so the left side must support that same
-- syntax.

create or replace function public.evaluate_workflow_condition(
  p_condition jsonb,
  p_run_id uuid,
  p_lead_id uuid default null,
  p_action_result jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_combinator text := lower(coalesce(p_condition ->> 'combinator', 'and'));
  v_rule jsonb;
  v_field text;
  v_left text;
  v_right text;
  v_matches boolean;
  v_seen_rule boolean := false;
begin
  if p_condition is null
     or p_condition = 'null'::jsonb
     or jsonb_typeof(p_condition -> 'rules') <> 'array' then
    return false;
  end if;

  if v_combinator not in ('and', 'or') then
    v_combinator := 'and';
  end if;

  for v_rule in
    select value from jsonb_array_elements(coalesce(p_condition -> 'rules', '[]'::jsonb))
  loop
    v_seen_rule := true;
    v_field := nullif(btrim(coalesce(
      v_rule #>> '{left,source}',
      v_rule #>> '{source,source}',
      v_rule ->> 'field',
      ''
    )), '');

    if v_field ~ '^\{\{.*\}\}$' then
      v_field := btrim(substring(v_field from 3 for char_length(v_field) - 4));
    end if;

    if v_field is null then
      v_left := null;
    elsif v_field = '$json' or left(v_field, 6) = '$json.' then
      v_left := public.resolve_workflow_expr(v_field, p_run_id, p_lead_id, p_action_result);
    elsif v_field in ('payload', 'context', 'steps', 'lead', 'custom')
       or left(v_field, 8) = 'payload.'
       or left(v_field, 8) = 'context.'
       or left(v_field, 6) = 'steps.'
       or left(v_field, 5) = 'lead.'
       or left(v_field, 7) = 'custom.' then
      v_left := public.resolve_workflow_expr(v_field, p_run_id, p_lead_id, p_action_result);
    elsif p_lead_id is not null then
      v_left := public.resolve_workflow_expr('lead.' || v_field, p_run_id, p_lead_id, p_action_result);
    else
      v_left := null;
    end if;

    if jsonb_typeof(v_rule -> 'value') = 'array' then
      v_right := array_to_string(array(select jsonb_array_elements_text(v_rule -> 'value')), ',');
    else
      v_right := coalesce(v_rule ->> 'value', '');
      if v_right = '$json'
         or left(v_right, 6) = '$json.'
         or v_right ~ '^\{\{\s*\$json[\s\S]*\}\}$'
         or v_right ~ '^\{\{\s*(payload|context|steps|lead|custom)\.[\s\S]*\}\}$'
         or v_right ~ '^(payload|context|steps|lead|custom)\.' then
        v_right := public.resolve_workflow_expr(v_right, p_run_id, p_lead_id, p_action_result);
      end if;
    end if;

    v_matches := public._workflow_condition_rule_matches(
      v_left,
      coalesce(v_rule ->> 'op', 'equals'),
      v_right
    );

    if v_combinator = 'or' and v_matches then
      return true;
    elsif v_combinator = 'and' and not v_matches then
      return false;
    end if;
  end loop;

  return v_seen_rule and v_combinator = 'and';
exception
  when others then
    return false;
end;
$$;
