-- Advance email/SMS journeys after the provider accepts an outbound send.
--
-- Gmail and Twilio dispatch Edge Functions already call record_send_event only
-- after the provider returns a successful accepted/sent response. Keeping the
-- advance here gives both channels one idempotent completion path without
-- duplicating journey logic in provider-specific functions.

CREATE OR REPLACE FUNCTION public.record_send_event(p_action_id uuid, p_provider text, p_provider_id text, p_outcome text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action actions;
  v_lead leads;
  v_event_id uuid;
  v_thread_id text  := p_payload->>'thread_id';
  v_message_id text := p_payload->>'message_id';
begin
  select * into v_action from actions where id = p_action_id;
  if not found then raise exception 'action not found: %', p_action_id; end if;
  select * into v_lead from leads where id = v_action.lead_id;

  if v_action.status = 'completed' then
    select id into v_event_id
      from events
     where action_id = p_action_id and direction = 'outbound'
     order by created_at limit 1;

    -- A duplicate success callback should not create another event, but it may
    -- safely repair a previously completed email/SMS action that missed
    -- advancement. advance_journey atomically no-ops after the first advance.
    if v_action.action_type in ('email', 'sms') and p_outcome = 'sent' then
      begin
        perform public.advance_journey(p_action_id, 'sent');
      exception when others then
        insert into public.error_logs (
          tenant_id, workflow_name, error_message, raw_error, severity, status
        ) values (
          v_action.tenant_id,
          'record_send_event:advance_journey',
          'Failed to advance completed outbound ' || v_action.action_type || ' action after send event',
          jsonb_build_object(
            'action_id', p_action_id,
            'provider', p_provider,
            'provider_id', p_provider_id,
            'outcome', p_outcome,
            'sqlstate', sqlstate,
            'error', sqlerrm
          ),
          'error',
          'open'
        );
      end;
    end if;

    return v_event_id;
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
      when 'sms'   then v_lead.phone_e164
      when 'call'  then v_lead.phone_e164
      else null end,
    p_payload->>'subject',
    p_payload->>'body',
    p_payload
  ) returning id into v_event_id;

  update actions
     set status       = case when p_outcome = 'failed' then 'failed' else 'completed' end,
         provider     = p_provider,
         provider_id  = p_provider_id,
         result       = jsonb_build_object('outcome', p_outcome) || p_payload,
         completed_at = now(),
         error_message = case
           when p_outcome = 'failed'
             then coalesce(p_payload->>'error_message', error_message)
           else null
         end,
         locked_until = null,
         locked_by    = null
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

  -- Failed sends are handled by mark_action_failed and do not advance. Throttle
  -- reschedules do not call record_send_event. Provider-accepted email/SMS
  -- sends use the shared 'sent' journey outcome.
  if v_action.action_type in ('email', 'sms') and p_outcome = 'sent' then
    begin
      perform public.advance_journey(p_action_id, 'sent');
    exception when others then
      insert into public.error_logs (
        tenant_id, workflow_name, error_message, raw_error, severity, status
      ) values (
        v_action.tenant_id,
        'record_send_event:advance_journey',
        'Failed to advance outbound ' || v_action.action_type || ' action after send event',
        jsonb_build_object(
          'action_id', p_action_id,
          'event_id', v_event_id,
          'provider', p_provider,
          'provider_id', p_provider_id,
          'outcome', p_outcome,
          'sqlstate', sqlstate,
          'error', sqlerrm
        ),
        'error',
        'open'
      );
    end;
  end if;

  return v_event_id;
end;
$function$;
