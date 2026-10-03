-- Event-native conditional split for webhook-triggered automations.
--
-- This enables payload/context If/Else branches before a lead exists. It does
-- not call providers, pg_net, edge functions, or the normal actions dispatcher.

create or replace function public._workflow_condition_truthy(p_value text)
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  select lower(btrim(coalesce(p_value, ''))) in ('true', 't', '1', 'yes', 'y', 'on')
$$;

create or replace function public._workflow_condition_empty(p_value text)
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  select p_value is null or btrim(p_value) = ''
$$;

create or replace function public._workflow_condition_rule_matches(
  p_left text,
  p_op text,
  p_right text
)
returns boolean
language plpgsql
immutable
set search_path to 'public'
as $$
declare
  v_op text := lower(coalesce(nullif(btrim(p_op), ''), 'equals'));
  v_left text := coalesce(p_left, '');
  v_right text := coalesce(p_right, '');
  v_left_num numeric;
  v_right_num numeric;
begin
  if v_op = 'is_empty' then
    return public._workflow_condition_empty(p_left);
  elsif v_op = 'is_not_empty' then
    return not public._workflow_condition_empty(p_left);
  elsif v_op = 'is_true' then
    return public._workflow_condition_truthy(p_left);
  elsif v_op = 'is_false' then
    return not public._workflow_condition_truthy(p_left);
  elsif v_op = 'equals' then
    return v_left = v_right;
  elsif v_op = 'not_equals' then
    return v_left <> v_right;
  elsif v_op = 'contains' then
    return position(lower(v_right) in lower(v_left)) > 0;
  elsif v_op = 'not_contains' then
    return position(lower(v_right) in lower(v_left)) = 0;
  elsif v_op in ('gt', 'lt', 'gte', 'lte') then
    if v_left !~ '^-?[0-9]+(\.[0-9]+)?$' or v_right !~ '^-?[0-9]+(\.[0-9]+)?$' then
      return false;
    end if;

    v_left_num := v_left::numeric;
    v_right_num := v_right::numeric;

    if v_op = 'gt' then
      return v_left_num > v_right_num;
    elsif v_op = 'lt' then
      return v_left_num < v_right_num;
    elsif v_op = 'gte' then
      return v_left_num >= v_right_num;
    elsif v_op = 'lte' then
      return v_left_num <= v_right_num;
    end if;
  elsif v_op = 'includes' then
    return position(lower(v_right) in lower(v_left)) > 0;
  elsif v_op = 'excludes' then
    return position(lower(v_right) in lower(v_left)) = 0;
  end if;

  return false;
end;
$$;

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

create or replace function public.process_workflow_conditional_split_action(
  p_workflow_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_run public.journey_runs%rowtype;
  v_step jsonb;
  v_condition jsonb;
  v_outcome text;
  v_advance jsonb;
begin
  select *
    into v_action
    from public.workflow_actions
   where id = p_workflow_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_action.status = 'completed' then
    return coalesce(v_action.result, '{}'::jsonb) || jsonb_build_object('status', 'already_completed');
  end if;

  select *
    into v_run
    from public.journey_runs
   where id = v_action.run_id;

  if not found then
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_until = null,
           locked_by = null,
           last_error = 'Associated journey run was not found.',
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'reason', 'run_not_found'
           )
     where id = v_action.id;

    return jsonb_build_object('status', 'failed', 'reason', 'run_not_found');
  end if;

  v_step := coalesce(v_action.payload -> 'step_spec', '{}'::jsonb);
  v_condition := v_step -> 'condition';

  if public.evaluate_workflow_condition(v_condition, v_action.run_id, coalesce(v_action.lead_id, v_run.lead_id), coalesce(v_action.result, '{}'::jsonb)) then
    v_outcome := 'yes';
  else
    v_outcome := 'no';
  end if;

  update public.workflow_actions
     set status = 'completed',
         completed_at = coalesce(completed_at, now()),
         locked_until = null,
         locked_by = null,
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'status', 'completed',
           'outcome', v_outcome,
           'condition_evaluated', coalesce(v_condition, '{}'::jsonb),
           'completed_at', now()
         )
   where id = v_action.id;

  v_advance := public.advance_workflow_run(v_action.id, v_outcome);

  return jsonb_build_object(
    'status', 'completed',
    'outcome', v_outcome,
    'advance', v_advance
  );
exception
  when others then
    update public.workflow_actions
       set status = 'failed_permanent',
           failed_at = coalesce(failed_at, now()),
           locked_until = null,
           locked_by = null,
           last_error = left(sqlerrm, 2000),
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'reason', left(sqlerrm, 2000)
           )
     where id = p_workflow_action_id;

    return jsonb_build_object('status', 'failed', 'reason', left(sqlerrm, 2000));
end;
$$;

do $$
declare
  v_sql text;
  v_find_branch text;
  v_conditional_branch text;
begin
  v_find_branch := $branch$
    elsif v_action.action_type = 'find_lead_from_payload' then
      begin
        v_result := public.process_workflow_find_lead_action(v_action.id);

        if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
          v_completed := v_completed + 1;
        else
          v_failed := v_failed + 1;
        end if;
      exception
        when others then
          update public.workflow_actions
             set status = 'failed_permanent',
                 failed_at = coalesce(failed_at, now()),
                 locked_by = null,
                 locked_until = null,
                 last_error = left(sqlerrm, 2000),
                 result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                   'failed_permanent_at', now(),
                   'failure_message', left(sqlerrm, 2000),
                   'failed_by', 'dispatch_pending_workflow_actions'
                 )
           where id = v_action.id;
          v_failed := v_failed + 1;
      end;
