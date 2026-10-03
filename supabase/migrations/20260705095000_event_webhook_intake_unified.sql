-- Phase 2: enqueue event-workflow webhook starts into public.actions.
--
-- result_workflow_action_id becomes a transitional pointer: legacy samples may
-- reference workflow_actions.id, while new event-workflow samples reference
-- actions.id until the UI union lands and workflow_actions drains.
alter table public.journey_webhook_samples
  drop constraint if exists journey_webhook_samples_result_workflow_action_id_fkey;

comment on column public.journey_webhook_samples.result_workflow_action_id is
  'Transitional event action pointer: legacy rows may reference workflow_actions.id; Phase 2+ rows reference actions.id.';
--
-- 20260704094000_webhook_enroll_via_rpc (Phase 1, Task 5) was based on the
-- 2026-06-26 backfill version of process_journey_webhook and unknowingly
-- CLOBBERED the event-workflow branch added by 20260629130000 +
-- 20260630033325. Since Phase 1 was applied, webhook hits on
-- mode='event_workflow' journeys fell through to the lead-enrollment path
-- (no journey_run + workflow_action created; typically
-- 'sample_captured_no_lead').
--
-- This version = Phase 1 lead-journey path (enroll_lead_in_journey RPC)
-- + the event_workflow branch verbatim from 20260630033325.
-- Phase 2 will re-point the event branch at the unified actions queue.

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
  -- event_workflow branch (verbatim from 20260630033325):
  v_step0      jsonb;
  v_mode text;
  v_trigger_step_index integer;
  v_run_id uuid;
  v_existing_run_id uuid;
  v_existing_action_id uuid;
  v_run_idempotency_key text;
  v_request_idempotency_key text;
  v_duplicate boolean := false;
  v_dispatch jsonb := '{}'::jsonb;
  v_action_status text;
  v_action_result jsonb;
  v_action_lead_id uuid;
  v_run_status text;
  v_message text;
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

  v_mode := coalesce(v_journey.spec->>'mode', 'lead_journey');
  if v_mode = 'event_workflow' then
    if coalesce(v_journey.webhook_enabled, false) is not true then
      v_result := jsonb_build_object(
        'mode', 'event_workflow',
        'queued', false,
        'duplicate', false,
        'status', 'failed',
        'reason', 'webhook_disabled'
      );
      update journey_webhook_samples
         set result_status = 'failed',
             result_reason = 'webhook_disabled',
             result_message = 'Event workflow webhook is disabled.'
       where id = v_sample_id;
      return v_result;
    end if;

    v_trigger_step_index := coalesce(nullif(v_journey.spec->>'trigger_next_step', '')::integer, 0);
    select s into v_step0
      from jsonb_array_elements(coalesce(v_journey.spec->'steps', '[]'::jsonb)) s
     where (s->>'index')::integer = v_trigger_step_index
     limit 1;

    if v_step0 is null then
      v_result := jsonb_build_object(
        'mode', 'event_workflow',
        'queued', false,
        'duplicate', false,
        'status', 'failed',
        'reason', 'missing_start_step'
      );
      update journey_webhook_samples
         set result_status = 'failed',
             result_reason = 'missing_start_step',
             result_message = 'Event workflow has no webhook start step.'
       where id = v_sample_id;
      return v_result;
    end if;

    if coalesce(v_step0->>'type', '') not in ('create_lead_from_payload', 'find_lead_from_payload') then
      v_result := jsonb_build_object(
        'mode', 'event_workflow',
        'queued', false,
        'duplicate', false,
        'status', 'failed',
        'reason', 'unsupported_start_step',
        'action_type', v_step0->>'type'
      );
      update journey_webhook_samples
         set result_status = 'failed',
             result_reason = 'unsupported_start_step',
             result_message = 'Event workflow webhook start only supports create_lead_from_payload or find_lead_from_payload.'
       where id = v_sample_id;
      return v_result;
    end if;

    v_request_idempotency_key := nullif(trim(coalesce(
      p_headers->>'idempotency-key',
      p_headers->>'Idempotency-Key',
      p_headers->>'x-idempotency-key',
      p_headers->>'X-Idempotency-Key',
      ''
    )), '');
    v_run_idempotency_key := 'event-webhook:' || v_journey.id::text || ':' || coalesce(v_request_idempotency_key, md5(p_payload::text));

    select id into v_existing_run_id
      from public.journey_runs
     where tenant_id = v_journey.tenant_id
       and idempotency_key = v_run_idempotency_key
     limit 1;

    v_run_id := public.create_journey_run(
      p_tenant_id => v_journey.tenant_id,
      p_journey_id => v_journey.id,
      p_journey_key => v_journey.journey_key,
      p_journey_version => v_journey.version,
      p_mode => 'event_workflow',
      p_trigger_type => 'webhook',
      p_lead_id => null,
      p_context => '{}'::jsonb,
      p_raw_payload => coalesce(p_payload, '{}'::jsonb),
      p_idempotency_key => v_run_idempotency_key
    );
    v_duplicate := v_existing_run_id is not null;

    insert into public.actions (
      tenant_id,
      run_id,
      lead_id,
      action_type,
      step_index,
      run_at,
      status,
      payload,
      idempotency_key
    ) values (
      v_journey.tenant_id,
      v_run_id,
      null,
      v_step0->>'type',
      v_trigger_step_index,
      now(),
      'pending',
      jsonb_build_object('enrolled_via', 'webhook', 'step_spec', v_step0),
      'event-webhook-action:' || v_run_id::text || ':' || v_trigger_step_index::text
    )
    on conflict (tenant_id, idempotency_key) do nothing
    returning id into v_action_id;

    if v_action_id is null then
      select id into v_existing_action_id
        from public.actions
       where tenant_id = v_journey.tenant_id
         and idempotency_key = 'event-webhook-action:' || v_run_id::text || ':' || v_trigger_step_index::text
       limit 1;
      v_action_id := v_existing_action_id;
      v_duplicate := true;
    end if;

    if v_action_id is not null then
      begin
        if v_step0->>'type' = 'create_lead_from_payload' then
          perform public.process_action_create_lead_from_payload(v_action_id);
        else
          perform public.process_action_find_lead_from_payload(v_action_id);
        end if;
        v_dispatch := jsonb_build_object('processed', 1, 'failed', 0);
      exception when others then
        v_dispatch := jsonb_build_object('processed', 0, 'failed', 1, 'error', sqlerrm);
      end;
    end if;

    select status, result, lead_id
      into v_action_status, v_action_result, v_action_lead_id
      from public.actions
     where id = v_action_id;

    select status
      into v_run_status
      from public.journey_runs
     where id = v_run_id;

    if coalesce(v_dispatch->>'failed', '0')::integer > 0 or v_action_status in ('failed', 'failed_permanent') then
      v_message := 'Processing failed: ' || coalesce(v_action_result->>'error', v_action_result->>'failure_message', 'Workflow action failed.');
      v_result := jsonb_build_object(
        'mode', 'event_workflow',
        'status', 'failed',
        'run_id', v_run_id,
        'workflow_action_id', v_action_id,
        'workflow_action_status', v_action_status,
        'run_status', v_run_status,
        'queued', false,
        'duplicate', v_duplicate,
        'dispatch', v_dispatch,
        'result', coalesce(v_action_result, '{}'::jsonb),
        'sample_id', v_sample_id
      );

      update journey_webhook_samples
         set result_status = 'failed',
             result_reason = coalesce(v_action_result->>'error', v_action_result->>'failure_message', 'workflow_action_failed'),
             result_message = v_message,
             result_run_id = v_run_id,
             result_workflow_action_id = v_action_id,
             result_lead_id = v_action_lead_id,
             result_details = coalesce(v_action_result, '{}'::jsonb) || jsonb_build_object('dispatch', v_dispatch)
       where id = v_sample_id;
      return v_result;
    end if;

    if v_action_status = 'completed' then
      v_message := case
        when v_action_result->>'outcome' = 'created' then 'Lead created.'
        when v_action_result->>'outcome' = 'updated' then 'Lead updated.'
        when v_action_result->>'outcome' = 'skipped' then 'Lead matched; existing lead skipped.'
        when v_action_result->>'outcome' = 'found' then 'Lead found.'
        when v_action_result->>'outcome' = 'not_found' then 'No lead found.'
        else 'Event workflow processed.'
      end;

      v_result := jsonb_build_object(
        'mode', 'event_workflow',
        'status', 'processed',
        'run_id', v_run_id,
        'workflow_action_id', v_action_id,
        'workflow_action_status', v_action_status,
        'run_status', v_run_status,
        'queued', false,
        'duplicate', v_duplicate,
        'dispatch', v_dispatch,
        'result', coalesce(v_action_result, '{}'::jsonb),
        'sample_id', v_sample_id
      );

      update journey_webhook_samples
         set result_status = 'processed',
             result_reason = coalesce(v_action_result->>'outcome', case when v_duplicate then 'duplicate' else null end),
             result_message = v_message,
             result_run_id = v_run_id,
             result_workflow_action_id = v_action_id,
             result_lead_id = v_action_lead_id,
             result_details = coalesce(v_action_result, '{}'::jsonb) || jsonb_build_object('dispatch', v_dispatch)
       where id = v_sample_id;
      return v_result;
    end if;

    v_result := jsonb_build_object(
      'mode', 'event_workflow',
      'status', 'queued',
      'run_id', v_run_id,
      'workflow_action_id', v_action_id,
      'workflow_action_status', v_action_status,
      'run_status', v_run_status,
      'queued', v_action_id is not null,
      'duplicate', v_duplicate,
      'dispatch', v_dispatch,
      'sample_id', v_sample_id
    );

    update journey_webhook_samples
       set result_status = 'queued',
           result_reason = case when v_duplicate then 'duplicate' else null end,
           result_message = 'Event workflow run queued. No due safe workflow action was processed immediately.',
           result_action_id = null,
           result_run_id = v_run_id,
           result_workflow_action_id = v_action_id,
           result_details = jsonb_build_object('dispatch', v_dispatch)
     where id = v_sample_id;
    return v_result;
  end if;


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
