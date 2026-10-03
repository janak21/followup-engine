-- Twilio post-send delivery status. Adds:
--   * events.delivery_status / delivery_error_code / delivery_error_message
--   * update_sms_delivery_status(sid, status, error_code, error_message, raw)
--     RPC. Idempotent. On terminal failure (undelivered|failed) flips the
--     corresponding action to 'failed' and writes an error_logs row.
-- Paired with /functions/v1/twilio-status edge function which parses
-- Twilio's form-encoded StatusCallback and invokes this RPC.
--
-- Full bodies in deployed Postgres; this file is the canonical mirror.

alter table events
  add column if not exists delivery_status        text,
  add column if not exists delivery_error_code    text,
  add column if not exists delivery_error_message text;

create index if not exists events_delivery_status_idx
  on events(provider, provider_id)
  where channel = 'sms';

create or replace function update_sms_delivery_status(
  p_sid           text,
  p_status        text,
  p_error_code    text default null,
  p_error_message text default null,
  p_raw           jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event   events%rowtype;
  v_action  actions%rowtype;
  v_terminal_failure boolean;
  v_status text := lower(coalesce(p_status, ''));
begin
  if p_sid is null or p_sid = '' then
    return jsonb_build_object('status','error','reason','missing_sid');
  end if;

  select * into v_event
    from events
   where provider='twilio' and provider_id=p_sid and channel='sms'
   order by created_at desc limit 1;
  if not found then
    return jsonb_build_object('status','no_matching_event','sid',p_sid);
  end if;

  if v_event.delivery_status = v_status then
    return jsonb_build_object('status','noop','sid',p_sid,'delivery_status',v_status);
  end if;

  update events
     set delivery_status        = v_status,
         delivery_error_code    = nullif(coalesce(p_error_code,''), ''),
         delivery_error_message = nullif(coalesce(p_error_message,''), ''),
         raw_payload            = coalesce(raw_payload, '{}'::jsonb) || p_raw
   where id = v_event.id;

  v_terminal_failure := v_status in ('failed','undelivered');

  if v_terminal_failure and v_event.action_id is not null then
    select * into v_action from actions where id = v_event.action_id;
    if v_action.status = 'completed' then
      update actions
         set status = 'failed',
             error_message = coalesce(p_error_message, 'Twilio: ' || v_status || coalesce(' (code '||p_error_code||')','')),
             result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                        'delivery_status',        v_status,
                        'delivery_error_code',    p_error_code,
                        'delivery_error_message', p_error_message)
       where id = v_action.id;
    end if;

    insert into error_logs (
      tenant_id, workflow_name, error_message, raw_error, severity, status
    ) values (
      v_event.tenant_id, 'twilio_status_callback',
      'SMS ' || v_status || ' for ' || p_sid || coalesce(' (' || p_error_code || ')', ''),
      jsonb_build_object('sid', p_sid, 'status', v_status, 'error_code', p_error_code,
                         'error_message', p_error_message, 'lead_id', v_event.lead_id,
                         'action_id', v_event.action_id),
      'warning', 'open'
    );
  end if;

  return jsonb_build_object(
    'status','success', 'sid', p_sid, 'delivery_status', v_status,
    'lead_id', v_event.lead_id, 'action_id', v_event.action_id,
    'flipped_action_to_failed', v_terminal_failure
  );
end;
$$;

grant execute on function update_sms_delivery_status(text, text, text, text, jsonb) to anon, authenticated, service_role;
