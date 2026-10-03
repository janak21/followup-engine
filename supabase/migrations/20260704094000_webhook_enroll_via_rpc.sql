-- Phase 1: webhook enrollment goes through enroll_lead_in_journey, so a
-- webhook hit creates a journey_run like every other enrollment path.
-- Lead matching, field mapping, and sample capture are unchanged.

create or replace function public.process_journey_webhook(
  p_token text,
  p_payload jsonb,
  p_headers jsonb default '{}'::jsonb,
  p_auth_header text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_journey journeys;
  v_mapping jsonb;
  v_lead_field text;
  v_map_entry  jsonb;
  v_lead_first text;
  v_lead_last  text;
  v_lead_email text;
  v_lead_phone text;
  v_lead_id    uuid;
  v_existing_lead leads;
  v_custom_fields jsonb := '{}'::jsonb;
  v_path text;
  v_val  text;
  v_provided_token text;
  v_sample_id uuid;
  v_result jsonb;
  v_enroll jsonb;
  v_action_id uuid;

  v_stamped_lead_id_text text;
  v_stamped_lead_id      uuid;
begin
  select * into v_journey from journeys where webhook_token = p_token and active = true;
  if not found then
    return jsonb_build_object('status','failed','reason','journey_not_found_for_token');
  end if;

  if v_journey.webhook_auth_mode = 'bearer' then
    if p_auth_header is null then
      return jsonb_build_object('status','auth_failed','reason','missing_authorization_header');
    end if;
    v_provided_token := trim(regexp_replace(p_auth_header, '^[Bb]earer\s+', ''));
    if v_provided_token is null or v_provided_token = ''
       or v_provided_token <> coalesce(v_journey.webhook_secret, '') then
      return jsonb_build_object('status','auth_failed','reason','invalid_secret');
    end if;
  end if;

  insert into journey_webhook_samples (journey_id, payload, headers)
       values (v_journey.id, p_payload, p_headers) returning id into v_sample_id;
  delete from journey_webhook_samples
   where id in (
     select id from journey_webhook_samples
      where journey_id = v_journey.id
      order by received_at desc offset 20);

  v_stamped_lead_id_text := coalesce(
    _extract_json_path(p_payload, 'metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'followup_lead_id'),
    _extract_json_path(p_payload, 'body.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'body.call.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'body.call.dynamic_variables.followup_lead_id'),
    _extract_json_path(p_payload, 'call.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'call.dynamic_variables.followup_lead_id')
  );

  if v_stamped_lead_id_text is not null and v_stamped_lead_id_text <> '' then
    begin
      v_stamped_lead_id := v_stamped_lead_id_text::uuid;
    exception when others then
      v_stamped_lead_id := null;
    end;

    if v_stamped_lead_id is not null then
      select * into v_existing_lead
        from leads
       where id = v_stamped_lead_id and tenant_id = v_journey.tenant_id;

      if found then
        v_lead_id := v_existing_lead.id;
        update leads
           set raw_payload = p_payload,
               updated_at  = now()
         where id = v_lead_id;

        -- PHASE1: run-centric enrollment (re-entry allowed; running run reused)
        v_enroll := enroll_lead_in_journey(
          v_journey.tenant_id, v_lead_id, v_journey.journey_key, 'webhook', p_payload
        );
        v_action_id := nullif(v_enroll ->> 'action_id', '')::uuid;

        v_result := jsonb_build_object(
          'status','success', 'lead_id', v_lead_id, 'action_id', v_action_id,
          'run_id', nullif(v_enroll ->> 'run_id', '')::uuid,
          'enroll_status', v_enroll ->> 'status',
          'journey_key', v_journey.journey_key, 'matched_via','followup_lead_id'
        );
        update journey_webhook_samples
           set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
               result_message='Lead matched via followup_lead_id, enrollment: ' || coalesce(v_enroll ->> 'status', 'unknown')
         where id = v_sample_id;
        return v_result;
      end if;
      v_result := jsonb_build_object(
        'status','sample_captured_no_lead', 'reason','stamped_lead_id_not_found',
        'message','followup_lead_id=' || v_stamped_lead_id_text || ' did not match any lead in this tenant.'
      );
      update journey_webhook_samples
         set result_status='sample_captured_no_lead', result_reason='stamped_lead_id_not_found',
             result_message=v_result->>'message'
       where id = v_sample_id;
      return v_result;
    end if;
  end if;

  v_mapping := coalesce(v_journey.spec->'webhook_mapping', '{}'::jsonb);

  for v_lead_field, v_map_entry in select * from jsonb_each(v_mapping) loop
    if jsonb_typeof(v_map_entry) = 'string' then v_path := v_map_entry #>> '{}';
    else v_path := v_map_entry->>'from'; end if;
    v_val := _extract_json_path(p_payload, v_path);
    if v_val is null then continue; end if;

    if v_lead_field = 'first_name' then v_lead_first := v_val;
    elsif v_lead_field = 'last_name' then v_lead_last := v_val;
    elsif v_lead_field = 'email' then v_lead_email := lower(v_val);
    elsif v_lead_field in ('phone','phone_e164','phone_raw') then v_lead_phone := v_val;
    elsif v_lead_field like 'custom.%' then
      v_custom_fields := v_custom_fields || jsonb_build_object(substring(v_lead_field from 8), v_val);
    end if;
  end loop;

  if v_lead_email is null then v_lead_email := lower(coalesce(p_payload->>'email','')); end if;
  if v_lead_first is null then v_lead_first := coalesce(p_payload->>'first_name', p_payload->>'firstName',''); end if;
  if v_lead_last  is null then v_lead_last  := coalesce(p_payload->>'last_name',  p_payload->>'lastName',''); end if;
  if v_lead_phone is null then v_lead_phone := coalesce(p_payload->>'phone',      p_payload->>'phoneNumber',''); end if;
  if v_lead_email = '' then v_lead_email := null; end if;
  if v_lead_first = '' then v_lead_first := null; end if;
  if v_lead_last  = '' then v_lead_last  := null; end if;
  if v_lead_phone = '' then v_lead_phone := null; end if;

  if v_lead_email is null and v_lead_phone is null then
    v_result := jsonb_build_object('status','sample_captured_no_lead','reason','no_identifier',
      'message','Sample captured but no identifier was resolved. Stamp followup_lead_id on outbound, or configure webhook_mapping for new-lead intake.');
    update journey_webhook_samples
       set result_status='sample_captured_no_lead', result_reason='no_identifier',
           result_message=v_result->>'message'
     where id = v_sample_id;
    return v_result;
  end if;

  if v_lead_email is not null then
    select * into v_existing_lead from leads
     where tenant_id = v_journey.tenant_id and lower(email) = v_lead_email
     order by created_at desc limit 1;
  end if;
  if v_existing_lead.id is null and v_lead_phone is not null then
    select * into v_existing_lead from leads
     where tenant_id = v_journey.tenant_id and phone_e164 = v_lead_phone
     order by created_at desc limit 1;
  end if;

  if v_existing_lead.id is null then
    insert into leads (
      tenant_id, source, first_name, last_name, email, phone_raw, phone_e164,
      journey_status, custom_fields, raw_payload
    ) values (
      v_journey.tenant_id, 'webhook', v_lead_first, v_lead_last, v_lead_email,
      v_lead_phone, v_lead_phone, 'new', v_custom_fields, p_payload
    ) returning id into v_lead_id;
  else
    update leads set
      first_name = coalesce(v_lead_first, first_name),
      last_name  = coalesce(v_lead_last,  last_name),
      email      = coalesce(nullif(v_lead_email, ''), email),
      phone_raw  = coalesce(v_lead_phone, phone_raw),
      phone_e164 = coalesce(v_lead_phone, phone_e164),
      custom_fields = coalesce(custom_fields,'{}'::jsonb) || v_custom_fields,
      raw_payload = p_payload,
      updated_at = now()
     where id = v_existing_lead.id
     returning id into v_lead_id;
  end if;

  -- PHASE1: run-centric enrollment (sets the lead mirror columns itself)
  v_enroll := enroll_lead_in_journey(
    v_journey.tenant_id, v_lead_id, v_journey.journey_key, 'webhook', p_payload
  );
  v_action_id := nullif(v_enroll ->> 'action_id', '')::uuid;

  v_result := jsonb_build_object('status','success','lead_id', v_lead_id,
                                 'action_id', v_action_id,
                                 'run_id', nullif(v_enroll ->> 'run_id', '')::uuid,
                                 'enroll_status', v_enroll ->> 'status',
                                 'journey_key', v_journey.journey_key);
  update journey_webhook_samples
     set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
         result_message='Lead created/updated, enrollment: ' || coalesce(v_enroll ->> 'status', 'unknown')
   where id = v_sample_id;
  return v_result;
end;
$$;

revoke execute on function public.process_journey_webhook(text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.process_journey_webhook(text, jsonb, jsonb, text)
  to service_role;
