-- Migration: Fix node handlers by removing non-existent updated_at column updates on actions table
-- Created at: 2026-06-12T22:42:00+05:30

-- 1. Redefine process_inbound_sms
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
  v_pending_wait_reply_id uuid;
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

  -- 4.b Check for pending wait_reply action for this lead
  select id into v_pending_wait_reply_id
    from actions
   where lead_id = v_lead.id
     and action_type = 'wait_reply'
     and status = 'pending'
   limit 1;
   
  if found then
    -- Mark wait_reply as completed and advance journey with 'replied' outcome
    update actions set status = 'completed' where id = v_pending_wait_reply_id;
    perform advance_journey(v_pending_wait_reply_id, 'replied');
  end if;

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

    return jsonb_build_object(
      'status', 'opt_out',
      'lead_id', v_lead.id,
      'tenant_id', v_tenant_id
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


-- 2. execute_update_lead RPC
create or replace function execute_update_lead(
  p_action_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_action actions;
  v_lead leads;
  v_step_spec jsonb;
  v_field text;
  v_value text;
  v_new_action_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('status', 'error', 'message', 'action_not_found');
  end if;
  
  select * into v_lead from leads where id = v_action.lead_id;
  
  -- Extract payload configurations
  v_step_spec := v_action.payload -> 'step_spec';
  v_field := trim(lower(v_step_spec ->> 'update_field'));
  v_value := v_step_spec ->> 'update_value';
  
  if v_field is not null and v_field <> '' then
    -- Check if it matches a native column
    if v_field = 'first_name' then
      update leads set first_name = v_value where id = v_lead.id;
    elsif v_field = 'last_name' then
      update leads set last_name = v_value where id = v_lead.id;
    elsif v_field = 'email' then
      update leads set email = v_value where id = v_lead.id;
    elsif v_field = 'timezone' then
      update leads set timezone = v_value where id = v_lead.id;
    elsif v_field = 'journey_status' then
      update leads set journey_status = v_value where id = v_lead.id;
    elsif v_field = 'responded' then
      update leads set responded = lower(v_value)::boolean where id = v_lead.id;
    elsif v_field = 'callback_requested' then
      update leads set callback_requested = lower(v_value)::boolean where id = v_lead.id;
    else
      -- Update custom_fields jsonb
      update leads
         set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), array[v_field], to_jsonb(v_value)),
             updated_at = now()
       where id = v_lead.id;
    end if;
  end if;
  
  -- Log event
  insert into events (
    tenant_id, lead_id, channel, direction, provider, provider_id, body
  ) values (
    v_action.tenant_id, v_lead.id, 'system', 'outbound', 'system', p_action_id::text,
    'Updated lead property: ' || v_field || ' to ' || coalesce(v_value, 'NULL')
  );
  
  -- Mark action completed
  update actions set status = 'completed' where id = p_action_id;
  
  -- Advance journey with default outcome
  v_new_action_id := advance_journey(p_action_id, 'default');
  
  return jsonb_build_object('status', 'success', 'next_action_id', v_new_action_id);
end;
$$;


-- 3. execute_add_tag RPC
create or replace function execute_add_tag(
  p_action_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_action actions;
  v_lead leads;
  v_step_spec jsonb;
  v_tag_name text;
  v_tags jsonb;
  v_new_action_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('status', 'error', 'message', 'action_not_found');
  end if;
  
  select * into v_lead from leads where id = v_action.lead_id;
  
  v_step_spec := v_action.payload -> 'step_spec';
  v_tag_name := trim(v_step_spec ->> 'tag_name');
  
  if v_tag_name is not null and v_tag_name <> '' then
    -- Get current tags array
    v_tags := coalesce(v_lead.custom_fields -> 'tags', '[]'::jsonb);
    if not jsonb_exists(v_tags, v_tag_name) then
      v_tags := v_tags || jsonb_build_array(v_tag_name);
      update leads
         set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), '{tags}', v_tags),
             updated_at = now()
       where id = v_lead.id;
    end if;
  end if;
  
  -- Log event
  insert into events (
    tenant_id, lead_id, channel, direction, provider, provider_id, body
  ) values (
    v_action.tenant_id, v_lead.id, 'system', 'outbound', 'system', p_action_id::text,
    'Added tag: ' || coalesce(v_tag_name, 'NULL')
  );
  
  -- Mark action completed
  update actions set status = 'completed' where id = p_action_id;
  
  -- Advance journey with default outcome
  v_new_action_id := advance_journey(p_action_id, 'default');
  
  return jsonb_build_object('status', 'success', 'next_action_id', v_new_action_id);
