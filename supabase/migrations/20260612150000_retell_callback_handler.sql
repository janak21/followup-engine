-- Migration: Retell Call Completion Callback & Fallback Alerts
-- Created at: 2026-06-12T16:15:00+05:30

-- 1. Redefine get_alert_payload with robust fallbacks
create or replace function get_alert_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_template templates;
  v_tenant tenants;
  v_body text;
  v_subject text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    raise exception 'Action not found: %', p_action_id;
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    raise exception 'Lead not found for action: %', p_action_id;
  end if;

  select * into v_tenant from tenants where id = v_action.tenant_id;
  if not found then
    raise exception 'Tenant not found: %', v_action.tenant_id;
  end if;

  -- Attempt to select the specific template
  if v_action.template_key is not null then
    select * into v_template from templates 
    where tenant_id = v_action.tenant_id 
      and template_key = v_action.template_key 
    order by version desc 
    limit 1;
  end if;

  -- Fallback 1: Find any team_alert template for this tenant
  if v_template.id is null then
    select * into v_template from templates
    where tenant_id = v_action.tenant_id
      and channel = 'team_alert'
    order by version desc
    limit 1;
  end if;

  -- Fallback 2: Construct default subject/body
  if v_template.id is null then
    v_subject := '🚨 Follow-Up Alert: Manual Follow-up Required';
    v_body := 'Hi Team,' || chr(10) || chr(10) ||
              'An automated alert has been triggered for lead ' || coalesce(v_lead.first_name, '') || ' ' || coalesce(v_lead.last_name, '') || '.' || chr(10) ||
              'Phone: ' || coalesce(v_lead.phone_e164, 'N/A') || chr(10) ||
              'Email: ' || coalesce(v_lead.email, 'N/A') || chr(10) ||
              'Action: ' || coalesce(v_action.action_type, 'N/A') || chr(10) ||
              'Reason: ' || coalesce(v_action.payload->>'reason', 'N/A') || chr(10) ||
              'Details: ' || coalesce(v_action.payload::text, 'N/A') || chr(10) || chr(10) ||
              'Best,' || chr(10) ||
              'Follow-Up Engine';
  else
    v_subject := v_template.subject;
    v_body := v_template.body;
  end if;

  -- Replace basic template variables
  v_subject := replace(v_subject, '{{first_name}}', coalesce(v_lead.first_name, ''));
  v_body := replace(v_body, '{{first_name}}', coalesce(v_lead.first_name, ''));
  v_body := replace(v_body, '{{last_name}}', coalesce(v_lead.last_name, ''));

  return jsonb_build_object(
    'action_id', v_action.id,
    'first_name', v_lead.first_name,
    'subject', v_subject,
    'body', v_body,
    'alert_email_to', v_tenant.team_alert_email
  );
end;
$$;

