-- Repair context recording for event workflow find_lead_from_payload actions.
--
-- This does not alter legacy process_action_find_lead behavior, lead journeys,
-- dashboard UI, dispatcher behavior, or provider execution.
--
-- Design notes:
--   - Searches are always scoped to the action's tenant.
--   - This handler never creates a lead; it only attaches an existing one.
--   - Multiple matches are resolved deterministically by choosing the
--     earliest-created lead (order by created_at asc limit 1), matching the
--     duplicate resolution behaviour of process_workflow_create_lead_action.
--   - Supported search fields: email, phone, phone_raw, phone_e164, and
--     custom.* fields. Phone searches match phone_e164 or phone_raw.
--   - Search values are resolved via resolve_workflow_mapping_value so they
--     can come from payload paths, context, or static values.

create or replace function public.process_workflow_find_lead_action(
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
  v_search jsonb;
  v_field text;
  v_source jsonb;
  v_value text;
  v_custom_key text;
  v_email text;
  v_phone text;
  v_lead public.leads%rowtype;
  v_lead_id uuid;
  v_match_type text;
  v_search_applied boolean := false;
  v_result jsonb;
  v_advance_result jsonb;
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
    return coalesce(v_action.result, '{}'::jsonb) || jsonb_build_object(
      'status', 'already_completed',
      'workflow_action_id', v_action.id
    );
  end if;

  select *
    into v_run
    from public.journey_runs
   where id = v_action.run_id
   for update;

  if not found then
    perform public.mark_workflow_action_failed(
      p_workflow_action_id,
      'Associated journey run was not found.',
      1
    );
    return jsonb_build_object(
      'status', 'failed',
      'error', 'Associated journey run was not found.'
    );
  end if;

  v_step := v_action.payload -> 'step_spec';
  if v_step is null or v_step = 'null'::jsonb then
    v_step := '{}'::jsonb;
  end if;

  if coalesce(v_step ->> 'type', v_action.action_type) <> 'find_lead_from_payload' then
    perform public.mark_workflow_action_failed(
      p_workflow_action_id,
      'Workflow action is not find_lead_from_payload.',
      1
    );
    return jsonb_build_object(
      'status', 'failed',
      'error', 'Workflow action is not find_lead_from_payload.'
    );
  end if;

  for v_search in
    select value
      from jsonb_array_elements(coalesce(v_step -> 'search', '[]'::jsonb))
  loop
    v_field := lower(btrim(coalesce(v_search ->> 'field', '')));
    v_source := v_search -> 'source';

    if v_field = '' or v_source is null or v_source = 'null'::jsonb then
      continue;
    end if;

    v_value := public.resolve_workflow_mapping_value(v_source, v_action.run_id, v_run.lead_id);
    v_value := nullif(btrim(coalesce(v_value, '')), '');

    if v_value is null then
      continue;
    end if;

    v_search_applied := true;

    if v_field = 'email' then
      v_email := lower(v_value);
    elsif v_field in ('phone', 'phone_raw', 'phone_e164') then
      v_phone := v_value;
    elsif left(v_field, 7) = 'custom.' then
      v_custom_key := substring(v_field from 8);
      if nullif(v_custom_key, '') is not null then
        -- Custom-field search: look for a lead whose custom_fields contain
        -- the resolved value under the requested key. No lead mutation occurs,
        -- so we do not lock the row.
        select *
          into v_lead
          from public.leads
         where tenant_id = v_action.tenant_id
           and coalesce(custom_fields, '{}'::jsonb) ->> v_custom_key = v_value
         order by created_at asc
         limit 1;

        if found then
          v_match_type := 'custom.' || v_custom_key;
          exit;
        end if;
      end if;
    end if;
  end loop;

  -- Email search takes precedence over phone when both are configured.
  if v_lead.id is null and v_email is not null then
    select *
      into v_lead
      from public.leads
     where tenant_id = v_action.tenant_id
       and lower(coalesce(email, '')) = v_email
     order by created_at asc
     limit 1;

    if found then
      v_match_type := 'email';
    end if;
  end if;

  if v_lead.id is null and v_phone is not null then
    select *
      into v_lead
      from public.leads
     where tenant_id = v_action.tenant_id
       and (phone_e164 = v_phone or phone_raw = v_phone)
     order by created_at asc
     limit 1;

    if found then
      v_match_type := 'phone';
    end if;
  end if;

  if v_lead.id is null then
    v_result := jsonb_build_object(
      'status', 'completed',
      'outcome', 'not_found',
      'search_applied', v_search_applied
    );

    update public.workflow_actions
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           locked_until = null,
           locked_by = null,
           last_error = null,
           result = coalesce(result, '{}'::jsonb) || v_result
     where id = p_workflow_action_id
     returning * into v_action;

    update public.journey_runs
       set context = jsonb_set(
             jsonb_set(
               coalesce(context, '{}'::jsonb),
               '{steps}',
               coalesce(context -> 'steps', '{}'::jsonb),
               true
             ),
             '{steps,find_lead}',
             v_result,
             true
           ),
           updated_at = now()
     where id = v_action.run_id;

    v_advance_result := public.advance_workflow_run(p_workflow_action_id, 'not_found');

    return v_result || jsonb_build_object(
      'workflow_action_id', p_workflow_action_id,
      'advance', v_advance_result
    );
  end if;

  v_lead_id := v_lead.id;

  perform public.attach_lead_to_journey_run(v_action.tenant_id, v_action.run_id, v_lead_id);

  v_result := jsonb_build_object(
    'status', 'completed',
    'outcome', 'found',
    'lead_id', v_lead_id,
    'match_type', coalesce(v_match_type, 'unknown'),
    'search_applied', v_search_applied
  );

  update public.workflow_actions
     set lead_id = v_lead_id,
         status = 'completed',
         completed_at = coalesce(completed_at, now()),
         locked_until = null,
         locked_by = null,
         last_error = null,
         result = coalesce(result, '{}'::jsonb) || v_result
   where id = p_workflow_action_id
   returning * into v_action;

  update public.journey_runs
     set context = jsonb_set(
           jsonb_set(
             coalesce(context, '{}'::jsonb),
             '{steps}',
             coalesce(context -> 'steps', '{}'::jsonb),
             true
           ),
           '{steps,find_lead}',
           v_result,
           true
         ),
         updated_at = now()
   where id = v_action.run_id;

  v_advance_result := public.advance_workflow_run(p_workflow_action_id, 'found');

  return v_result || jsonb_build_object(
    'workflow_action_id', p_workflow_action_id,
    'advance', v_advance_result
  );
exception
  when others then
    perform public.mark_workflow_action_failed(
      p_workflow_action_id,
      left(sqlerrm, 2000),
      1
    );
    return jsonb_build_object(
      'status', 'failed',
      'error', sqlerrm
    );
end;
$$;