end;
$$;


-- 4. execute_remove_tag RPC
create or replace function execute_remove_tag(
  p_action_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_action actions;
  v_lead leads;
  v_step_spec jsonb;
  v_tag_name text;
  v_tags jsonb;
  v_new_tags jsonb;
  v_new_action_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('status', 'error', 'message', 'action_not_found');
  end if;
  
  select * into v_lead from leads where id = v_action.lead_id;
  
  v_step_spec := v_action.payload -> 'step_spec';
  v_tag_name := trim(v_step_spec ->> 'tag_name');
  
  if v_tag_name is not null and v_tag_name <> '' then
    v_tags := coalesce(v_lead.custom_fields -> 'tags', '[]'::jsonb);
    if jsonb_exists(v_tags, v_tag_name) then
      -- Filter out the tag
      select json_agg(val)::jsonb into v_new_tags
        from jsonb_array_elements(v_tags) val
       where val ->> 0 <> v_tag_name;
       
      v_new_tags := coalesce(v_new_tags, '[]'::jsonb);
      
      update leads
         set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), '{tags}', v_new_tags),
             updated_at = now()
       where id = v_lead.id;
    end if;
  end if;
  
  -- Log event
  insert into events (
    tenant_id, lead_id, channel, direction, provider, provider_id, body
  ) values (
    v_action.tenant_id, v_lead.id, 'system', 'outbound', 'system', p_action_id::text,
    'Removed tag: ' || coalesce(v_tag_name, 'NULL')
  );
  
  -- Mark action completed
  update actions set status = 'completed' where id = p_action_id;
  
  -- Advance journey with default outcome
  v_new_action_id := advance_journey(p_action_id, 'default');
  
  return jsonb_build_object('status', 'success', 'next_action_id', v_new_action_id);
end;
$$;


-- 5. save_http_response RPC
create or replace function save_http_response(
  p_action_id uuid,
  p_status_code int,
  p_response_body jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_action actions;
  v_lead leads;
  v_step_spec jsonb;
  v_response_var text;
  v_new_action_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then
    return jsonb_build_object('status', 'error', 'message', 'action_not_found');
  end if;
  
  select * into v_lead from leads where id = v_action.lead_id;
  
  v_step_spec := v_action.payload -> 'step_spec';
  v_response_var := trim(v_step_spec ->> 'response_var');
  
  if v_response_var is not null and v_response_var <> '' then
    update leads
       set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), array[v_response_var], p_response_body),
           updated_at = now()
     where id = v_lead.id;
  end if;
  
  -- Log event
  insert into events (
    tenant_id, lead_id, channel, direction, provider, provider_id, body, raw_payload
  ) values (
    v_action.tenant_id, v_lead.id, 'http', 'outbound', 'n8n', p_action_id::text,
    'Executed HTTP request: ' || (v_step_spec ->> 'http_method') || ' ' || (v_step_spec ->> 'http_url') || ' (Status: ' || p_status_code || ')',
    jsonb_build_object('status_code', p_status_code, 'body', p_response_body)
  );
  
  -- Mark action completed
  update actions set status = 'completed' where id = p_action_id;
  
  -- Advance journey with default outcome
  v_new_action_id := advance_journey(p_action_id, 'default');
  
  return jsonb_build_object('status', 'success', 'next_action_id', v_new_action_id);
end;
$$;


