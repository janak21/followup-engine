-- Migration: dynamic credentials, sender selection, and provider idempotency check
-- Created at: 2026-06-12T05:00:00Z

-- 1. dispatch_pending_actions (Change locked_until interval from 5 to 15 minutes, set security definer and search_path)
create or replace function dispatch_pending_actions(worker_id text, batch_size int default 20)
returns setof actions
language sql
security definer
set search_path = public
as $$
  update actions
  set status = 'in_progress',
      locked_until = now() + interval '15 minutes',
      locked_by = worker_id
  where id in (
    select id
    from actions
    where run_at <= now()
      and status = 'pending'
      and (locked_until is null or locked_until < now())
    order by run_at
    limit batch_size
    for update skip locked
  )
  returning *;
$$;

-- 2. get_email_payload (Perform sender selection logic, write assigned_sender_id, return credential name and provider_id)
create or replace function get_email_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_template templates;
  v_sender senders;
  v_body text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Action not found');
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Lead not found');
  end if;

  select * into v_template from templates 
  where tenant_id = v_action.tenant_id 
    and template_key = v_action.template_key 
  order by version desc 
  limit 1;
  
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'Template not found');
  end if;

  -- sender selection logic
  if v_lead.assigned_sender_id is not null then
    select * into v_sender from senders where id = v_lead.assigned_sender_id;
  end if;

  if v_sender.id is null then
    select * into v_sender
    from senders
    where tenant_id = v_action.tenant_id
      and active = true
      and warmup_stage in ('warming', 'active')
      and sent_today < daily_limit
      and (pause_until is null or pause_until < now())
      and (last_sent_at is null or last_sent_at < now() - (min_seconds_between_sends || ' seconds')::interval)
    order by last_sent_at nulls first
    limit 1;
  end if;

  if v_sender.id is null then
    return jsonb_build_object(
      'outcome', 'no_sender',
      'reason', 'No active sender available in pool or daily limits reached'
    );
  end if;

  if v_lead.assigned_sender_id is null or v_lead.assigned_sender_id != v_sender.id then
    update leads set assigned_sender_id = v_sender.id where id = v_lead.id;
  end if;

  v_body := replace(v_template.body, '{{first_name}}', coalesce(v_lead.first_name, ''));

  return jsonb_build_object(
    'outcome', 'success',
    'action_id', v_action.id,
    'provider_id', v_action.provider_id,
    'email_to', v_lead.email,
    'first_name', v_lead.first_name,
    'subject', v_template.subject,
    'body', v_body,
    'gmail_credential_id', '',
    'gmail_credential_name', v_sender.n8n_credential_name,
    'sender_email', v_sender.sender_email,
    'sender_name', v_sender.sender_name
  );
end;
$$;

-- 3. get_sms_payload (Retrieve Twilio credentials, return custom keys including provider_id)
create or replace function get_sms_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_template templates;
  v_credentials tenant_credentials;
  v_body text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    raise exception 'Action not found: %', p_action_id;
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    raise exception 'Lead not found for action: %', p_action_id;
  end if;

  select * into v_template from templates 
  where tenant_id = v_action.tenant_id 
    and template_key = v_action.template_key 
  order by version desc 
  limit 1;
  
  if not found then
    raise exception 'Template not found for action: %', p_action_id;
  end if;

  select * into v_credentials from tenant_credentials 
  where tenant_id = v_action.tenant_id 
    and provider = 'twilio' 
    and active = true;
  
  if not found then
    raise exception 'Active Twilio credentials not found for tenant %', v_action.tenant_id;
  end if;

  v_body := replace(v_template.body, '{{first_name}}', coalesce(v_lead.first_name, ''));

  return jsonb_build_object(
    'action_id', v_action.id,
    'provider_id', v_action.provider_id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'body', v_body,
    'twilio_credential_name', v_credentials.n8n_credential_name,
    'twilio_from_number', v_credentials.config->>'from_number'
  );
end;
$$;

-- 4. get_call_payload (Retrieve Retell credentials, return custom keys including provider_id)
create or replace function get_call_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_credentials tenant_credentials;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    raise exception 'Action not found: %', p_action_id;
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    raise exception 'Lead not found for action: %', p_action_id;
  end if;

  select * into v_credentials from tenant_credentials 
  where tenant_id = v_action.tenant_id 
    and provider = 'retell' 
    and active = true;
  
  if not found then
    raise exception 'Active Retell credentials not found for tenant %', v_action.tenant_id;
  end if;

  return jsonb_build_object(
    'action_id', v_action.id,
    'provider_id', v_action.provider_id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'retell_credential_name', v_credentials.n8n_credential_name,
    'retell_from_number', v_credentials.config->>'from_number',
    'retell_agent_id', v_credentials.config->>'agent_id'
  );
end;
$$;

-- 5. get_alert_payload (Retrieve tenant.team_alert_email and return rendered body)
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
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    raise exception 'Action not found: %', p_action_id;
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then
    raise exception 'Lead not found for action: %', p_action_id;
  end if;

  select * into v_template from templates 
  where tenant_id = v_action.tenant_id 
    and template_key = v_action.template_key 
  order by version desc 
  limit 1;
  
  if not found then
    raise exception 'Template not found for action: %', p_action_id;
  end if;

  select * into v_tenant from tenants where id = v_action.tenant_id;
  if not found then
    raise exception 'Tenant not found: %', v_action.tenant_id;
  end if;

  v_body := replace(v_template.body, '{{first_name}}', coalesce(v_lead.first_name, ''));

  return jsonb_build_object(
    'action_id', v_action.id,
    'first_name', v_lead.first_name,
    'subject', v_template.subject,
    'body', v_body,
    'alert_email_to', v_tenant.team_alert_email
  );
end;
$$;

-- 6. record_send_event (Fail loudly if action already completed, increment sender stats on success)
create or replace function record_send_event(
  p_action_id uuid,
  p_provider text,
  p_provider_id text,
  p_outcome text,
  p_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action actions;
  v_lead leads;
  v_event_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then raise exception 'action not found: %', p_action_id; end if;
  select * into v_lead from leads where id = v_action.lead_id;

  if v_action.status = 'completed' then
    raise exception 'action % already completed', p_action_id using errcode = 'unique_violation';
  end if;

  insert into events (
    tenant_id, lead_id, action_id, channel, direction,
    provider, provider_id, to_address, subject, body, raw_payload
  ) values (
    v_action.tenant_id, v_action.lead_id, v_action.id,
    v_action.action_type, 'outbound',
    p_provider, p_provider_id,
    case v_action.action_type
      when 'email' then v_lead.email
      when 'sms' then v_lead.phone_e164
      when 'call' then v_lead.phone_e164
      else null end,
    p_payload->>'subject',
    p_payload->>'body',
    p_payload
  ) returning id into v_event_id;

  update actions
    set status = case when p_outcome = 'failed' then 'failed' else 'completed' end,
        provider = p_provider,
        provider_id = p_provider_id,
        result = jsonb_build_object('outcome', p_outcome) || p_payload,
        completed_at = now()
    where id = p_action_id;

  update leads
    set last_action_at = now()
    where id = v_action.lead_id;

  if v_action.action_type = 'email' and p_outcome = 'sent' and v_lead.assigned_sender_id is not null then
    update senders
    set sent_today = sent_today + 1,
        total_sent = total_sent + 1,
        last_sent_at = now()
    where id = v_lead.assigned_sender_id;
  end if;

  return v_event_id;
end;
$$;
