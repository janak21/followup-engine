-- Make Update Lead safe for event-workflow bridge actions.
-- When actions.run_id is present, read the step config from actions.payload.step_spec
-- and resolve payload/context expressions. Legacy lead journeys keep using the
-- journey-template lookup and resolve_merge_tags path.

create or replace function public.process_action_set_lead_fields(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_action public.actions%rowtype;
  v_lead public.leads%rowtype;
  v_journey public.journeys%rowtype;
  v_step jsonb;
  v_fields jsonb := '[]'::jsonb;
  v_field jsonb;
  v_key text;
  v_destination text;
  v_custom_key text;
  v_raw_value text;
  v_resolved text;
  v_mode text := 'set';
  v_write_empty boolean := false;
  v_fields_written jsonb := '[]'::jsonb;
  v_fields_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  select * into v_action
    from public.actions
   where id = p_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'failed', 'reason', 'action_not_found');
  end if;

  if v_action.status = 'completed' then
    return coalesce(v_action.result, '{}'::jsonb) || jsonb_build_object('status', 'already_completed');
  end if;

  if v_action.action_type not in ('create_lead', 'update_lead') then
    update public.actions
       set status = 'failed',
           error_message = 'process_action_set_lead_fields called for unsupported action_type ' || v_action.action_type,
           last_error = 'process_action_set_lead_fields called for unsupported action_type ' || v_action.action_type,
           locked_until = null,
           locked_by = null
     where id = p_action_id;
    return jsonb_build_object('status', 'failed', 'reason', 'unsupported_action_type');
  end if;

  select * into v_lead
    from public.leads
   where id = v_action.lead_id
   for update;

  if not found then
    update public.actions
       set status = 'failed',
           error_message = 'lead not found',
           last_error = 'lead not found',
           locked_until = null,
           locked_by = null
     where id = p_action_id;
    return jsonb_build_object('status', 'failed', 'reason', 'lead_not_found');
  end if;

  if v_action.run_id is not null then
    v_step := v_action.payload -> 'step_spec';
  end if;

  if v_step is null or jsonb_typeof(v_step) <> 'object' then
    select * into v_journey
      from public.journeys
     where tenant_id = v_action.tenant_id
       and journey_key = v_lead.journey_template
       and active
     order by version desc
     limit 1;

    if not found then
      update public.actions
         set status = 'failed',
             error_message = 'journey not found',
             last_error = 'journey not found',
             locked_until = null,
             locked_by = null
       where id = p_action_id;
      return jsonb_build_object('status', 'failed', 'reason', 'journey_not_found');
    end if;

    select s into v_step
      from jsonb_array_elements(coalesce(v_journey.spec -> 'steps', '[]'::jsonb)) s
     where (s ->> 'index')::int = v_action.step_index;
  end if;

  if v_step is null or jsonb_typeof(v_step) <> 'object' then
    update public.actions
       set status = 'failed',
           error_message = 'step spec not found',
           last_error = 'step spec not found',
           locked_until = null,
           locked_by = null
     where id = p_action_id;
    return jsonb_build_object('status', 'failed', 'reason', 'step_spec_not_found');
  end if;

  v_mode := lower(coalesce(v_step ->> 'mode', 'set'));
  if v_mode not in ('set', 'clear') then
    v_mode := 'set';
  end if;

  if jsonb_typeof(v_step -> 'fields') = 'array' then
    v_fields := v_step -> 'fields';
  elsif v_step ? 'update_field' then
    v_fields := jsonb_build_array(
      jsonb_build_object('key', v_step ->> 'update_field', 'value', v_step ->> 'update_value')
    );
  end if;

  for v_field in
    select value from jsonb_array_elements(coalesce(v_fields, '[]'::jsonb))
  loop
    v_key := lower(btrim(coalesce(v_field ->> 'key', v_field ->> 'destination', '')));
    v_destination := case when v_key = 'address' then 'address_line1' else v_key end;
    v_custom_key := null;
    v_resolved := null;
    v_write_empty := lower(coalesce(v_field ->> 'write_empty', 'false')) in ('true', '1', 'yes');

    if v_key = '' then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object('field', v_key, 'reason', 'missing_destination'));
      continue;
    end if;

    if v_key in (
      'id', 'tenant_id', 'created_at', 'updated_at', 'journey_status',
      'current_step', 'assigned_sender_id', 'email_thread_id',
      'last_email_message_id', 'opt_out', 'opt_out_channel', 'responded',
      'callback_requested', 'callback_at', 'source_batch_id',
      'sms_conversation_count', 'email_conversation_count', 'last_action_at',
      'next_action_at', 'raw_payload', 'run_id', 'retry_count', 'max_retries',
      'next_retry_at', 'locked_until', 'locked_by', 'status', 'result',
      'payload', 'failed_at', 'completed_at', 'attempt_number', 'provider',
      'provider_id', 'idempotency_key', 'error_message', 'last_error'
    )
    or v_key like 'suppression%'
    or v_key like 'internal%'
    or v_key like 'retry%'
    or v_key like 'lock%' then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object('field', v_key, 'reason', 'protected_field'));
      continue;
    end if;

    if v_key = 'tags' or v_key = 'custom.tags' then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object('field', v_key, 'reason', 'tags_managed_by_tag_steps'));
      continue;
    end if;

    if v_key like 'custom.%' then
      v_custom_key := btrim(substring(v_key from 8));
      if v_custom_key = '' then
        v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object('field', v_key, 'reason', 'missing_custom_key'));
        continue;
      end if;
    elsif v_destination not in (
      'external_id', 'first_name', 'last_name', 'source', 'email', 'phone',
      'phone_raw', 'phone_e164', 'address_line1', 'city', 'state', 'zip_code',
      'timezone', 'campaign_type'
    ) then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object('field', v_key, 'reason', 'unsupported_field'));
      continue;
    end if;

    if v_mode = 'clear' then
      if v_destination in ('source', 'external_id') then
        v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object('field', v_key, 'reason', 'cannot_clear_required_or_identity_field'));
        continue;
      end if;

      if v_custom_key is not null then
        update public.leads
           set custom_fields = coalesce(custom_fields, '{}'::jsonb) - v_custom_key,
               updated_at = now()
         where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'first_name' then
        update public.leads set first_name = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'last_name' then
        update public.leads set last_name = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'email' then
        update public.leads set email = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'phone' then
        update public.leads set phone_raw = null, phone_e164 = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'phone_raw' then
        update public.leads set phone_raw = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'phone_e164' then
        update public.leads set phone_e164 = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'address_line1' then
        update public.leads set address_line1 = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'city' then
        update public.leads set city = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'state' then
        update public.leads set state = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'zip_code' then
        update public.leads set zip_code = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'timezone' then
        update public.leads set timezone = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      elsif v_destination = 'campaign_type' then
        update public.leads set campaign_type = null, updated_at = now() where id = v_lead.id;
        v_fields_written := v_fields_written || to_jsonb(v_key);
      end if;

      continue;
    end if;

    if v_action.run_id is not null and jsonb_typeof(v_field -> 'source') = 'object' then
      v_resolved := public.resolve_workflow_mapping_value(v_field -> 'source', v_action.run_id, v_action.lead_id);
    elsif v_action.run_id is not null and jsonb_typeof(v_field -> 'value_source') = 'object' then
      v_resolved := public.resolve_workflow_mapping_value(v_field -> 'value_source', v_action.run_id, v_action.lead_id);
    else
      v_raw_value := v_field ->> 'value';
      if v_action.run_id is not null then
        v_resolved := public.resolve_workflow_expr(v_raw_value, v_action.run_id, v_action.lead_id);
      else
        v_resolved := public.resolve_merge_tags(coalesce(v_raw_value, ''), v_lead);
      end if;
    end if;

    if (v_resolved is null or btrim(v_resolved) = '') and not v_write_empty then
      v_fields_skipped := v_fields_skipped || jsonb_build_array(jsonb_build_object('field', v_key, 'reason', 'empty_value'));
      continue;
    end if;

    v_resolved := coalesce(v_resolved, '');

    if v_custom_key is not null then
      update public.leads
         set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), array[v_custom_key], to_jsonb(v_resolved), true),
             updated_at = now()
       where id = v_lead.id;
    elsif v_destination = 'external_id' then
      update public.leads set external_id = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'first_name' then
      update public.leads set first_name = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'last_name' then
      update public.leads set last_name = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'source' then
      update public.leads set source = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'email' then
      update public.leads set email = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'phone' then
      update public.leads set phone_raw = v_resolved, phone_e164 = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'phone_raw' then
      update public.leads set phone_raw = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'phone_e164' then
      update public.leads set phone_e164 = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'address_line1' then
      update public.leads set address_line1 = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'city' then
      update public.leads set city = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'state' then
      update public.leads set state = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'zip_code' then
      update public.leads set zip_code = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'timezone' then
      update public.leads set timezone = v_resolved, updated_at = now() where id = v_lead.id;
    elsif v_destination = 'campaign_type' then
      update public.leads set campaign_type = v_resolved, updated_at = now() where id = v_lead.id;
    end if;

    v_fields_written := v_fields_written || to_jsonb(v_key);
  end loop;

  v_result := jsonb_build_object(
    'status', 'success',
    'outcome', 'default',
    'mode', v_mode,
    'fields_written', v_fields_written,
    'fields_skipped', v_fields_skipped,
    'fields_applied', jsonb_array_length(v_fields_written),
    'skipped_count', jsonb_array_length(v_fields_skipped)
  );

  update public.actions
     set status = 'completed',
         result = v_result,
         completed_at = coalesce(completed_at, now()),
         locked_until = null,
         locked_by = null,
         error_message = null,
         last_error = null
   where id = p_action_id;

  insert into public.events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (
    v_action.tenant_id,
    v_lead.id,
    v_action.id,
    'system',
    'internal',
    'engine',
    jsonb_build_object(
      'step_type', v_action.action_type,
      'mode', v_mode,
      'run_id', v_action.run_id,
      'fields_written', v_fields_written,
      'fields_skipped', v_fields_skipped
    )
  );

  perform public.advance_journey(p_action_id, 'default');

  return v_result;
end;
$function$;
