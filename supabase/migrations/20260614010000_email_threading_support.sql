-- Migration: Email threading support
-- get_email_payload returns lead's existing thread state.
-- record_send_event persists Gmail thread_id + message_id back onto the lead
-- so subsequent sends can use Gmail "Reply" and land in the same thread.
-- Created at: 2026-06-14T01:00:00Z

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

  begin
    v_body := render_template(v_template.body, v_lead);
  exception when undefined_function then
    v_body := replace(v_template.body, '{{first_name}}', coalesce(v_lead.first_name, ''));
  end;

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
    'sender_name', v_sender.sender_name,
    'email_thread_id', v_lead.email_thread_id,
    'last_email_message_id', v_lead.last_email_message_id,
    'has_thread', (v_lead.email_thread_id is not null and v_lead.last_email_message_id is not null)
  );
end;
$$;

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
  v_thread_id text := p_payload->>'thread_id';
  v_message_id text := p_payload->>'message_id';
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
    set last_action_at = now(),
        journey_status = case
          when journey_status = 'new' and p_outcome <> 'failed' then 'active'
          else journey_status
        end,
        email_thread_id = case
          when v_action.action_type = 'email' and p_outcome = 'sent' and v_thread_id is not null
            then v_thread_id
          else email_thread_id
        end,
        last_email_message_id = case
          when v_action.action_type = 'email' and p_outcome = 'sent' and v_message_id is not null
            then v_message_id
          else last_email_message_id
        end
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