$branch$;

  v_conditional_branch := v_find_branch || $branch$
    elsif v_action.action_type = 'conditional_split' then
      begin
        v_result := public.process_workflow_conditional_split_action(v_action.id);

        if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
          v_completed := v_completed + 1;
        else
          v_failed := v_failed + 1;
        end if;
      exception
        when others then
          update public.workflow_actions
             set status = 'failed_permanent',
                 failed_at = coalesce(failed_at, now()),
                 locked_by = null,
                 locked_until = null,
                 last_error = left(sqlerrm, 2000),
                 result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                   'failed_permanent_at', now(),
                   'failure_message', left(sqlerrm, 2000),
                   'failed_by', 'dispatch_pending_workflow_actions'
                 )
           where id = v_action.id;
          v_failed := v_failed + 1;
      end;
$branch$;

  select pg_get_functiondef('public.dispatch_pending_workflow_actions(text,integer)'::regprocedure)
    into v_sql;

  if position('conditional_split' in v_sql) = 0 then
    if position(v_find_branch in v_sql) = 0 then
      raise exception 'Could not patch dispatch_pending_workflow_actions for conditional_split';
    end if;

    execute replace(v_sql, v_find_branch, v_conditional_branch);
  end if;
end $$;

do $$
declare
  v_sql text;
  v_find_branch text;
  v_conditional_branch text;
begin
  v_find_branch := $branch$
    elsif v_action.action_type = 'find_lead_from_payload' then
      begin
        v_result := public.process_workflow_find_lead_action(v_action.id);
        if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
          v_completed := v_completed + 1;
        else
          v_failed := v_failed + 1;
        end if;
      exception
        when others then
          update public.workflow_actions
             set status = 'failed_permanent',
                 failed_at = coalesce(failed_at, now()),
                 locked_by = null,
                 locked_until = null,
                 last_error = left(sqlerrm, 2000),
                 result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                   'failed_permanent_at', now(),
                   'failure_message', left(sqlerrm, 2000),
                   'failed_by', 'dispatch_workflow_run_actions'
                 )
           where id = v_action.id;
          v_failed := v_failed + 1;
      end;
$branch$;

  v_conditional_branch := v_find_branch || $branch$
    elsif v_action.action_type = 'conditional_split' then
      begin
        v_result := public.process_workflow_conditional_split_action(v_action.id);
        if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
          v_completed := v_completed + 1;
        else
          v_failed := v_failed + 1;
        end if;
      exception
        when others then
          update public.workflow_actions
             set status = 'failed_permanent',
                 failed_at = coalesce(failed_at, now()),
                 locked_by = null,
                 locked_until = null,
                 last_error = left(sqlerrm, 2000),
                 result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                   'failed_permanent_at', now(),
                   'failure_message', left(sqlerrm, 2000),
                   'failed_by', 'dispatch_workflow_run_actions'
                 )
           where id = v_action.id;
          v_failed := v_failed + 1;
      end;
$branch$;

  select pg_get_functiondef('public.dispatch_workflow_run_actions(uuid,text,integer)'::regprocedure)
    into v_sql;

  if position('conditional_split' in v_sql) = 0 then
    if position(v_find_branch in v_sql) = 0 then
      raise exception 'Could not patch dispatch_workflow_run_actions for conditional_split';
    end if;

    execute replace(v_sql, v_find_branch, v_conditional_branch);
  end if;
end $$;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.advance_workflow_run(uuid,text)'::regprocedure)
    into v_sql;

  if position('conditional_split' in v_sql) = 0 then
    if position($needle$'create_lead_from_payload',
       'find_lead_from_payload'$needle$ in v_sql) = 0 then
      raise exception 'Could not patch advance_workflow_run allowlist for conditional_split';
    end if;

    v_sql := replace(
      v_sql,
      $needle$'create_lead_from_payload',
       'find_lead_from_payload'$needle$,
      $replace$'create_lead_from_payload',
       'find_lead_from_payload',
       'conditional_split'$replace$
    );

    execute v_sql;
  end if;
end $$;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.process_journey_webhook(text,jsonb,jsonb,text)'::regprocedure)
    into v_sql;

  if position('conditional_split' in v_sql) = 0 then
    if position($needle$not in ('create_lead_from_payload', 'find_lead_from_payload')$needle$ in v_sql) = 0 then
      raise exception 'Could not patch process_journey_webhook start allowlist for conditional_split';
    end if;

    v_sql := replace(
      v_sql,
      $needle$not in ('create_lead_from_payload', 'find_lead_from_payload')$needle$,
      $replace$not in ('create_lead_from_payload', 'find_lead_from_payload', 'conditional_split')$replace$
    );

    v_sql := replace(
      v_sql,
      'Event workflow webhook start only supports create_lead_from_payload or find_lead_from_payload.',
      'Event workflow webhook start only supports create_lead_from_payload, find_lead_from_payload, or conditional_split.'
    );

    execute v_sql;
  end if;
end $$;
