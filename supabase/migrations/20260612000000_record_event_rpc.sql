-- Migration: record_send_event RPC
-- Created at: 2026-06-12T09:50:40+05:30

create or replace function record_send_event(
  p_action_id uuid,
  p_provider text,
  p_provider_id text,
  p_outcome text,
  p_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_action actions;
  v_lead leads;
  v_event_id uuid;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then raise exception 'action not found: %', p_action_id; end if;
  select * into v_lead from leads where id = v_action.lead_id;

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

  return v_event_id;
end;
$$;
