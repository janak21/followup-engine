-- Phase 4: deterministic A/B percentage split step.

create or replace function public.process_action_ab_split(p_action_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_percent integer;
  v_seed text;
  v_bucket integer;
  v_outcome text;
begin
  select * into v_action from public.actions where id = p_action_id for update;
  if not found or v_action.status not in ('pending', 'in_progress') then
    return null;
  end if;

  v_percent := least(100, greatest(0, coalesce(
    nullif(v_action.payload -> 'step_spec' ->> 'split_percent_a', '')::integer, 50)));
  v_seed := coalesce(v_action.lead_id::text, v_action.run_id::text, v_action.id::text)
            || ':' || v_action.step_index::text;
  v_bucket := abs(hashtext(v_seed)::bigint) % 100;
  v_outcome := case when v_bucket < v_percent then 'a' else 'b' end;

  update public.actions
     set status = 'completed',
         completed_at = now(),
         result = coalesce(result, '{}'::jsonb)
                  || jsonb_build_object('ab_bucket', v_bucket, 'ab_outcome', v_outcome, 'outcome', v_outcome),
         locked_until = null,
         locked_by = null,
         last_error = null
   where id = p_action_id;

  return public.advance_journey(p_action_id, v_outcome);
end;
$$;

revoke execute on function public.process_action_ab_split(uuid)
  from public, anon, authenticated;
grant execute on function public.process_action_ab_split(uuid)
  to service_role;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.dispatch_pending_actions(text,integer,integer)'::regprocedure)
    into v_sql;

  if v_sql is null then
    raise exception 'dispatch_pending_actions(text, integer, integer) not found';
  end if;

  if position('process_action_ab_split' in v_sql) = 0 then
    v_sql := replace(
      v_sql,
      '''create_lead_from_payload'',''find_lead_from_payload''',
      '''create_lead_from_payload'',''find_lead_from_payload'',''ab_split'''
    );
    v_sql := replace(
      v_sql,
      'elsif v_inline_type=''find_lead_from_payload'' then perform public.process_action_find_lead_from_payload(v_inline_id);',
      'elsif v_inline_type=''find_lead_from_payload'' then perform public.process_action_find_lead_from_payload(v_inline_id);
      elsif v_inline_type=''ab_split'' then perform public.process_action_ab_split(v_inline_id);'
    );
    execute v_sql;
  end if;
end;
$$;

revoke execute on function public.dispatch_pending_actions(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.dispatch_pending_actions(text, integer, integer)
  to service_role;

alter table public.actions
  drop constraint if exists actions_lead_required_types;

alter table public.actions
  add constraint actions_lead_required_types check (
    lead_id is not null
    or action_type in (
      'create_lead_from_payload',
      'find_lead_from_payload',
      'conditional_split',
      'wait',
      'http_request',
      'exit_flow',
      'team_alert',
      'ab_split'
    )
  );
