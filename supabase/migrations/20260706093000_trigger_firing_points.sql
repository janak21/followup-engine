-- Phase 3: trigger firing points.
--   1. leads DB triggers: lead_created (AFTER INSERT), tag_added (AFTER UPDATE
--      of custom_fields, fires once per newly-added tag).
--   2. Inbound processors: explicit fire_journey_triggers calls inside
--      process_inbound_sms and process_inbound_email, placed after the opt-out
--      branch (opt-out returns early) and before the AI-reply enqueue.

-- ============================================================================
-- (1a) lead_created: fires for every creation path (manual, CSV import,
--      webhook, create_lead_from_payload) via one AFTER INSERT trigger.
-- ============================================================================
create or replace function public.on_lead_created_fire_triggers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  begin
    perform public.fire_journey_triggers(
      new.tenant_id, new.id, 'lead_created',
      jsonb_build_object('source', coalesce(new.source, ''), 'lead_id', new.id)
    );
  exception when others then
    insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (new.tenant_id, 'trigger:lead_created', sqlerrm,
            jsonb_build_object('lead_id', new.id), 'error', 'open');
  end;
  return new;
end;
$$;

drop trigger if exists trg_leads_fire_created_triggers on public.leads;
create trigger trg_leads_fire_created_triggers
  after insert on public.leads
  for each row execute function public.on_lead_created_fire_triggers();

-- (1b) tag_added: diff old/new custom_fields->'tags' on update; fire once per
--      newly-added tag. Catches process_action_tag, dashboard PATCH, imports.
create or replace function public.on_lead_tags_changed_fire_triggers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old_tags jsonb := coalesce(old.custom_fields -> 'tags', '[]'::jsonb);
  v_new_tags jsonb := coalesce(new.custom_fields -> 'tags', '[]'::jsonb);
  v_tag text;
begin
  if v_new_tags = v_old_tags then
    return new;
  end if;
  for v_tag in
    select t from jsonb_array_elements_text(v_new_tags) t
    except
    select t from jsonb_array_elements_text(v_old_tags) t
  loop
    begin
      perform public.fire_journey_triggers(
        new.tenant_id, new.id, 'tag_added',
        jsonb_build_object('tag', v_tag, 'lead_id', new.id)
      );
    exception when others then
      insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
      values (new.tenant_id, 'trigger:tag_added', sqlerrm,
              jsonb_build_object('lead_id', new.id, 'tag', v_tag), 'error', 'open');
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_leads_fire_tag_triggers on public.leads;
create trigger trg_leads_fire_tag_triggers
  after update of custom_fields on public.leads
  for each row execute function public.on_lead_tags_changed_fire_triggers();

-- Grants for the two new trigger functions.
do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('on_lead_created_fire_triggers', 'on_lead_tags_changed_fire_triggers')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;

