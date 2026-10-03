-- Inline email composer support in get_email_payload:
--   1. Step-pinned sender: honor step_spec.sender_id when present — send from
--      that specific connected sender instead of the lead's assigned sender or
--      auto-selection. When absent, selection logic is unchanged.
--   2. From-name override: return step_spec.from_name (optional) so the
--      dispatcher can override the sender's display name in the From header.
--      The from ADDRESS still comes from the resolved/pinned sender (Gmail only
--      sends as the authenticated account).
--
-- Based on the Vault-routed definition (20260714092000). Refresh-token presence
-- is still checked via get_sender_secret(); response shape is preserved and
-- only extended (from_name added). Throttling/threading logic unchanged.

create or replace function public.get_email_payload(p_action_id uuid)
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
  v_body_html text;
  v_body_plain text;
  v_subject text;
  v_now timestamptz := now();
  v_next_eligible timestamptz;
  v_min_between interval;
  v_sender_is_usable bool;
  v_has_prior_thread bool;
  v_inline_subject text;
  v_inline_body text;
  v_inline_plain text;
  v_inline_format text;
  v_inline_to text;
  v_prior_subject text;
  v_resolved_to text;
  v_pinned_sender_id uuid;
  v_from_name text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return jsonb_build_object('outcome','failed','reason','Action not found'); end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then return jsonb_build_object('outcome','failed','reason','Lead not found'); end if;

  -- Inline priority: operator/AI inline reply > step-authored content > template.
  v_inline_subject := coalesce(
    nullif(v_action.payload->'inline'->>'subject', ''),
    nullif(v_action.payload->'step_spec'->>'inline_subject', '')
  );
  v_inline_body := coalesce(
    nullif(v_action.payload->'inline'->>'body', ''),
    nullif(v_action.payload->'step_spec'->>'inline_body', '')
  );
  v_inline_plain   := v_action.payload->'inline'->>'body_plain';
  v_inline_format  := v_action.payload->'inline'->>'body_format';
  v_inline_to      := v_action.payload->'inline'->>'to';

  -- Step-authored From-name override + pinned sender (inline composer).
  v_from_name := nullif(v_action.payload->'step_spec'->>'from_name', '');
  begin
    v_pinned_sender_id := nullif(v_action.payload->'step_spec'->>'sender_id', '')::uuid;
  exception when others then
    v_pinned_sender_id := null;
  end;

  if v_inline_body is null or v_inline_body = '' then
    select * into v_template
      from templates
     where tenant_id = v_action.tenant_id
       and template_key = v_action.template_key
     order by version desc
     limit 1;
    if not found then return jsonb_build_object('outcome','failed','reason','Template not found'); end if;
  end if;

  -- Step-pinned sender wins over the lead's assigned sender and auto-selection,
  -- but only when it is currently usable. If it isn't, fall back to the normal
  -- selection path below so sends don't hard-fail.
  if v_pinned_sender_id is not null then
    select * into v_sender
      from senders
     where id = v_pinned_sender_id
       and tenant_id = v_action.tenant_id
       and active = true
       and warmup_stage in ('warming','active')
       and (pause_until is null or pause_until < v_now)
       and public.get_sender_secret(id, 'google_refresh_token') is not null;
  end if;

  if v_sender.id is null and v_lead.assigned_sender_id is not null then
    select * into v_sender from senders where id = v_lead.assigned_sender_id;
    -- SECRET check: refresh token now lives in Vault.
    v_sender_is_usable :=
         v_sender.id is not null
     and v_sender.active = true
     and v_sender.warmup_stage in ('warming','active')
     and (v_sender.pause_until is null or v_sender.pause_until < v_now)
     and public.get_sender_secret(v_sender.id, 'google_refresh_token') is not null;

    if not v_sender_is_usable then
      select exists(select 1 from events where lead_id = v_lead.id and channel = 'email') into v_has_prior_thread;
      if v_has_prior_thread then
        return jsonb_build_object(
          'outcome','failed',
          'reason','Assigned sender ' || v_sender.sender_email ||
                   ' is no longer usable, but this lead has an existing email thread. ' ||
                   'Manually reassign or reconnect the sender to preserve thread continuity.'
        );
      end if;
      update leads set assigned_sender_id = null where id = v_lead.id;
      v_lead.assigned_sender_id := null;
      v_sender := null;
    end if;
  end if;

  if v_sender.id is null then
    -- SECRET filter: candidate senders must have a Vault refresh token.
    select * into v_sender
      from senders
     where tenant_id = v_action.tenant_id
       and active = true
       and warmup_stage in ('warming','active')
       and (pause_until is null or pause_until < v_now)
       and public.get_sender_secret(id, 'google_refresh_token') is not null
     order by last_sent_at nulls first
     limit 1;
  end if;
  if v_sender.id is null then
    return jsonb_build_object(
      'outcome','no_sender',
      'reason','No sender available. Connect Google for at least one active sender in Settings → Senders.'
    );
  end if;

  if v_sender.last_reset_date < current_date then
    update senders set sent_today = 0, last_reset_date = current_date
     where id = v_sender.id returning * into v_sender;
  end if;

  v_min_between := (v_sender.min_seconds_between_sends || ' seconds')::interval;

  if v_sender.pause_until is not null and v_sender.pause_until > v_now then
    return jsonb_build_object('outcome','throttled','reason','Sender paused until ' || v_sender.pause_until::text,
      'next_eligible_at', v_sender.pause_until, 'sender_id', v_sender.id, 'sender_email', v_sender.sender_email);
  end if;
  if v_sender.sent_today >= v_sender.daily_limit then
    v_next_eligible := (current_date + interval '1 day') + interval '1 minute';
    return jsonb_build_object('outcome','throttled',
      'reason','Daily limit reached: ' || v_sender.sent_today || '/' || v_sender.daily_limit || ' for ' || v_sender.sender_email,
      'next_eligible_at', v_next_eligible, 'sender_id', v_sender.id, 'sender_email', v_sender.sender_email);
  end if;
  if v_sender.last_sent_at is not null and v_sender.last_sent_at + v_min_between > v_now then
    v_next_eligible := v_sender.last_sent_at + v_min_between;
    return jsonb_build_object('outcome','throttled','reason','Cooldown: min_seconds_between_sends=' || v_sender.min_seconds_between_sends,
      'next_eligible_at', v_next_eligible, 'sender_id', v_sender.id, 'sender_email', v_sender.sender_email);
  end if;

  if v_lead.assigned_sender_id is null or v_lead.assigned_sender_id != v_sender.id then
    update leads set assigned_sender_id = v_sender.id where id = v_lead.id;
  end if;

  if v_inline_body is not null and v_inline_body <> '' then
    if (v_inline_subject is null or trim(v_inline_subject) = '' or v_inline_subject ~ '^\s*[Rr][Ee]:\s*$')
       and v_lead.email_thread_id is not null and (v_inline_to is null or v_inline_to = '') then
      -- Only auto-thread when we're actually replying to the lead. Team-
      -- alert-style overrides skip the thread lookup.
      select subject into v_prior_subject
        from events
       where lead_id = v_lead.id
         and channel = 'email'
         and direction = 'outbound'
         and subject is not null
         and length(trim(subject)) > 0
         and raw_payload->>'thread_id' = v_lead.email_thread_id
       order by created_at desc
       limit 1;
      if v_prior_subject is not null then
        v_inline_subject := v_prior_subject;
      end if;
    end if;

    begin
      v_subject := render_template(coalesce(v_inline_subject, ''), v_lead);
    exception when undefined_function then
      v_subject := replace(coalesce(v_inline_subject,''), '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    begin
      v_body_html := render_template(v_inline_body, v_lead);
    exception when undefined_function then
      v_body_html := replace(v_inline_body, '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    if v_inline_plain is not null and v_inline_plain <> '' then
      begin
        v_body_plain := render_template(v_inline_plain, v_lead);
      exception when undefined_function then
        v_body_plain := replace(v_inline_plain, '{{first_name}}', coalesce(v_lead.first_name,''));
      end;
    end if;
  else
    begin
      v_subject := render_template(v_template.subject, v_lead);
    exception when undefined_function then
      v_subject := replace(coalesce(v_template.subject,''), '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    begin
      v_body_html := render_template(v_template.body, v_lead);
    exception when undefined_function then
      v_body_html := replace(coalesce(v_template.body,''), '{{first_name}}', coalesce(v_lead.first_name,''));
    end;
    if v_template.body_plain is not null and length(v_template.body_plain) > 0 then
      begin
        v_body_plain := render_template(v_template.body_plain, v_lead);
      exception when undefined_function then
        v_body_plain := replace(v_template.body_plain, '{{first_name}}', coalesce(v_lead.first_name,''));
      end;
    end if;
  end if;

  -- Recipient resolution: inline.to override (team_alert routing) beats lead.email.
  v_resolved_to := coalesce(nullif(trim(coalesce(v_inline_to, '')), ''), v_lead.email);

  return jsonb_build_object(
    'outcome','success',
    'action_id', v_action.id,
    'provider_id', v_action.provider_id,
    'email_to', v_resolved_to,
    'first_name', v_lead.first_name,
    'subject', v_subject,
    'body', v_body_html,
    'body_html', v_body_html,
    'body_plain', v_body_plain,
    'body_format', coalesce(v_inline_format, v_template.body_format, 'both'),
    'gmail_credential_id', '',
    'gmail_credential_name', v_sender.n8n_credential_name,
    'sender_id', v_sender.id,
    'sender_email', v_sender.sender_email,
    'sender_name', v_sender.sender_name,
    -- Optional per-step From display-name override (address stays the sender's).
    'from_name', v_from_name,
    -- When routing to a team address we don't want Gmail to fold this into
    -- the lead's existing thread — that would leak internal alerts into the
    -- customer conversation. Zero the thread hints if there's a to-override.
    'email_thread_id', case when v_inline_to is not null and v_inline_to <> '' then null else v_lead.email_thread_id end,
    'last_email_message_id', case when v_inline_to is not null and v_inline_to <> '' then null else v_lead.last_email_message_id end,
    'has_thread', case
      when v_inline_to is not null and v_inline_to <> '' then false
      else (v_lead.email_thread_id is not null and v_lead.last_email_message_id is not null)
    end
  );
end;
$$;

revoke execute on function public.get_email_payload(uuid) from public, anon, authenticated;
grant execute on function public.get_email_payload(uuid) to service_role;