-- 2. Implement process_retell_call_result RPC
create or replace function process_retell_call_result(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_call jsonb;
  v_call_id text;
  v_disconnection_reason text;
  v_duration_seconds int;
  v_recording_url text;
  v_transcript text;
  v_summary text;
  v_call_disposition text;
  v_call_successful boolean;
  v_call_analysis jsonb;
  v_custom_analysis jsonb;
  
  v_event events%rowtype;
  v_lead leads%rowtype;
  v_action actions%rowtype;
  v_tenant tenants%rowtype;
  
  v_call_outcome text;
  v_custom_outcome text;
  v_custom_disposition text;
  v_callback_requested boolean := false;
  v_callback_at timestamptz;
  v_new_action_id uuid;
begin
  -- Extract call object from payload (handles nesting under 'body'->'call', 'call', or raw payload)
  v_call := coalesce(
    p_payload->'body'->'call',
    p_payload->'call',
    p_payload
  );
  
  v_call_id := v_call->>'call_id';
  if v_call_id is null then
    raise exception 'Missing call_id in Retell payload';
  end if;

  -- Find corresponding event by provider_id = call_id
  select * into v_event
  from events
  where provider = 'retell'
    and provider_id = v_call_id
  limit 1;
  
  if not found then
    raise exception 'Retell call event not found for call_id: %', v_call_id;
  end if;
  
  -- Resolve associated lead, action, and tenant
  select * into v_lead from leads where id = v_event.lead_id;
  if not found then
    raise exception 'Lead not found for event: %', v_event.id;
  end if;
  
  if v_event.action_id is not null then
    select * into v_action from actions where id = v_event.action_id;
  end if;
  
  select * into v_tenant from tenants where id = v_event.tenant_id;

  -- Extract call analysis and fields
  v_disconnection_reason := v_call->>'disconnection_reason';
  v_duration_seconds := coalesce(
    (v_call->>'duration_seconds')::int,
    (coalesce(v_call->>'duration_ms', '0')::bigint / 1000)::int
  );
  v_recording_url := v_call->>'recording_url';
  v_transcript := v_call->>'transcript';
  
  v_call_analysis := v_call->'call_analysis';
  v_summary := coalesce(
    v_call_analysis->>'call_summary',
    v_call_analysis->>'summary',
    v_call->>'summary'
  );
  v_call_successful := coalesce(
    (v_call_analysis->>'call_successful')::boolean,
    false
  );
  
  v_custom_analysis := v_call_analysis->'custom_analysis_data';
  v_call_disposition := coalesce(
    v_call_analysis->>'call_disposition',
    v_call->>'call_disposition'
  );

  -- Determine call_outcome (standard outcomes: answered, no_answer, voicemail, invalid_number, wrong_number)
  -- Default mapping from disconnection_reason
  v_call_outcome := case
    when v_disconnection_reason in ('user_hangup', 'agent_hangup', 'call_transfer') then 'answered'
    when v_disconnection_reason in ('voicemail_reached', 'machine_detected') or coalesce((v_call_analysis->>'in_voicemail')::boolean, false) then 'voicemail'
    when v_disconnection_reason in ('no_answer_reached', 'no_answer', 'dial_no_answer', 'busy', 'dial_busy') then 'no_answer'
    when v_disconnection_reason in ('invalid_number', 'wrong_number', 'dial_failed') then 'invalid_number'
    else 'no_answer'
  end;
  
  -- Override outcome from custom analysis properties if present and valid
  v_custom_outcome := coalesce(
    v_custom_analysis->>'call_outcome',
    v_call_analysis->>'call_outcome',
    v_call->>'call_outcome'
  );
  v_custom_disposition := coalesce(
    v_custom_analysis->>'call_disposition',
    v_call_analysis->>'call_disposition',
    v_call->>'call_disposition'
  );
  
  if v_custom_outcome in ('answered', 'no_answer', 'voicemail', 'invalid_number', 'wrong_number') then
    v_call_outcome := v_custom_outcome;
  elsif v_custom_disposition in ('answered', 'no_answer', 'voicemail', 'invalid_number', 'wrong_number') then
    v_call_outcome := v_custom_disposition;
  end if;

  -- Parse callback request properties
  v_callback_requested := coalesce(
    (v_custom_analysis->>'callback_requested')::boolean,
    (v_call_analysis->>'callback_requested')::boolean,
    false
  );
  if v_callback_requested then
    v_callback_at := (coalesce(
      v_custom_analysis->>'callback_timestamp',
      v_custom_analysis->>'callback_at',
      v_call_analysis->>'callback_timestamp',
      v_call_analysis->>'callback_at'
    ))::timestamptz;
  end if;

  -- Update events table row
  update events
  set call_outcome = v_call_outcome,
      call_disposition = coalesce(v_call_disposition, v_custom_disposition, v_call_outcome),
      call_duration_seconds = v_duration_seconds,
      call_recording_url = v_recording_url,
      call_transcript = v_transcript,
      call_summary = v_summary,
      disconnection_reason = v_disconnection_reason,
      raw_payload = coalesce(raw_payload, '{}'::jsonb) || p_payload
  where id = v_event.id;

  -- Update actions table row
  if v_action.id is not null then
    update actions
    set result = coalesce(result, '{}'::jsonb) || p_payload
    where id = v_action.id;
  end if;

  -- Update lead status
  update leads
  set last_action_at = now(),
      responded = case when v_call_outcome = 'answered' then true else responded end,
      callback_requested = case when v_callback_requested then true else callback_requested end,
      callback_at = case when v_callback_requested then coalesce(v_callback_at, callback_at, now() + interval '1 day') else callback_at end,
      updated_at = now()
  where id = v_lead.id;

  -- Advance Journey if action is connected to a journey
  if v_action.id is not null and v_action.step_index >= 0 then
    v_new_action_id := advance_journey(v_action.id, v_call_outcome);
  end if;

  -- Insert team alert if callback was requested
  if v_callback_requested then
    insert into actions (
      tenant_id, lead_id, action_type, step_index, template_key, run_at, status, idempotency_key, payload
    ) values (
      v_event.tenant_id, v_lead.id, 'team_alert', coalesce(v_action.step_index, -1), 'team_callback_alert', now(), 'pending',
      v_lead.id::text || ':callback_requested:' || v_call_id,
      jsonb_build_object(
        'reason', 'callback_requested',
        'call_id', v_call_id,
        'callback_at', v_callback_at,
        'summary', v_summary
      )
    );
  end if;

  return jsonb_build_object(
    'status', 'success',
    'call_outcome', v_call_outcome,
    'callback_requested', v_callback_requested,
    'new_action_id', v_new_action_id
  );
end;
$$;

-- Grant execution permissions
grant execute on function process_retell_call_result(jsonb) to anon, authenticated, service_role;
grant execute on function get_alert_payload(uuid) to anon, authenticated, service_role;