-- ============================================================================
-- (2a) process_inbound_sms: full replacement (base = deployed body reconciled
--      in Task 0). One insertion after the opt-out branch, before the AI
--      reply enqueue.
-- ============================================================================
create or replace function public.process_inbound_sms(
  p_from text,
  p_to text,
  p_body text,
  p_message_sid text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant_id uuid;
  v_lead leads%rowtype;
  v_event_id uuid;
  v_credentials tenant_credentials%rowtype;
  v_clean_body text := lower(trim(p_body));
  v_wait_reply_id uuid;
  v_is_opt_out boolean;
  v_history jsonb := '[]'::jsonb;
  -- AI-reply routing state
  v_tenant_ai_on bool;
  v_agent_id uuid;
  v_journey_agent_id uuid;
  v_agent ai_agents%rowtype;
  v_ai_action_id uuid;
  v_goal_run_ids uuid[];
begin
  v_tenant_id := resolve_tenant_by_phone(p_to);
  if v_tenant_id is null then
    insert into events (tenant_id, channel, direction, provider, provider_id,
                        from_address, to_address, body, raw_payload)
         values ('00000000-0000-0000-0000-000000000001', 'sms', 'inbound', 'twilio',
                 p_message_sid, p_from, p_to, p_body,
                 jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid));
    return jsonb_build_object('status','unknown_tenant');
  end if;

  select * into v_lead
    from leads
   where tenant_id = v_tenant_id
     and (phone_e164 = p_from or phone_e164 = '+' || p_from or phone_e164 = replace(p_from, '+', ''))
   order by created_at desc
   limit 1
   for update;

  if not found then
    insert into events (tenant_id, channel, direction, provider, provider_id,
                        from_address, to_address, body, raw_payload)
         values (v_tenant_id, 'sms', 'inbound', 'twilio', p_message_sid, p_from, p_to, p_body,
                 jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid));
    return jsonb_build_object('status','unknown_lead','tenant_id', v_tenant_id);
  end if;

  insert into events (tenant_id, lead_id, channel, direction, provider, provider_id,
                      from_address, to_address, body, raw_payload)
       values (v_tenant_id, v_lead.id, 'sms', 'inbound', 'twilio', p_message_sid, p_from, p_to, p_body,
               jsonb_build_object('From', p_from, 'To', p_to, 'Body', p_body, 'MessageSid', p_message_sid))
   returning id into v_event_id;

  update leads set responded=true, last_action_at=now(), updated_at=now() where id = v_lead.id;

  v_is_opt_out := v_clean_body in ('stop', 'unsubscribe', 'cancel', 'quit', 'end');

  if not v_is_opt_out then
    select array_agg(id) into v_goal_run_ids
      from public.journey_runs
     where lead_id = v_lead.id
       and status = 'running';

    perform cancel_pending_on_engagement(v_lead.id, 'sms_reply',
      'Inbound SMS from ' || p_from, null);

    perform public.apply_journey_goals(
      v_lead.id,
      v_goal_run_ids,
      'replied',
      jsonb_build_object(
        'channel', 'sms',
        'event_id', v_event_id,
        'provider_id', p_message_sid
      )
    );
  end if;

  update actions set status='completed'
   where action_type='wait_reply' and status='pending' and lead_id = v_lead.id
   returning id into v_wait_reply_id;
  if v_wait_reply_id is not null then perform advance_journey(v_wait_reply_id, 'replied'); end if;

  if v_is_opt_out then
    update leads set opt_out=true, journey_status='opted_out', opt_out_channel='sms', updated_at=now()
     where id = v_lead.id;
    perform add_suppression(v_tenant_id, 'sms', v_lead.phone_e164, 'opt_out',
                            v_lead.id, 'inbound_sms', 'User replied ' || p_body);
    update actions set status='cancelled' where lead_id = v_lead.id and status='pending';
    return jsonb_build_object('status','opt_out','lead_id', v_lead.id, 'tenant_id', v_tenant_id);
  end if;

  -- PHASE3: event-driven triggers (keyword journeys, reactivation on reply).
  begin
    perform public.fire_journey_triggers(
      v_tenant_id, v_lead.id, 'incoming_sms',
      jsonb_build_object('body', p_body, 'from', p_from, 'event_id', v_event_id)
    );
  exception when others then
    insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (v_tenant_id, 'trigger:incoming_sms', sqlerrm,
            jsonb_build_object('lead_id', v_lead.id), 'error', 'open');
  end;

  -- AI REPLY ENQUEUE (mirrors process_inbound_email).
  -- Journey override → tenant default. Skip on missing/disabled/cap-hit.
  select ai_replies_enabled into v_tenant_ai_on from tenants where id = v_tenant_id;
  if v_lead.journey_template is not null then
    select j.ai_agent_id into v_journey_agent_id
      from journeys j
     where j.tenant_id = v_tenant_id and j.journey_key = v_lead.journey_template and j.active = true
     order by j.version desc limit 1;
  end if;
  if v_journey_agent_id is not null then
    v_agent_id := v_journey_agent_id;
  else
    select default_ai_agent_id into v_agent_id from tenants where id = v_tenant_id;
  end if;

  if coalesce(v_tenant_ai_on, false) and v_agent_id is not null then
    select * into v_agent from ai_agents where id = v_agent_id and enabled = true;
    if v_agent.id is not null then
      if v_lead.sms_conversation_count >= v_agent.max_replies_per_lead then
        insert into actions (tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload)
             values (v_tenant_id, v_lead.id, 'team_alert', v_lead.current_step, now(), 'pending',
                     'ai_cap_alert_sms:' || v_event_id::text,
                     jsonb_build_object('reason','ai_max_replies_exceeded_sms',
                                        'agent_id', v_agent.id,
                                        'inbound_event_id', v_event_id,
                                        'conversation_count', v_lead.sms_conversation_count))
        on conflict (tenant_id, idempotency_key) do nothing;
      else
        insert into actions (tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload)
             values (v_tenant_id, v_lead.id, 'ai_reply', v_lead.current_step, now(), 'pending',
                     'ai_reply_sms:' || v_event_id::text,
                     jsonb_build_object('source','inbound_sms_reply',
                                        'channel','sms',
                                        'agent_id', v_agent.id,
                                        'inbound_event_id', v_event_id,
                                        'inbound_from', p_from,
                                        'inbound_to',   p_to))
        on conflict (tenant_id, idempotency_key) do nothing
        returning id into v_ai_action_id;
      end if;
    end if;
  end if;

  update leads set sms_conversation_count = sms_conversation_count + 1 where id = v_lead.id;

  select * into v_credentials from tenant_credentials
   where tenant_id = v_tenant_id and provider='twilio' and active=true;

  select json_agg(t) into v_history
    from (
      select case when direction='inbound' then 'user' else 'assistant' end as role, body as content
        from (
          select direction, body, created_at from events
           where lead_id = v_lead.id and channel='sms'
           order by created_at desc limit 10
        ) sub2 order by created_at asc
    ) t;

  return jsonb_build_object(
    'status','success',
    'lead_id', v_lead.id,
    'tenant_id', v_tenant_id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'ai_reply_enqueued', v_ai_action_id,
    'twilio_from_number', v_credentials.config->>'from_number',
    'history', coalesce(v_history, '[]'::jsonb)
  );
