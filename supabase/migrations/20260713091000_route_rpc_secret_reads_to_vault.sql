-- Stage 4 (pre-data-migration): route every deployed SQL RPC that reads a
-- plaintext secret from tenant_credentials.config through get_tenant_secret().
--
-- Affected RPCs:
--   1. resolve_twilio_credentials(text)         — read by twilio-inbound/twilio-status
--   2. resolve_twilio_creds_for_sid(text)       — read by twilio-status-poll
--   3. resolve_retell_credentials(text, text)   — read by retell-result
--   4. get_sms_send_payload(uuid)               — read by dispatch payloads
--
-- For each: SECRETS (auth_token, api_key) are now read via get_tenant_secret,
-- while NON-SECRET keys (account_sid, from_number, agent_id) STAY in config.
-- Same response shape — the callers don't need to change.

create or replace function public.resolve_twilio_credentials(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creds     tenant_credentials;
  v_auth_token text;
begin
  select *
    into v_creds
    from tenant_credentials
   where provider = 'twilio'
     and active = true
     and (config->>'from_number' = p_phone
          or config->>'from_number' = replace(p_phone, '+', ''))
   limit 1;

  if not found then
    return null;
  end if;

  v_auth_token := public.get_tenant_secret(v_creds.tenant_id, 'twilio', 'auth_token');

  return jsonb_build_object(
    'tenant_id',   v_creds.tenant_id,
    'account_sid', v_creds.config->>'account_sid',
    'auth_token',  v_auth_token
  );
end;
$$;

create or replace function public.resolve_twilio_creds_for_sid(p_sid text)
returns table(tenant_id uuid, account_sid text, auth_token text, from_number text, has_creds boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant     uuid;
  v_creds      tenant_credentials;
  v_auth_token text;
begin
  select e.tenant_id into v_tenant
    from events e
   where e.provider = 'twilio' and e.provider_id = p_sid
   limit 1;

  if v_tenant is null then
    return query select null::uuid, null::text, null::text, null::text, false;
    return;
  end if;

  select tc.* into v_creds
    from tenant_credentials tc
   where tc.tenant_id = v_tenant
     and tc.provider  = 'twilio'
     and tc.active    = true;

  if not found then
    return query select v_tenant, null::text, null::text, null::text, false;
    return;
  end if;

  v_auth_token := public.get_tenant_secret(v_tenant, 'twilio', 'auth_token');

  return query select
    v_tenant,
    v_creds.config ->> 'account_sid',
    v_auth_token,
    v_creds.config ->> 'from_number',
    (v_creds.config ->> 'account_sid') is not null
      and v_auth_token is not null;
end;
$$;

create or replace function public.resolve_retell_credentials(
  p_agent_id text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_api_key   text;
begin
  -- 1. Resolve by agent_id (Retell webhooks always carry call.agent_id).
  if p_agent_id is not null and p_agent_id <> '' then
    select ra.tenant_id into v_tenant_id
      from retell_agents ra
     where ra.agent_id = p_agent_id
     limit 1;
  end if;

  -- 2. Resolve by phone number against tenant_credentials.config.from_number.
  if v_tenant_id is null and p_phone is not null and p_phone <> '' then
    select c.tenant_id into v_tenant_id
      from tenant_credentials c
     where c.provider = 'retell'
       and c.active = true
       and (c.config->>'from_number' = p_phone
            or c.config->>'from_number' = replace(p_phone, '+', ''))
     limit 1;
  end if;

  if v_tenant_id is null then
    return null;
  end if;

  -- 3. Get the API key from Vault via the tenant secret helper. (Legacy
  --    plaintext fallback removed — data migration MUST land before this is
  --    called in prod; in DEV it's applied stage-3 below.)
  v_api_key := public.get_tenant_secret(v_tenant_id, 'retell', 'api_key');

  if v_api_key is null or v_api_key = '' then
    return null;
  end if;

  return jsonb_build_object(
    'tenant_id', v_tenant_id,
    'api_key',   v_api_key
  );
end;
$$;

create or replace function public.get_sms_send_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action      actions;
  v_lead        leads;
  v_template    templates;
  v_credentials tenant_credentials;
  v_auth_token  text;
  v_body        text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then raise exception 'Action not found: %', p_action_id; end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then raise exception 'Lead not found: %', p_action_id; end if;

  select * into v_template
    from templates
   where tenant_id = v_action.tenant_id and template_key = v_action.template_key
   order by version desc limit 1;
  if not found then raise exception 'Template not found: %', v_action.template_key; end if;

  select * into v_credentials
    from tenant_credentials
   where tenant_id = v_action.tenant_id and provider='twilio' and active=true
   limit 1;
  if not found then raise exception 'No active Twilio credentials for tenant %', v_action.tenant_id; end if;

  -- SECRET TERM pulled from Vault; non-secret account_sid / from_number stay in config.
  v_auth_token := public.get_tenant_secret(v_action.tenant_id, 'twilio', 'auth_token');

  v_body := resolve_merge_tags(v_template.body, v_lead);

  return jsonb_build_object(
    'action_id',    v_action.id,
    'tenant_id',    v_action.tenant_id,
    'phone_to',     v_lead.phone_e164,
    'body',         v_body,
    'account_sid',  v_credentials.config->>'account_sid',
    'auth_token',   v_auth_token,
    'from_number',  v_credentials.config->>'from_number'
  );
end;
$$;