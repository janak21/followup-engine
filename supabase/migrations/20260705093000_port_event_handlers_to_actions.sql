-- Phase 2: port event-native workflow handlers onto public.actions.
-- Event workflow runs are journey_runs; their work now lives in actions.

create or replace function public.mark_action_failed_permanent(
  p_action_id uuid,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
begin
  update public.actions
     set status = 'failed_permanent',
         error_message = left(coalesce(p_error_message, 'Action failed.'), 2000),
         last_error = left(coalesce(p_error_message, 'Action failed.'), 2000),
         locked_until = null,
         locked_by = null,
         completed_at = coalesce(completed_at, now()),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'status', 'failed',
           'reason', left(coalesce(p_error_message, 'Action failed.'), 2000)
         )
   where id = p_action_id
   returning * into v_action;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_action.run_id is not null then
    update public.journey_runs
       set status = 'failed',
           failed_at = coalesce(failed_at, now()),
           last_error = left(coalesce(p_error_message, 'Action failed.'), 2000)
     where id = v_action.run_id
       and status not in ('completed', 'failed', 'cancelled');
  end if;

  return jsonb_build_object('status', 'failed_permanent', 'action_id', p_action_id);
end;
$$;

create or replace function public.process_action_create_lead_from_payload(
  p_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
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
  v_advance_result uuid;
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
    'locked_until', 'locked_by', 'run_id', 'action_id', 'action_id',
    'status', 'result', 'payload', 'failed_at', 'completed_at'
  ];
