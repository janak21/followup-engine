-- Phase 4: conditional_split supports ordered named branches plus Else.
-- Legacy condition -> yes/no splits keep their existing behavior.

create or replace function public.process_action_conditional_split(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_run public.journey_runs%rowtype;
  v_lead public.leads%rowtype;
  v_journey public.journeys%rowtype;
  v_step jsonb;
  v_condition jsonb;
  v_outcome text;
  v_next_action_id uuid;
  v_branches jsonb;
  v_branch jsonb;
  v_branch_index integer;
  v_branch_id text;
  v_branch_label text;
  v_branch_condition jsonb;
begin
  select * into v_action from public.actions where id = p_action_id for update;
  if not found then
    return jsonb_build_object('status', 'failed', 'reason', 'action_not_found');
  end if;
  if v_action.status = 'completed' then
    return coalesce(v_action.result, '{}'::jsonb) || jsonb_build_object('status', 'already_completed');
  end if;

  if v_action.run_id is not null then
    select * into v_run from public.journey_runs where id = v_action.run_id;
  end if;

  if v_run.id is not null and v_run.mode = 'event_workflow' then
    v_step := coalesce(v_action.payload -> 'step_spec', '{}'::jsonb);
    v_branches := coalesce(v_step -> 'branches', '[]'::jsonb);

    if jsonb_typeof(v_branches) = 'array' and jsonb_array_length(v_branches) > 0 then
      v_outcome := 'else';
      v_branch_label := null;
      for v_branch, v_branch_index in
        select value, ordinality::integer
          from jsonb_array_elements(v_branches) with ordinality
      loop
        v_branch_id := nullif(btrim(coalesce(v_branch ->> 'id', '')), '');
        v_branch_condition := v_branch -> 'condition';
        if v_branch_id is null then
          v_branch_id := 'branch_' || v_branch_index::text;
        end if;

        if public.evaluate_workflow_condition(v_branch_condition, v_action.run_id, coalesce(v_action.lead_id, v_run.lead_id), coalesce(v_action.result, '{}'::jsonb)) then
          v_outcome := v_branch_id;
          v_branch_label := nullif(btrim(coalesce(v_branch ->> 'label', '')), '');
          v_condition := v_branch_condition;
          exit;
        end if;
      end loop;
    else
      v_condition := v_step -> 'condition';
      if public.evaluate_workflow_condition(v_condition, v_action.run_id, coalesce(v_action.lead_id, v_run.lead_id), coalesce(v_action.result, '{}'::jsonb)) then
        v_outcome := 'yes';
      else
        v_outcome := 'no';
      end if;
    end if;

    update public.actions
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           locked_until = null,
           locked_by = null,
           last_error = null,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'completed',
             'outcome', v_outcome,
             'branch_outcome', v_outcome,
             'branch_label', v_branch_label,
             'condition_evaluated', coalesce(v_condition, '{}'::jsonb),
             'completed_at', now()
           )
     where id = v_action.id;

    v_next_action_id := public.advance_journey(v_action.id, v_outcome);

    return jsonb_build_object(
      'status', 'completed',
      'outcome', v_outcome,
      'branch_outcome', v_outcome,
      'branch_label', v_branch_label,
      'next_action_id', v_next_action_id
    );
  end if;

  select * into v_lead from public.leads where id = v_action.lead_id;
  if not found then
    perform public.mark_action_failed_permanent(p_action_id, 'lead not found');
    return jsonb_build_object('status', 'failed', 'reason', 'lead_not_found');
  end if;

  select * into v_journey
    from public.journeys
    where tenant_id = v_action.tenant_id
      and journey_key = v_lead.journey_template
      and active
    order by version desc
    limit 1;

  if not found then
    perform public.mark_action_failed_permanent(p_action_id, 'journey not found');
    return jsonb_build_object('status', 'failed', 'reason', 'journey_not_found');
  end if;

  select s into v_step
    from jsonb_array_elements(v_journey.spec->'steps') s
   where (s->>'index')::int = v_action.step_index;

  v_branches := coalesce(v_step -> 'branches', '[]'::jsonb);

  if jsonb_typeof(v_branches) = 'array' and jsonb_array_length(v_branches) > 0 then
    v_outcome := 'else';
    v_branch_label := null;
    for v_branch, v_branch_index in
      select value, ordinality::integer
        from jsonb_array_elements(v_branches) with ordinality
    loop
      v_branch_id := nullif(btrim(coalesce(v_branch ->> 'id', '')), '');
      v_branch_condition := v_branch -> 'condition';
      if v_branch_id is null then
        v_branch_id := 'branch_' || v_branch_index::text;
      end if;

      if public.evaluate_condition(v_branch_condition, v_lead.id) then
        v_outcome := v_branch_id;
        v_branch_label := nullif(btrim(coalesce(v_branch ->> 'label', '')), '');
        v_condition := v_branch_condition;
        exit;
      end if;
    end loop;
  else
    v_condition := v_step->'condition';
    if public.evaluate_condition(v_condition, v_lead.id) then
      v_outcome := 'yes';
    else
      v_outcome := 'no';
    end if;
  end if;

  update public.actions
     set status = 'completed',
         result = jsonb_build_object(
           'outcome', v_outcome,
           'branch_outcome', v_outcome,
           'branch_label', v_branch_label,
           'condition_evaluated', coalesce(v_condition, '{}'::jsonb)
         ),
         completed_at = now()
   where id = p_action_id;

  insert into public.events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object(
            'step_type', 'conditional_split',
            'outcome', v_outcome,
            'branch_outcome', v_outcome,
            'branch_label', v_branch_label,
            'condition', coalesce(v_condition, '{}'::jsonb)
          ));

  v_next_action_id := public.advance_journey(p_action_id, v_outcome);

  return jsonb_build_object(
    'status', 'success',
    'outcome', v_outcome,
    'branch_outcome', v_outcome,
    'branch_label', v_branch_label,
    'next_action_id', v_next_action_id
  );
exception
  when others then
    perform public.mark_action_failed_permanent(p_action_id, left(sqlerrm, 2000));
    return jsonb_build_object('status', 'failed', 'reason', left(sqlerrm, 2000));
end;
$$;

revoke execute on function public.process_action_conditional_split(uuid)
  from public, anon, authenticated;
grant execute on function public.process_action_conditional_split(uuid)
  to service_role;
