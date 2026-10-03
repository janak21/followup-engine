-- Migration: Revert public RLS policies, add reset_daily_senders RPC, and enhance process_inbound_sms for opt-out credentials
-- Created at: 2026-06-13T00:00:00+05:30

-- 1. Drop public select / write policies
drop policy if exists "Allow public select on tenants" on tenants;
drop policy if exists "Allow public select on senders" on senders;
drop policy if exists "Allow public select on templates" on templates;
drop policy if exists "Allow public insert/update/delete on templates" on templates;
drop policy if exists "Allow public select on journeys" on journeys;
drop policy if exists "Allow public select on leads" on leads;
drop policy if exists "Allow public insert/update/delete on leads" on leads;
drop policy if exists "Allow public select on actions" on actions;
drop policy if exists "Allow public insert/update/delete on actions" on actions;
drop policy if exists "Allow public select on events" on events;

-- 2. Add reset_daily_senders RPC function
create or replace function reset_daily_senders()
returns void language plpgsql security definer set search_path = public as $$
begin
  update senders set sent_today = 0, last_reset_date = current_date;
end;
$$;

grant execute on function reset_daily_senders() to service_role;

-- 3. Redefine process_inbound_sms to return Twilio credentials on opt_out
create or replace function process_inbound_sms(
  p_from text,
  p_to text,
  p_body text,
  p_message_sid text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_lead leads;
  v_event_id uuid;
  v_max_ai_replies int := 5;
  v_history jsonb := '[]'::jsonb;
  v_credentials tenant_credentials;
  v_clean_body text := lower(trim(p_body));
begin
  -- 1. Resolve tenant_id
  v_tenant_id := resolve_tenant_by_phone(p_to);
  if v_tenant_id is null then
    -- Log event with fallback system tenant (tenant 1)
    insert into events (
      tenant_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload
    ) values (
      '00000000-0000-0000-0000-000000000001',
      'sms', 'inbound', 'twilio', p_message_sid, p_from, p_to, p_body,
      jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid)
    );
    return jsonb_build_object('status', 'unknown_tenant');
  end if;

  -- 2. Resolve lead
  select * into v_lead
  from leads
  where tenant_id = v_tenant_id
    and (phone_e164 = p_from or phone_e164 = '+' || p_from or phone_e164 = replace(p_from, '+', ''))
  order by created_at desc
  limit 1;

  if not found then
    -- Log event with null lead_id
    insert into events (
      tenant_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload
    ) values (
      v_tenant_id, 'sms', 'inbound', 'twilio', p_message_sid, p_from, p_to, p_body,
      jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid)
    );
    return jsonb_build_object('status', 'unknown_lead', 'tenant_id', v_tenant_id);
  end if;

  -- 3. Log inbound event
  insert into events (
    tenant_id, lead_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload
  ) values (
    v_tenant_id, v_lead.id, 'sms', 'inbound', 'twilio', p_message_sid, p_from, p_to, p_body,
    jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid)
  ) returning id into v_event_id;

  -- 4. Update lead metadata
  update leads
  set responded = true,
      last_action_at = now(),
      updated_at = now()
  where id = v_lead.id;

  -- 5. Opt-out check
  if v_clean_body in ('stop', 'unsubscribe', 'cancel', 'quit', 'end') then
    -- Mark lead opted out
    update leads
    set opt_out = true,
        journey_status = 'opted_out',
        opt_out_channel = 'sms',
        updated_at = now()
    where id = v_lead.id;

    -- Insert into suppressions
    insert into suppressions (
      tenant_id, channel, phone_e164, reason, source, lead_id, notes
    ) values (
      v_tenant_id, 'sms', v_lead.phone_e164, 'opt_out', 'inbound_sms', v_lead.id, 'User replied ' || p_body
    );

    -- Cancel pending actions
    update actions
    set status = 'cancelled'
    where lead_id = v_lead.id
      and status = 'pending';

    -- Fetch Twilio credentials for outbound confirmation SMS
    select * into v_credentials
    from tenant_credentials
    where tenant_id = v_tenant_id
      and provider = 'twilio'
      and active = true;

    return jsonb_build_object(
      'status', 'opt_out',
      'lead_id', v_lead.id,
      'tenant_id', v_tenant_id,
      'phone_to', v_lead.phone_e164,
      'twilio_credential_name', v_credentials.n8n_credential_name,
      'twilio_from_number', v_credentials.config->>'from_number'
    );
  end if;

  -- 6. Max AI replies check
  select coalesce((config->>'max_ai_replies')::int, 5) into v_max_ai_replies
  from tenants
  where id = v_tenant_id;

  if v_lead.sms_conversation_count >= v_max_ai_replies then
    -- Create team alert action
    insert into actions (
      tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload
    ) values (
      v_tenant_id, v_lead.id, 'team_alert', v_lead.current_step, now(), 'pending',
      v_lead.id::text || ':sms_max_replies_alert',
      jsonb_build_object('reason', 'max_ai_replies_exceeded', 'conversation_count', v_lead.sms_conversation_count)
    );

    return jsonb_build_object(
      'status', 'max_replies_exceeded',
      'lead_id', v_lead.id,
      'tenant_id', v_tenant_id
    );
  end if;

  -- 7. Increment conversation count
  update leads
  set sms_conversation_count = sms_conversation_count + 1
  where id = v_lead.id;

  -- 8. Fetch Twilio credentials
  select * into v_credentials
  from tenant_credentials
  where tenant_id = v_tenant_id
    and provider = 'twilio'
    and active = true;

  if not found then
    return jsonb_build_object(
      'status', 'credentials_missing',
      'lead_id', v_lead.id,
      'tenant_id', v_tenant_id
    );
  end if;

  -- 9. Fetch conversation history (last 10 SMS messages, oldest first)
  select json_agg(t) into v_history
  from (
    select case when direction = 'inbound' then 'user' else 'assistant' end as role,
           body as content
    from (
      select direction, body, created_at
      from events
      where lead_id = v_lead.id
        and channel = 'sms'
      order by created_at desc
      limit 10
    ) sub2
    order by created_at asc
  ) t;

  return jsonb_build_object(
    'status', 'success',
    'lead_id', v_lead.id,
    'tenant_id', v_tenant_id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'twilio_credential_name', v_credentials.n8n_credential_name,
    'twilio_from_number', v_credentials.config->>'from_number',
    'history', coalesce(v_history, '[]'::jsonb)
  );
end;
$$;

grant execute on function process_inbound_sms(text, text, text, text) to anon, authenticated, service_role;