begin
  select *
    into v_action
    from public.actions
   where id = p_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_action.status = 'completed' then
    return coalesce(v_action.result, '{}'::jsonb) || jsonb_build_object(
      'status', 'already_completed',
      'action_id', v_action.id
    );
  end if;

  select *
    into v_run
    from public.journey_runs
   where id = v_action.run_id
   for update;

  if not found then
    perform public.mark_action_failed_permanent(
      p_action_id,
      'Associated journey run was not found.'
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
    perform public.mark_action_failed_permanent(
      p_action_id,
      'Workflow action is not create_lead_from_payload.'
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

    update public.actions
       set result = coalesce(result, '{}'::jsonb) || v_result,
           last_error = 'Create Lead requires at least email or phone.'
     where id = p_action_id;

    perform public.mark_action_failed_permanent(
      p_action_id,
      'Create Lead requires at least email or phone.'
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
             custom_fields = v_next_custom
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

  update public.actions
     set lead_id = v_lead_id,
         status = 'completed',
         completed_at = coalesce(completed_at, now()),
         locked_until = null,
         locked_by = null,
         last_error = null,
         result = coalesce(result, '{}'::jsonb) || v_result
   where id = p_action_id
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
         )
   where id = v_action.run_id;

  v_advance_result := public.advance_journey(p_action_id, v_outcome);

  return v_result || jsonb_build_object(
    'action_id', p_action_id,
    'advance', v_advance_result
  );
exception
  when others then
    perform public.mark_action_failed_permanent(
      p_action_id,
      left(sqlerrm, 2000)
    );
    return jsonb_build_object(
      'status', 'failed',
      'error', sqlerrm
    );
end;
$$;

create or replace function public.process_action_find_lead_from_payload(
  p_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
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
  v_advance_result uuid;
begin
  select *
    into v_action
    from public.actions
   where id = p_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_action.status = 'completed' then
    return coalesce(v_action.result, '{}'::jsonb) || jsonb_build_object(
      'status', 'already_completed',
      'action_id', v_action.id
    );
  end if;

  select *
    into v_run
    from public.journey_runs
   where id = v_action.run_id
   for update;

  if not found then
    perform public.mark_action_failed_permanent(
      p_action_id,
      'Associated journey run was not found.'
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
    perform public.mark_action_failed_permanent(
      p_action_id,
      'Workflow action is not find_lead_from_payload.'
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

    update public.actions
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           locked_until = null,
           locked_by = null,
           last_error = null,
           result = coalesce(result, '{}'::jsonb) || v_result
     where id = p_action_id
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
           )
     where id = v_action.run_id;

    v_advance_result := public.advance_journey(p_action_id, 'not_found');

    return v_result || jsonb_build_object(
      'action_id', p_action_id,
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

  update public.actions
     set lead_id = v_lead_id,
         status = 'completed',
         completed_at = coalesce(completed_at, now()),
         locked_until = null,
         locked_by = null,
         last_error = null,
         result = coalesce(result, '{}'::jsonb) || v_result
   where id = p_action_id
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
         )
   where id = v_action.run_id;

  v_advance_result := public.advance_journey(p_action_id, 'found');

  return v_result || jsonb_build_object(
    'action_id', p_action_id,
    'advance', v_advance_result
  );
exception
  when others then
    perform public.mark_action_failed_permanent(
      p_action_id,
      left(sqlerrm, 2000)
    );
    return jsonb_build_object(
      'status', 'failed',
      'error', sqlerrm
    );
end;
$$;

create or replace function public.process_action_event_conditional_split(
  p_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_run public.journey_runs%rowtype;
  v_step jsonb;
  v_condition jsonb;
  v_outcome text;
  v_advance uuid;
begin
  select *
    into v_action
    from public.actions
   where id = p_action_id
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
    update public.actions
       set status = 'failed_permanent',
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

  update public.actions
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

  v_advance := public.advance_journey(v_action.id, v_outcome);

  return jsonb_build_object(
    'status', 'completed',
    'outcome', v_outcome,
    'advance', v_advance
  );
exception
  when others then
    update public.actions
       set status = 'failed_permanent',
           locked_until = null,
           locked_by = null,
           last_error = left(sqlerrm, 2000),
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'status', 'failed',
             'reason', left(sqlerrm, 2000)
           )
     where id = p_action_id;

    return jsonb_build_object('status', 'failed', 'reason', left(sqlerrm, 2000));
end;
$$;


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
    v_condition := v_step -> 'condition';

    if public.evaluate_workflow_condition(v_condition, v_action.run_id, coalesce(v_action.lead_id, v_run.lead_id), coalesce(v_action.result, '{}'::jsonb)) then
      v_outcome := 'yes';
    else
      v_outcome := 'no';
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
             'condition_evaluated', coalesce(v_condition, '{}'::jsonb),
             'completed_at', now()
           )
     where id = v_action.id;

    v_next_action_id := public.advance_journey(v_action.id, v_outcome);

    return jsonb_build_object(
      'status', 'completed',
      'outcome', v_outcome,
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

  v_condition := v_step->'condition';

  if public.evaluate_condition(v_condition, v_lead.id) then
    v_outcome := 'yes';
  else
    v_outcome := 'no';
  end if;

  update public.actions
     set status = 'completed',
         result = jsonb_build_object('outcome', v_outcome, 'condition_evaluated', v_condition),
         completed_at = now()
   where id = p_action_id;

  insert into public.events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (v_action.tenant_id, v_lead.id, v_action.id, 'system', 'internal', 'engine',
          jsonb_build_object('step_type', 'conditional_split', 'outcome', v_outcome, 'condition', v_condition));

  v_next_action_id := public.advance_journey(p_action_id, v_outcome);

  return jsonb_build_object(
    'status', 'success',
    'outcome', v_outcome,
    'next_action_id', v_next_action_id
  );
exception
  when others then
    perform public.mark_action_failed_permanent(p_action_id, left(sqlerrm, 2000));
    return jsonb_build_object('status', 'failed', 'reason', left(sqlerrm, 2000));
end;
$$;



create or replace function public.process_action_http_request(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_lead public.leads%rowtype;
  v_run public.journey_runs%rowtype;
  v_journey public.journeys%rowtype;
  v_step jsonb;
  v_method text;
  v_url text;
  v_url_check jsonb;
  v_headers_raw jsonb;
  v_headers_out jsonb := '{}'::jsonb;
  v_hkey text;
  v_hval text;
  v_body_raw text;
  v_body_text text;
  v_body_jsonb jsonb;
  v_response_var text;
  v_request_id bigint;
  v_event_mode boolean := false;
begin
  select * into v_action from public.actions where id = p_action_id for update;
  if not found then return jsonb_build_object('status','failed','reason','action_not_found'); end if;
  if v_action.status <> 'pending' then
    return jsonb_build_object('status','already_handled','status_was',v_action.status);
  end if;
  if v_action.result ? 'pg_net_request_id' then
    return jsonb_build_object('status','already_fired','request_id',v_action.result->>'pg_net_request_id');
  end if;

  if v_action.run_id is not null then
    select * into v_run from public.journey_runs where id = v_action.run_id;
    v_event_mode := found and v_run.mode = 'event_workflow';
  end if;

  if v_event_mode then
    if coalesce(v_action.lead_id, v_run.lead_id) is not null then
      select * into v_lead from public.leads where id = coalesce(v_action.lead_id, v_run.lead_id);
    end if;
    v_step := coalesce(v_action.payload -> 'step_spec', '{}'::jsonb);
    v_method := upper(coalesce(nullif(v_step ->> 'http_method', ''), 'POST'));
    v_url := public.resolve_workflow_template(v_step ->> 'http_url', v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb));
    v_headers_raw := coalesce(v_step -> 'http_headers', '{}'::jsonb);
    v_body_raw := coalesce(v_step ->> 'http_body', '');
    v_response_var := nullif(btrim(coalesce(v_step ->> 'response_var', '')), '');
  else
    select * into v_lead from public.leads where id = v_action.lead_id;
    if not found then
      perform public.mark_action_failed_permanent(p_action_id, 'lead not found');
      return jsonb_build_object('status','failed','reason','lead_not_found');
    end if;

    select * into v_journey
      from public.journeys
     where tenant_id = v_action.tenant_id
       and journey_key = v_lead.journey_template
       and active
     order by version desc limit 1;
    if not found then
      perform public.mark_action_failed_permanent(p_action_id, 'journey not found');
      return jsonb_build_object('status','failed','reason','journey_not_found');
    end if;

    select s into v_step
      from jsonb_array_elements(v_journey.spec->'steps') s
     where (s->>'index')::int = v_action.step_index;

    v_method := upper(coalesce(v_step->>'http_method', 'POST'));
    v_url := public.resolve_merge_tags(coalesce(v_step->>'http_url', ''), v_lead);
    v_headers_raw := coalesce(v_step->'http_headers', '{}'::jsonb);
    v_body_raw := coalesce(v_step->>'http_body', '');
    v_response_var := v_step->>'response_var';
  end if;

  if v_url is null or v_url = '' then
    perform public.mark_action_failed_permanent(p_action_id, 'http_request step has no http_url');
    return jsonb_build_object('status','failed','reason','missing_url');
  end if;

  v_url_check := public.workflow_http_url_check(v_url);
  if coalesce((v_url_check ->> 'allowed')::boolean, false) is not true then
    perform public.mark_action_failed_permanent(p_action_id, 'blocked_url:' || coalesce(v_url_check ->> 'reason', 'not_allowed'));
    return jsonb_build_object('status','failed','reason','blocked_url:' || coalesce(v_url_check ->> 'reason', 'not_allowed'), 'url_check', v_url_check);
  end if;

  for v_hkey, v_hval in select key, value from jsonb_each_text(v_headers_raw) loop
    if lower(v_hkey) in ('host', 'content-length', 'connection', 'transfer-encoding') then
      continue;
    end if;
    if v_event_mode then
      v_headers_out := v_headers_out || jsonb_build_object(v_hkey, public.resolve_workflow_template(coalesce(v_hval,''), v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb)));
    else
      v_headers_out := v_headers_out || jsonb_build_object(v_hkey, public.resolve_merge_tags(coalesce(v_hval,''), v_lead));
    end if;
  end loop;

  if v_method in ('POST','PUT','PATCH')
     and (v_headers_out ? 'Content-Type') = false
     and v_body_raw <> '' then
    v_headers_out := v_headers_out || jsonb_build_object('Content-Type','application/json');
  end if;

  if v_event_mode then
    v_body_text := public.resolve_workflow_template(v_body_raw, v_run.id, v_run.lead_id, coalesce(v_action.result, '{}'::jsonb));
  else
    v_body_text := public.resolve_merge_tags(v_body_raw, v_lead);
  end if;

  v_body_jsonb := null;
  if v_body_text is not null and v_body_text <> '' then
    begin
      v_body_jsonb := v_body_text::jsonb;
    exception when others then
      v_body_jsonb := to_jsonb(v_body_text);
    end;
  end if;

  if v_method = 'POST' then
    select net.http_post(url:=v_url, body:=coalesce(v_body_jsonb,'{}'::jsonb), headers:=v_headers_out, timeout_milliseconds:=10000) into v_request_id;
  elsif v_method = 'GET' then
    select net.http_get(url:=v_url, headers:=v_headers_out, timeout_milliseconds:=10000) into v_request_id;
  elsif v_method = 'DELETE' then
    select net.http_delete(url:=v_url, headers:=v_headers_out, timeout_milliseconds:=10000) into v_request_id;
  else
    perform public.mark_action_failed_permanent(p_action_id, 'unsupported_http_method: ' || v_method);
    perform public.advance_journey(p_action_id, 'default');
    return jsonb_build_object('status','failed','reason','unsupported_method','method',v_method);
  end if;

  if v_request_id is null then
    perform public.mark_action_failed_permanent(p_action_id, 'pg_net returned null request_id');
    perform public.advance_journey(p_action_id, 'default');
    return jsonb_build_object('status','failed','reason','pg_net_null_request_id');
  end if;

  update public.actions
     set status = 'in_progress',
         locked_until = now() + interval '5 minutes',
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                    'pg_net_request_id', v_request_id,
                    'fired_at', now(),
                    'http_method', v_method,
                    'http_url', v_url,
                    'response_var', v_response_var
                  )
   where id = p_action_id;

  return jsonb_build_object('status','fired','request_id',v_request_id);
exception
  when others then
    perform public.mark_action_failed_permanent(p_action_id, left(sqlerrm, 2000));
    return jsonb_build_object('status','failed','reason',left(sqlerrm, 2000));
end;
$$;



do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'mark_action_failed_permanent',
         'process_action_create_lead_from_payload',
         'process_action_find_lead_from_payload',
         'process_action_event_conditional_split',
         'process_action_conditional_split',
         'process_action_http_request'
       )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