end;
$$;

-- ============================================================================
-- (2b) process_inbound_email: full replacement (base = deployed body
--      reconciled in Task 0). One insertion after the opt-out branch, before
--      the AI reply enqueue.
-- ============================================================================
create or replace function public.process_inbound_email(
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
set search_path to 'public'
as $$
declare
  v_tenant_id uuid;
  v_lead leads%rowtype;
  v_event_id uuid;
  v_history jsonb := '[]'::jsonb;
  v_sender senders%rowtype;
  v_wait_reply_id uuid;
  v_clean_body text := lower(trim(p_body));
  v_clean_subject text := lower(coalesce(p_subject,''));
  v_clean_from text := lower(coalesce(p_from_email,''));
  v_is_bounce bool := false;
  v_failed_addr text;
  v_smtp_code text;
  v_is_hard_bounce bool := false;
  v_original_event events%rowtype;
  v_orig_action actions%rowtype;
  v_canceled int;
  v_is_opt_out boolean;
  v_match_strategy text;
  v_agent ai_agents%rowtype;
  v_agent_id uuid;
  v_tenant_ai_on bool;
  v_journey_agent_id uuid;
  v_ai_action_id uuid;
  v_goal_run_ids uuid[];
begin
  select tenant_id into v_tenant_id
    from senders
   where lower(sender_email) = lower(p_to_email) and active = true
   limit 1;
  if v_tenant_id is null then
    v_tenant_id := '00000000-0000-0000-0000-000000000001';
  end if;

  v_is_bounce :=
       v_clean_from like '%mailer-daemon%'
    or v_clean_from like '%postmaster@%'
    or v_clean_from like 'bounce-%@%'
    or v_clean_subject like '%delivery status notification%'
    or v_clean_subject like '%undelivered mail%'
    or v_clean_subject like '%mail delivery failed%'
    or v_clean_subject like '%returned mail%';

  -- BOUNCE PATH (unchanged) --
  if v_is_bounce then
    v_failed_addr := (regexp_match(coalesce(p_body,''), 'X-Failed-Recipients:\s*([^\s,;]+)', 'i'))[1];
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), 'Final-Recipient:\s*[A-Za-z0-9-]+;\s*([^\s]+)', 'i'))[1];
    end if;
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), 'delivered\s+to\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})', 'i'))[1];
    end if;
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), '<([^<>\s]+@[^<>\s]+)>', 'i'))[1];
    end if;
    if v_failed_addr is null then
      v_failed_addr := (regexp_match(coalesce(p_body,''), '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})'))[1];
      if lower(coalesce(v_failed_addr,'')) = v_clean_from then v_failed_addr := null; end if;
    end if;

    v_smtp_code := (regexp_match(coalesce(p_body,''), '\y(5\d{2}|4\d{2})\y', 'i'))[1];
    v_is_hard_bounce := coalesce(v_smtp_code like '5%', false)
                     or v_clean_body like '%address not found%'
                     or v_clean_body like '%no such user%'
                     or v_clean_body like '%user unknown%'
                     or v_clean_body like '%mailbox unavailable%'
                     or v_clean_body like '%recipient address rejected%'
                     or v_clean_body like '%message blocked%';

    insert into events (tenant_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload)
         values (v_tenant_id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
                 jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id, 'bounce', true,
                                    'bounce_hard', v_is_hard_bounce, 'smtp_code', v_smtp_code,
                                    'failed_recipient', v_failed_addr));

    if v_failed_addr is null then
      insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
           values (v_tenant_id, 'email_bounce', 'Bounce detected but no recipient extracted',
                   jsonb_build_object('from', p_from_email, 'subject', p_subject, 'body_preview', left(p_body, 500)),
                   'warning', 'open');
      return jsonb_build_object('status','bounce_recorded_no_recipient', 'tenant_id', v_tenant_id);
    end if;

    select * into v_lead from leads where tenant_id = v_tenant_id and lower(email) = lower(v_failed_addr) order by created_at desc limit 1;
    select e.* into v_original_event from events e
      where e.tenant_id = v_tenant_id and e.channel='email' and e.direction='outbound' and e.provider='gmail'
        and lower(e.to_address) = lower(v_failed_addr) and e.created_at > now() - interval '72 hours'
      order by e.created_at desc limit 1;

    if v_original_event.action_id is not null then
      select * into v_orig_action from actions where id = v_original_event.action_id;
      if v_orig_action.id is not null and v_orig_action.status = 'completed' then
        update actions
           set status='failed',
               error_message = 'Email bounced. SMTP ' || coalesce(v_smtp_code, 'unknown') || ' from ' || coalesce(p_from_email,'') || '. Subject: ' || coalesce(p_subject,''),
               result = coalesce(result,'{}'::jsonb) || jsonb_build_object('bounce', true, 'bounce_hard', v_is_hard_bounce, 'smtp_code', v_smtp_code, 'bounce_event_id', p_message_id)
         where id = v_orig_action.id;
      end if;
    end if;

    perform add_suppression(v_tenant_id, 'email', v_failed_addr,
      case when v_is_hard_bounce then 'bounce_hard' else 'bounce_soft' end,
      v_lead.id, 'inbound_email_bounce',
      'SMTP ' || coalesce(v_smtp_code,'?') || ' — ' || left(coalesce(p_subject,''), 180));

    if v_lead.id is not null and v_is_hard_bounce then
      update leads set opt_out=true, opt_out_channel='email',
                       journey_status = case when journey_status='active' then 'opted_out' else journey_status end,
                       updated_at=now()
       where id = v_lead.id;
      update actions set status='cancelled', error_message='Cancelled: lead email hard-bounced'
       where lead_id = v_lead.id and status='pending';
      get diagnostics v_canceled = row_count;
    end if;

    insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
         values (v_tenant_id, 'email_bounce',
                 'Email bounced for ' || v_failed_addr || ' (' || (case when v_is_hard_bounce then 'hard' else 'soft' end) || ', SMTP ' || coalesce(v_smtp_code,'?') || ')',
                 jsonb_build_object('failed_recipient', v_failed_addr, 'lead_id', v_lead.id,
                                    'original_event_id', v_original_event.id, 'original_action_id', v_original_event.action_id,
                                    'smtp_code', v_smtp_code, 'hard', v_is_hard_bounce, 'subject', p_subject),
                 case when v_is_hard_bounce then 'error' else 'warning' end, 'open');

    return jsonb_build_object('status', case when v_is_hard_bounce then 'bounce_hard' else 'bounce_soft' end,
                              'tenant_id', v_tenant_id, 'failed_recipient', v_failed_addr,
                              'smtp_code', v_smtp_code, 'lead_id', v_lead.id,
                              'original_action_id', v_original_event.action_id, 'cancelled_pending', v_canceled);
  end if;

  -- NON-BOUNCE PATH --
  v_match_strategy := 'none';
  if p_thread_id is not null and length(p_thread_id) > 0 then
    select * into v_lead from leads
     where tenant_id = v_tenant_id and email_thread_id = p_thread_id
     order by last_action_at desc nulls last, created_at desc limit 1 for update;
    if found then v_match_strategy := 'thread'; end if;
  end if;
  if not found then
    select * into v_lead from leads
     where tenant_id = v_tenant_id and lower(email) = lower(p_from_email)
     order by created_at desc limit 1 for update;
    if found then v_match_strategy := 'from_address'; end if;
  end if;

  if not found then
    insert into events (tenant_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload)
         values (v_tenant_id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
                 jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id, 'match_strategy', 'unmatched'));
    return jsonb_build_object('status','unknown_lead','tenant_id', v_tenant_id);
  end if;

  insert into events (tenant_id, lead_id, channel, direction, provider, provider_id, from_address, to_address, body, raw_payload)
       values (v_tenant_id, v_lead.id, 'email', 'inbound', 'gmail', p_message_id, p_from_email, p_to_email, p_body,
               jsonb_build_object('subject', p_subject, 'thread_id', p_thread_id, 'match_strategy', v_match_strategy))
   returning id into v_event_id;

  update leads set responded=true, email_thread_id=p_thread_id, last_email_message_id=p_message_id,
                   last_action_at=now(), updated_at=now()
   where id = v_lead.id;

  v_is_opt_out := v_clean_body like '%stop%' or v_clean_body like '%unsubscribe%' or v_clean_body like '%cancel%';

  if not v_is_opt_out then
    select array_agg(id) into v_goal_run_ids
      from public.journey_runs
     where lead_id = v_lead.id
       and status = 'running';

    perform cancel_pending_on_engagement(v_lead.id, 'email_reply', 'Inbound email from ' || p_from_email, null);

    perform public.apply_journey_goals(
      v_lead.id,
      v_goal_run_ids,
      'replied',
      jsonb_build_object(
        'channel', 'email',
        'event_id', v_event_id,
        'message_id', p_message_id,
        'thread_id', p_thread_id
      )
    );
  end if;

  update actions set status='completed'
   where action_type='wait_reply' and status='pending' and lead_id = v_lead.id
   returning id into v_wait_reply_id;
  if v_wait_reply_id is not null then perform advance_journey(v_wait_reply_id, 'replied'); end if;

  if v_is_opt_out then
    update leads set opt_out=true, journey_status='opted_out', opt_out_channel='email', updated_at=now() where id = v_lead.id;
    perform add_suppression(v_tenant_id, 'email', v_lead.email, 'opt_out', v_lead.id, 'inbound_email',
                            'User replied STOP/UNSUBSCRIBE/CANCEL');
    update actions set status='cancelled' where lead_id = v_lead.id and status='pending';
    return jsonb_build_object('status','opt_out','lead_id', v_lead.id, 'tenant_id', v_tenant_id);
  end if;

  -- PHASE3: event-driven triggers.
  begin
    perform public.fire_journey_triggers(
      v_tenant_id, v_lead.id, 'email_replied',
      jsonb_build_object('subject', p_subject, 'body', p_body, 'from', p_from_email, 'event_id', v_event_id)
    );
  exception when others then
    insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (v_tenant_id, 'trigger:email_replied', sqlerrm,
            jsonb_build_object('lead_id', v_lead.id), 'error', 'open');
  end;

  -- AI REPLY ENQUEUE (Phase 2) --
  select ai_replies_enabled into v_tenant_ai_on from tenants where id = v_tenant_id;
  if v_lead.journey_template is not null then
    select j.ai_agent_id into v_journey_agent_id
      from journeys j
     where j.tenant_id = v_tenant_id and j.journey_key = v_lead.journey_template and j.active = true
     order by j.version desc limit 1;
  end if;
  if v_journey_agent_id is not null then
    v_agent_id := v_journey_agent_id;
  else
    select default_ai_agent_id into v_agent_id from tenants where id = v_tenant_id;
  end if;

  if coalesce(v_tenant_ai_on, false) and v_agent_id is not null then
    select * into v_agent from ai_agents where id = v_agent_id and enabled = true;
    if v_agent.id is not null then
      if v_lead.email_conversation_count >= v_agent.max_replies_per_lead then
        insert into actions (tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload)
             values (v_tenant_id, v_lead.id, 'team_alert', v_lead.current_step, now(), 'pending',
                     'ai_cap_alert:' || v_event_id::text,
                     jsonb_build_object('reason','ai_max_replies_exceeded',
                                        'agent_id', v_agent.id,
                                        'inbound_event_id', v_event_id,
                                        'conversation_count', v_lead.email_conversation_count))
        on conflict (tenant_id, idempotency_key) do nothing;
      else
        insert into actions (tenant_id, lead_id, action_type, step_index, run_at, status, idempotency_key, payload)
             values (v_tenant_id, v_lead.id, 'ai_reply', v_lead.current_step, now(), 'pending',
                     'ai_reply:' || v_event_id::text,
                     jsonb_build_object('source','inbound_email_reply',
                                        'agent_id', v_agent.id,
                                        'inbound_event_id', v_event_id,
                                        'inbound_from', p_from_email,
                                        'inbound_subject', p_subject,
                                        'inbound_thread_id', p_thread_id))
        on conflict (tenant_id, idempotency_key) do nothing
        returning id into v_ai_action_id;
      end if;
    end if;
  end if;

  update leads set email_conversation_count = email_conversation_count + 1 where id = v_lead.id;

  select json_agg(t) into v_history
    from (
      select case when direction='inbound' then 'user' else 'assistant' end as role, body as content
        from (
          select direction, body, created_at from events
           where lead_id = v_lead.id and channel = 'email'
           order by created_at desc limit 10
        ) sub2
       order by created_at asc
    ) t;

  select * into v_sender from senders where id = v_lead.assigned_sender_id;
  if v_sender.id is null then
    select * into v_sender from senders where tenant_id = v_tenant_id and active = true limit 1;
  end if;

  return jsonb_build_object(
    'status','success',
    'lead_id', v_lead.id,
    'tenant_id', v_tenant_id,
    'match_strategy', v_match_strategy,
    'ai_reply_enqueued', v_ai_action_id,
    'sender_id', v_sender.id,
    'sender_email', v_sender.sender_email,
    'sender_name', v_sender.sender_name,
    'history', coalesce(v_history, '[]'::jsonb)
  );
end;
$$;

-- Grants for the replaced inbound processors.
revoke execute on function public.process_inbound_sms(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.process_inbound_sms(text, text, text, text)
  to service_role;

revoke execute on function public.process_inbound_email(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.process_inbound_email(text, text, text, text, text, text)
  to service_role;