-- Runtime for event workflow create_lead_from_payload actions.
--
-- This does not alter legacy create_lead behavior, lead journeys, dashboard UI,
-- dispatcher behavior, or provider execution.

create or replace function public.process_workflow_create_lead_action(
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
  v_mapping jsonb;
  v_tags jsonb;
  v_tag_source jsonb;
  v_duplicate_mode text;
  v_destination text;
  v_custom_key text;
  v_value text;
  v_email text;
  v_phone text;
  v_match_type text;
  v_lead public.leads%rowtype;
  v_lead_id uuid;
  v_standard jsonb := '{}'::jsonb;
  v_custom jsonb := '{}'::jsonb;
  v_existing_custom jsonb := '{}'::jsonb;
  v_next_custom jsonb := '{}'::jsonb;
  v_fields_written jsonb := '[]'::jsonb;
  v_fields_skipped jsonb := '[]'::jsonb;
  v_tags_written jsonb := '[]'::jsonb;
  v_existing_tags jsonb := '[]'::jsonb;
  v_normalized_existing_tags text[] := array[]::text[];
  v_tag text;
  v_tag_trimmed text;
  v_outcome text;
  v_result jsonb;
  v_advance_result jsonb;
  v_allowed text[] := array[
    'external_id', 'source', 'first_name', 'last_name', 'email', 'phone',
    'phone_raw', 'phone_e164', 'address_line1', 'city', 'state', 'zip_code',
    'timezone', 'campaign_type', 'company', 'notes'
  ];
  v_protected text[] := array[
    'id', 'tenant_id', 'created_at', 'updated_at', 'journey_status',
    'current_step', 'assigned_sender_id', 'email_thread_id',
    'last_email_message_id', 'opt_out', 'responded',
    'callback_requested', 'retry_count', 'max_retries', 'next_retry_at',
    'locked_until', 'locked_by', 'run_id', 'action_id', 'workflow_action_id',
    'status', 'result', 'payload', 'failed_at', 'completed_at'
  ];
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

  if coalesce(v_step ->> 'type', v_action.action_type) <> 'create_lead_from_payload' then
    perform public.mark_workflow_action_failed(
      p_workflow_action_id,
      'Workflow action is not create_lead_from_payload.',
      1
    );
    return jsonb_build_object(
      'status', 'failed',
      'error', 'Workflow action is not create_lead_from_payload.'
    );
  end if;

  v_duplicate_mode := coalesce(nullif(v_step ->> 'duplicate_mode', ''), 'skip_existing');
  if v_duplicate_mode not in ('skip_existing', 'update_missing', 'overwrite_mapped') then
    v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object(
      'destination', 'duplicate_mode',
      'reason', 'unknown_duplicate_mode',
      'value', v_duplicate_mode
    ));
    v_duplicate_mode := 'skip_existing';
  end if;

  for v_mapping in
    select value from jsonb_array_elements(coalesce(v_step -> 'field_mappings', '[]'::jsonb))
  loop
    v_destination := lower(btrim(coalesce(v_mapping ->> 'destination', '')));

    if v_destination = '' then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object(
        'destination', null,
        'reason', 'missing_destination'
      ));
      continue;
    end if;

    if v_destination = any(v_protected) then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object(
        'destination', v_destination,
        'reason', 'protected_field'
      ));
      continue;
    end if;

    v_value := public.resolve_workflow_mapping_value(v_mapping -> 'source', v_action.run_id, v_run.lead_id);

    if v_value is null then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object(
        'destination', v_destination,
        'reason', 'missing_value'
      ));
      continue;
    end if;

    if left(v_destination, 7) = 'custom.' then
      v_custom_key := substring(v_destination from 8);
      if nullif(v_custom_key, '') is null then
        v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object(
          'destination', v_destination,
          'reason', 'missing_custom_key'
        ));
      else
        v_custom := jsonb_set(v_custom, array[v_custom_key], to_jsonb(v_value), true);
      end if;
      continue;
    end if;

    if not v_destination = any(v_allowed) then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object(
        'destination', v_destination,
        'reason', 'unsupported_field'
      ));
      continue;
    end if;

    if v_destination in ('company', 'notes') and not exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'leads'
         and column_name = v_destination
    ) then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object(
        'destination', v_destination,
        'reason', 'column_not_found'
      ));
      continue;
    end if;

    if v_destination = 'phone' then
      v_phone := nullif(btrim(v_value), '');
      v_standard := v_standard || jsonb_build_object('phone_raw', v_value, 'phone_e164', v_value);
    elsif v_destination = 'email' then
      v_email := nullif(lower(btrim(v_value)), '');
      v_standard := v_standard || jsonb_build_object('email', v_email);
    elsif v_destination in ('phone_raw', 'phone_e164') then
      if v_destination = 'phone_e164' then
        v_phone := nullif(btrim(v_value), '');
      elsif v_phone is null then
        v_phone := nullif(btrim(v_value), '');
      end if;
      v_standard := v_standard || jsonb_build_object(v_destination, v_value);
    else
      v_standard := v_standard || jsonb_build_object(v_destination, v_value);
    end if;
  end loop;

  v_email := coalesce(v_email, nullif(lower(btrim(v_standard ->> 'email')), ''));
  v_phone := coalesce(
    v_phone,
    nullif(btrim(v_standard ->> 'phone_e164'), ''),
    nullif(btrim(v_standard ->> 'phone_raw'), '')
  );

  if v_email is null and v_phone is null then
    v_result := jsonb_build_object(
      'status', 'failed',
      'error', 'Create Lead requires at least email or phone.',
      'fields_skipped', v_fields_skipped
    );

    update public.workflow_actions
       set result = coalesce(result, '{}'::jsonb) || v_result,
           last_error = 'Create Lead requires at least email or phone.'
     where id = p_workflow_action_id;

    perform public.mark_workflow_action_failed(
      p_workflow_action_id,
      'Create Lead requires at least email or phone.',
      1
    );

    return v_result;
  end if;

  if v_email is not null then
    select *
      into v_lead
      from public.leads
     where tenant_id = v_action.tenant_id
       and lower(email) = v_email
     order by created_at
     limit 1
     for update;

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
     order by created_at
     limit 1
     for update;

    if found then
      v_match_type := 'phone';
    end if;
  end if;

  v_tags := coalesce(v_step -> 'tags', '[]'::jsonb);
  v_next_custom := coalesce(v_lead.custom_fields, '{}'::jsonb);
  if jsonb_typeof(v_next_custom -> 'tags') = 'array' then
    v_existing_tags := v_next_custom -> 'tags';
  end if;

  select coalesce(array_agg(lower(value)), array[]::text[])
    into v_normalized_existing_tags
    from jsonb_array_elements_text(v_existing_tags);

  for v_tag_source in
    select value from jsonb_array_elements(v_tags)
  loop
    v_tag := public.resolve_workflow_mapping_value(v_tag_source, v_action.run_id, coalesce(v_lead.id, v_run.lead_id));
    v_tag_trimmed := nullif(btrim(coalesce(v_tag, '')), '');

    if v_tag_trimmed is not null and not (lower(v_tag_trimmed) = any(v_normalized_existing_tags)) then
      v_existing_tags := v_existing_tags || to_jsonb(v_tag_trimmed);
      v_normalized_existing_tags := array_append(v_normalized_existing_tags, lower(v_tag_trimmed));
      v_tags_written := v_tags_written || to_jsonb(v_tag_trimmed);
    end if;
  end loop;

  if jsonb_array_length(v_existing_tags) > 0 then
    v_next_custom := jsonb_set(coalesce(v_next_custom, '{}'::jsonb), '{tags}', v_existing_tags, true);
  end if;

  if v_lead.id is null then
    v_next_custom := coalesce(v_next_custom, '{}'::jsonb) || v_custom;

    insert into public.leads (
      tenant_id,
      external_id,
      source,
      first_name,
      last_name,
      email,
      phone_raw,
      phone_e164,
      address_line1,
      city,
      state,
      zip_code,
      timezone,
      campaign_type,
      custom_fields,
      raw_payload
    ) values (
      v_action.tenant_id,
      v_standard ->> 'external_id',
      coalesce(nullif(v_standard ->> 'source', ''), 'Workflow'),
      v_standard ->> 'first_name',
      v_standard ->> 'last_name',
      v_email,
      coalesce(v_standard ->> 'phone_raw', v_phone),
      coalesce(v_standard ->> 'phone_e164', v_phone),
      v_standard ->> 'address_line1',
      v_standard ->> 'city',
      v_standard ->> 'state',
      v_standard ->> 'zip_code',
      v_standard ->> 'timezone',
      v_standard ->> 'campaign_type',
      coalesce(v_next_custom, '{}'::jsonb),
      coalesce(v_run.raw_payload, '{}'::jsonb)
    )
    returning * into v_lead;

    v_outcome := 'created';
    v_match_type := 'new';
    v_fields_written := (
      select coalesce(jsonb_agg(key), '[]'::jsonb)
        from jsonb_each(v_standard)
    ) || (
      select coalesce(jsonb_agg('custom.' || key), '[]'::jsonb)
        from jsonb_each(v_custom)
    );
  else
    v_existing_custom := coalesce(v_lead.custom_fields, '{}'::jsonb);
    v_next_custom := coalesce(v_existing_custom, '{}'::jsonb);

    if jsonb_array_length(v_existing_tags) > 0 then
      v_next_custom := jsonb_set(v_next_custom, '{tags}', v_existing_tags, true);
    end if;

    if v_duplicate_mode = 'skip_existing' then
      v_outcome := 'skipped';
    else
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.external_id, '') is null) then
        if v_standard ? 'external_id' then
          v_lead.external_id := v_standard ->> 'external_id';
          v_fields_written := v_fields_written || to_jsonb('external_id'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.source, '') is null) then
        if v_standard ? 'source' then
          v_lead.source := v_standard ->> 'source';
          v_fields_written := v_fields_written || to_jsonb('source'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.first_name, '') is null) then
        if v_standard ? 'first_name' then
          v_lead.first_name := v_standard ->> 'first_name';
          v_fields_written := v_fields_written || to_jsonb('first_name'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.last_name, '') is null) then
        if v_standard ? 'last_name' then
          v_lead.last_name := v_standard ->> 'last_name';
          v_fields_written := v_fields_written || to_jsonb('last_name'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.email, '') is null) then
        if v_standard ? 'email' then
          v_lead.email := v_email;
          v_fields_written := v_fields_written || to_jsonb('email'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.phone_raw, '') is null) then
        if v_standard ? 'phone_raw' then
          v_lead.phone_raw := v_standard ->> 'phone_raw';
          v_fields_written := v_fields_written || to_jsonb('phone_raw'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.phone_e164, '') is null) then
        if v_standard ? 'phone_e164' then
          v_lead.phone_e164 := v_standard ->> 'phone_e164';
          v_fields_written := v_fields_written || to_jsonb('phone_e164'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.address_line1, '') is null) then
        if v_standard ? 'address_line1' then
          v_lead.address_line1 := v_standard ->> 'address_line1';
          v_fields_written := v_fields_written || to_jsonb('address_line1'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.city, '') is null) then
        if v_standard ? 'city' then
          v_lead.city := v_standard ->> 'city';
          v_fields_written := v_fields_written || to_jsonb('city'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.state, '') is null) then
        if v_standard ? 'state' then
          v_lead.state := v_standard ->> 'state';
          v_fields_written := v_fields_written || to_jsonb('state'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.zip_code, '') is null) then
        if v_standard ? 'zip_code' then
          v_lead.zip_code := v_standard ->> 'zip_code';
          v_fields_written := v_fields_written || to_jsonb('zip_code'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.timezone, '') is null) then
        if v_standard ? 'timezone' then
          v_lead.timezone := v_standard ->> 'timezone';
          v_fields_written := v_fields_written || to_jsonb('timezone'::text);
        end if;
      end if;
      if v_duplicate_mode = 'overwrite_mapped'
         or (v_duplicate_mode = 'update_missing' and nullif(v_lead.campaign_type, '') is null) then
        if v_standard ? 'campaign_type' then
          v_lead.campaign_type := v_standard ->> 'campaign_type';
          v_fields_written := v_fields_written || to_jsonb('campaign_type'::text);
        end if;
      end if;

      for v_custom_key, v_value in
        select key, value #>> '{}' from jsonb_each(v_custom)
      loop
        if v_duplicate_mode = 'overwrite_mapped'
           or (v_duplicate_mode = 'update_missing' and nullif(v_existing_custom ->> v_custom_key, '') is null) then
          v_next_custom := jsonb_set(v_next_custom, array[v_custom_key], to_jsonb(v_value), true);
          v_fields_written := v_fields_written || to_jsonb(('custom.' || v_custom_key)::text);
        end if;
      end loop;

      update public.leads
         set external_id = v_lead.external_id,
             source = coalesce(nullif(v_lead.source, ''), source),
             first_name = v_lead.first_name,
             last_name = v_lead.last_name,
             email = v_lead.email,
             phone_raw = v_lead.phone_raw,
             phone_e164 = v_lead.phone_e164,
             address_line1 = v_lead.address_line1,
             city = v_lead.city,
             state = v_lead.state,
             zip_code = v_lead.zip_code,
             timezone = v_lead.timezone,
             campaign_type = v_lead.campaign_type,
             custom_fields = v_next_custom,
             updated_at = now()
       where id = v_lead.id
       returning * into v_lead;

      v_outcome := 'updated';
    end if;
  end if;

  if v_outcome = 'skipped' then
    v_tags_written := '[]'::jsonb;
  end if;

  v_lead_id := v_lead.id;

  perform public.attach_lead_to_journey_run(v_action.tenant_id, v_action.run_id, v_lead_id);

  v_result := jsonb_build_object(
    'status', 'completed',
    'outcome', v_outcome,
    'lead_id', v_lead_id,
    'match_type', coalesce(v_match_type, 'unknown'),
    'duplicate_mode', v_duplicate_mode,
    'fields_written', v_fields_written,
    'fields_skipped', v_fields_skipped,
    'tags_written', v_tags_written
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
           '{steps,create_lead}',
           v_result,
           true
         ),
         updated_at = now()
   where id = v_action.run_id;

  v_advance_result := public.advance_workflow_run(p_workflow_action_id, v_outcome);

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
