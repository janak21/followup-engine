-- Migration: resolve_retell_credentials(p_agent_id, p_phone) for X-Retell-Signature
-- multi-tenant validation.
--
-- Outbound dispatch (dispatch-retell-call) reads the Retell API key PER TENANT
-- from tenant_credentials(provider='retell', active).config->>'api_key'. The
-- inbound webhook verifier must do the same or a request signed by a client's
-- own Retell account will not match the platform's single account-level key.
--
-- Resolution order (first hit wins):
--   1. agent_id against retell_agents.agent_id  — Retell webhooks always carry
--      call.agent_id, and retell_agents is backfilled from tenant_credentials
--      (migration 20260618000000_retell_agents.sql), so it is the most
--      Retell-native identifier. agent_id is account-scoped: an attacker can
--      claim another tenant's agent_id, but the signature still must validate
--      against THAT tenant's API key — fail-closed.
--   2. phone (the webhook's from_number OR to_number — one is our owned
--      number) against tenant_credentials(provider='retell', active)
--      .config->>'from_number' (handles '+' prefix variants).
-- Returns jsonb { tenant_id, api_key } or NULL.
--
-- Limitation: assumes ONE active Retell credential row per tenant (matches the
-- existing outbound assumption — dispatch-retell-call uses .maybeSingle()). If
-- a tenant ever needs multiple Retell accounts, route by credential_id rather
-- than tenant_id.

create or replace function resolve_retell_credentials(
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

  -- 3. Get the API key from the tenant's active retell credential row.
  select c.config->>'api_key' into v_api_key
    from tenant_credentials c
   where c.tenant_id = v_tenant_id
     and c.provider = 'retell'
     and c.active = true
   limit 1;

  if v_api_key is null or v_api_key = '' then
    return null;
  end if;

  return jsonb_build_object(
    'tenant_id', v_tenant_id,
    'api_key',   v_api_key
  );
end;
$$;

-- Supabase/PostgREST grants EXECUTE to anon+authenticated on all public RPCs
-- by default; a REVOKE FROM public alone does NOT remove those. Revoke from
-- anon+authenticated explicitly, otherwise any anonymous caller can read a
-- tenant's Retell api_key by guessing the agent_id/phone via
-- /rest/v1/rpc/resolve_retell_credentials.
revoke execute on function resolve_retell_credentials(text, text) from anon;
revoke execute on function resolve_retell_credentials(text, text) from authenticated;
revoke execute on function resolve_retell_credentials(text, text) from public;
grant execute on function resolve_retell_credentials(text, text) to service_role;