-- Process webhook-triggered event workflow starts immediately for safe actions.
-- Existing lead-journey webhook intake stays on the legacy leads/actions path.

alter table public.journey_webhook_samples
  add column if not exists result_run_id uuid references public.journey_runs(id) on delete set null,
  add column if not exists result_workflow_action_id uuid references public.workflow_actions(id) on delete set null,
  add column if not exists result_details jsonb not null default '{}'::jsonb;

create or replace function public.dispatch_workflow_run_actions(
  p_run_id uuid,
  p_worker_id text default 'workflow-webhook',
  p_batch_size integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_result jsonb;
  v_processed integer := 0;
  v_completed integer := 0;
  v_failed integer := 0;
  v_unsupported integer := 0;
  v_batch_size integer := greatest(coalesce(p_batch_size, 10), 0);
  v_worker_id text := coalesce(nullif(btrim(p_worker_id), ''), 'workflow-webhook');
begin
  if p_run_id is null then
    return jsonb_build_object(
      'processed', 0,
      'completed', 0,
      'failed', 1,
      'unsupported', 0,
      'reason', 'run_id_required'
    );
  end if;

  while v_processed < v_batch_size loop
    select *
      into v_action
      from public.workflow_actions
     where run_id = p_run_id
       and status = 'pending'
       and run_at <= now()
       and (next_retry_at is null or next_retry_at <= now())
       and (locked_until is null or locked_until < now())
     order by run_at, created_at
     limit 1
     for update skip locked;

    exit when not found;

    update public.workflow_actions
       set status = 'in_progress',
           locked_by = v_worker_id,
           locked_until = now() + interval '5 minutes'
     where id = v_action.id
     returning * into v_action;

    v_processed := v_processed + 1;

    if v_action.action_type = 'create_lead_from_payload' then
      begin
        v_result := public.process_workflow_create_lead_action(v_action.id);
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
    else
      update public.workflow_actions
         set status = 'failed_permanent',
             failed_at = coalesce(failed_at, now()),
             locked_by = null,
             locked_until = null,
             last_error = 'Unsupported workflow action type for immediate webhook dispatch',
             result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
               'failed_permanent_at', now(),
               'failure_message', 'Unsupported workflow action type for immediate webhook dispatch',
               'unsupported_action_type', v_action.action_type,
               'failed_by', 'dispatch_workflow_run_actions'
             )
       where id = v_action.id;

      v_failed := v_failed + 1;
      v_unsupported := v_unsupported + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'completed', v_completed,
    'failed', v_failed,
    'unsupported', v_unsupported
  );
end;
$$;

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
as $function$
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
  v_step0      jsonb;
  v_run_at     timestamptz;
  v_action_id  uuid;
  v_custom_fields jsonb := '{}'::jsonb;
  v_path text;
  v_val  text;
  v_provided_token text;
  v_sample_id uuid;
  v_result jsonb;
  v_stamped_lead_id_text text;
  v_stamped_lead_id      uuid;
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

    insert into public.workflow_actions (
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
        from public.workflow_actions
       where tenant_id = v_journey.tenant_id
         and idempotency_key = 'event-webhook-action:' || v_run_id::text || ':' || v_trigger_step_index::text
       limit 1;
      v_action_id := v_existing_action_id;
      v_duplicate := true;
    end if;

    v_dispatch := public.dispatch_workflow_run_actions(v_run_id, 'event-webhook-immediate', 10);

    select status, result, lead_id
      into v_action_status, v_action_result, v_action_lead_id
      from public.workflow_actions
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

  -- followup_lead_id fixed-path lookup wins outright for legacy lead journeys.
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
           set journey_template = v_journey.journey_key,
               journey_status   = case when journey_status in ('completed','error') then 'active' else journey_status end,
               raw_payload      = p_payload,
               updated_at       = now()
         where id = v_lead_id;

        select s into v_step0 from jsonb_array_elements(v_journey.spec->'steps') s where (s->>'index')::int = 0;
        if v_step0 is not null then
          insert into actions (
            tenant_id, lead_id, action_type, step_index, template_key,
            run_at, status, idempotency_key, payload
          ) values (
            v_journey.tenant_id, v_lead_id, v_step0->>'type', 0, v_step0->>'template_key',
            now(), 'pending',
            v_lead_id::text || ':' || v_journey.journey_key || ':0:stamped:' || extract(epoch from now())::text,
            jsonb_build_object('enrolled_via','webhook','step_spec', v_step0)
          )
          on conflict (tenant_id, idempotency_key) do nothing
          returning id into v_action_id;
        end if;

        v_result := jsonb_build_object(
          'status','success', 'lead_id', v_lead_id, 'action_id', v_action_id,
          'journey_key', v_journey.journey_key, 'matched_via','followup_lead_id'
        );
        update journey_webhook_samples
           set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
               result_message='Lead matched via followup_lead_id, step 0 queued.'
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
      journey_template, journey_status, custom_fields, raw_payload
    ) values (
      v_journey.tenant_id, 'webhook', v_lead_first, v_lead_last, v_lead_email,
      v_lead_phone, v_lead_phone, v_journey.journey_key, 'active', v_custom_fields, p_payload
    ) returning id into v_lead_id;
  else
    update leads set
      first_name = coalesce(v_lead_first, first_name),
      last_name  = coalesce(v_lead_last,  last_name),
      email      = coalesce(nullif(v_lead_email, ''), email),
      phone_raw  = coalesce(v_lead_phone, phone_raw),
      phone_e164 = coalesce(v_lead_phone, phone_e164),
      journey_template = v_journey.journey_key,
      journey_status   = case when journey_status = 'completed' then 'active' else journey_status end,
      custom_fields = coalesce(custom_fields,'{}'::jsonb) || v_custom_fields,
      raw_payload = p_payload,
      updated_at = now()
     where id = v_existing_lead.id
     returning id into v_lead_id;
  end if;

  select s into v_step0 from jsonb_array_elements(v_journey.spec->'steps') s where (s->>'index')::int = 0;

  if v_step0 is not null then
    v_run_at := now();
    insert into actions (
      tenant_id, lead_id, action_type, step_index, template_key,
      run_at, status, idempotency_key, payload
    ) values (
      v_journey.tenant_id, v_lead_id, v_step0->>'type', 0, v_step0->>'template_key',
      v_run_at, 'pending',
      v_lead_id::text || ':' || v_journey.journey_key || ':0:webhook:' || extract(epoch from now())::text,
      jsonb_build_object('enrolled_via','webhook','step_spec', v_step0)
    )
    on conflict (tenant_id, idempotency_key) do nothing
    returning id into v_action_id;
  end if;

  v_result := jsonb_build_object('status','success','lead_id', v_lead_id,
                                 'action_id', v_action_id, 'journey_key', v_journey.journey_key);
  update journey_webhook_samples
     set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
         result_message='Lead created/updated, step 0 action queued.'
   where id = v_sample_id;
  return v_result;
end;
$function$;
