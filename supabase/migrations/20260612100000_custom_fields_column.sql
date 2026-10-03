-- Migration: Add custom_fields column to leads and implement dynamic template rendering function
-- Created at: 2026-06-12T13:58:00+05:30

-- 1. Add custom_fields column to leads
alter table leads add column if not exists custom_fields jsonb not null default '{}'::jsonb;

-- 2. Implement render_template helper function
create or replace function render_template(p_body text, p_lead leads)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res text := p_body;
  v_key text;
  v_val text;
begin
  if v_res is null then
    return null;
  end if;

  -- 1. Replace standard columns
  v_res := replace(v_res, '{{first_name}}', coalesce(p_lead.first_name, ''));
  v_res := replace(v_res, '{{last_name}}', coalesce(p_lead.last_name, ''));
  v_res := replace(v_res, '{{email}}', coalesce(p_lead.email, ''));
  v_res := replace(v_res, '{{phone_raw}}', coalesce(p_lead.phone_raw, ''));
  v_res := replace(v_res, '{{phone_e164}}', coalesce(p_lead.phone_e164, ''));
  v_res := replace(v_res, '{{campaign_type}}', coalesce(p_lead.campaign_type, ''));
  v_res := replace(v_res, '{{source}}', coalesce(p_lead.source, ''));
  v_res := replace(v_res, '{{zip_code}}', coalesce(p_lead.zip_code, ''));
  v_res := replace(v_res, '{{address}}', coalesce(p_lead.address_line1, ''));

  -- 2. Replace custom fields from the JSONB
  if p_lead.custom_fields is not null then
    for v_key, v_val in select * from jsonb_each_text(p_lead.custom_fields) loop
      v_res := replace(v_res, '{{' || v_key || '}}', coalesce(v_val, ''));
    end loop;
  end if;

  return v_res;
end;
$$;

-- 3. Redefine get_email_payload to use render_template
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

  -- Select active sender (assigned sender first, then pool)
  if v_lead.assigned_sender_id is not null then
    select * into v_sender from senders where id = v_lead.assigned_sender_id and active = true;
  end if;

  if v_sender.id is null then
    select * into v_sender from senders 
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

  -- Use render_template
  v_body := render_template(v_template.body, v_lead);

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

-- 4. Redefine get_sms_payload to use render_template
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

  -- Use render_template
  v_body := render_template(v_template.body, v_lead);

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

-- 5. Redefine get_alert_payload to use render_template
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

  -- Use render_template
  v_body := render_template(v_template.body, v_lead);

  return jsonb_build_object(
    'action_id', v_action.id,
    'first_name', v_lead.first_name,
    'subject', v_template.subject,
    'body', v_body,
    'alert_email_to', v_tenant.team_alert_email
  );
end;
$$;