-- 6. process_inbound_email RPC
create or replace function process_inbound_email(
  p_from_email text,
  p_to_email text,
  p_subject text,
  p_body text,
  p_message_id text,
  p_thread_id text
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
  v_sender senders;
  v_pending_wait_reply_id uuid;
  v_clean_body text := lower(trim(p_body));
begin
  -- 1. Resolve tenant_id by matching receiving email to a sender in senders table
  select tenant_id, id into v_tenant_id, v_sender.id
    from senders
   where lower(sender_email) = lower(p_to_email)
     and active = true
   limit 1;
   
  if v_tenant_id is null then
    -- Fallback: resolve tenant 1
    v_tenant_id := '00000000-0000-0000-0000-000000000001';
  end if;

  -- 2. Resolve lead by email matching
  select * into v_lead
    from leads
   where tenant_id = v_tenant_id
     and lower(email) = lower(p_from_email)
   order by created_at desc
   limit 1;

  if not found then
    -- Log event with null lead_id
    insert into events (
      tenant_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload
    ) values (
      v_tenant_id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
      jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id)
    );
    return jsonb_build_object('status', 'unknown_lead', 'tenant_id', v_tenant_id);
  end if;

  -- 3. Log inbound event
  insert into events (
    tenant_id, lead_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload
  ) values (
    v_tenant_id, v_lead.id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
    jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id)
  ) returning id into v_event_id;

  -- 4. Update lead metadata
  update leads
     set responded = true,
         email_thread_id = p_thread_id,
         last_email_message_id = p_message_id,
         last_action_at = now(),
         updated_at = now()
   where id = v_lead.id;

  -- 4.b Check for pending wait_reply action
  select id into v_pending_wait_reply_id
    from actions
   where lead_id = v_lead.id
     and action_type = 'wait_reply'
     and status = 'pending'
   limit 1;
   
  if found then
    update actions set status = 'completed' where id = v_pending_wait_reply_id;
    perform advance_journey(v_pending_wait_reply_id, 'replied');
  end if;

  -- 5. Opt-out check
  if v_clean_body like '%stop%' or v_clean_body like '%unsubscribe%' or v_clean_body like '%cancel%' then
    update leads
       set opt_out = true,
           journey_status = 'opted_out',
           opt_out_channel = 'email',
           updated_at = now()
     where id = v_lead.id;

    insert into suppressions (
      tenant_id, channel, email, reason, source, lead_id, notes
    ) values (
      v_tenant_id, 'email', v_lead.email, 'opt_out', 'inbound_email', v_lead.id, 'User replied ' || p_body
    );

    update actions
       set status = 'cancelled'
     where id = v_pending_wait_reply_id;

    return jsonb_build_object(
      'status', 'opt_out',
      'lead_id', v_lead.id,
      'tenant_id', v_tenant_id
    );
  end if;

  -- 6. Max AI replies check
  select coalesce((config->>'max_ai_replies')::int, 5) into v_max_ai_replies
    from tenants
   where id = v_tenant_id;

  if v_lead.email_conversation_count >= v_max_ai_replies then
    insert into actions (
      tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload
    ) values (
      v_tenant_id, v_lead.id, 'team_alert', v_lead.current_step, now(), 'pending',
      v_lead.id::text || ':email_max_replies_alert',
      jsonb_build_object('reason', 'max_ai_replies_exceeded', 'conversation_count', v_lead.email_conversation_count)
    );

    return jsonb_build_object(
      'status', 'max_replies_exceeded',
      'lead_id', v_lead.id,
      'tenant_id', v_tenant_id
    );
  end if;

  -- 7. Increment conversation count
  update leads
     set email_conversation_count = email_conversation_count + 1
   where id = v_lead.id;

  -- 8. Fetch thread history (last 10 emails)
  select json_agg(t) into v_history
    from (
      select case when direction = 'inbound' then 'user' else 'assistant' end as role,
             body as content
        from (
          select direction, body, created_at
            from events
           where lead_id = v_lead.id
             and channel = 'email'
           order by created_at desc
           limit 10
        ) sub2
       order by created_at asc
    ) t;

  -- Fetch sender
  select * into v_sender from senders where id = v_lead.assigned_sender_id;
  if v_sender.id is null then
    select * into v_sender from senders where tenant_id = v_tenant_id and active = true limit 1;
  end if;

  return jsonb_build_object(
    'status', 'success',
    'lead_id', v_lead.id,
    'tenant_id', v_tenant_id,
    'sender_id', v_sender.id,
    'sender_email', v_sender.sender_email,
    'sender_name', v_sender.sender_name,
    'n8n_credential_name', v_sender.n8n_credential_name,
    'history', coalesce(v_history, '[]'::jsonb)
  );
end;
$$;
