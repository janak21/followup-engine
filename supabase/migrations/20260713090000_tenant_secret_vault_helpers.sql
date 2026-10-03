-- Stage 2: Vault-backed per-tenant secret helpers.
--
-- Scope: tenant_credentials.config (jsonb). Per-sender secrets stored as plain
-- columns on `senders` are NOT in this migration (different shape —
-- follow-up ticket). The goal here is to move auth_token / api_key /
-- client_secret / google_refresh_token / google_access_token /
-- google_client_secret OUT of the plaintext config blob and into
-- vault.decrypted_secrets, addressed by:
--   tenant_secret:<tenant_id>:<provider>:<secret_key>
--
-- Both helpers are SECURITY DEFINER so the Edge Functions / RPCs / dashboard
-- (which carry the service_role key, bypassing RLS) can write/read encrypted
-- secrets without needing direct vault schema grants. EXECUTE is granted ONLY
-- to service_role; explicitly revoked from anon/authenticated/public.
--
-- Non-secret config keys (from_number, agent_id, account_sid, google_client_id,
-- messaging_service_sid, n8n_credential_name) STAY in tenant_credentials.config.

create or replace function public.set_tenant_secret(
  p_tenant_id uuid,
  p_provider  text,
  p_key       text,
  p_value     text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_name text := 'tenant_secret:' || p_tenant_id::text || ':' || p_provider || ':' || p_key;
begin
  if p_value is null then
    delete from vault.secrets where name = v_name;
    return;
  end if;

  -- Idempotent set: remove any prior secret with the same canonical name, then
  -- insert a fresh encrypted row. The default key_id (NULL) uses the Vault's
  -- default pgsodium key — sufficient for at-rest encryption; rotate via the
  -- Vault UI later if needed.
  delete from vault.secrets where name = v_name;
  perform vault.create_secret(
    p_value,
    v_name,
    'tenant=' || p_tenant_id::text || ' provider=' || p_provider || ' key=' || p_key
  );
end;
$$;

create or replace function public.get_tenant_secret(
  p_tenant_id uuid,
  p_provider  text,
  p_key       text
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_name text := 'tenant_secret:' || p_tenant_id::text || ':' || p_provider || ':' || p_key;
  v_out  text;
begin
  select decrypted_secret into v_out
  from vault.decrypted_secrets
  where name = v_name
  limit 1;
  return v_out;
end;
$$;

-- Hardened grants. PostgREST otherwise grants anon/authenticated EXECUTE on
-- any public RPC — these functions return decrypted secrets, so they MUST
-- NOT be reachable by anonymous callers.
revoke execute on function public.set_tenant_secret(uuid, text, text, text) from anon;
revoke execute on function public.set_tenant_secret(uuid, text, text, text) from authenticated;
revoke execute on function public.set_tenant_secret(uuid, text, text, text) from public;
revoke execute on function public.get_tenant_secret(uuid, text, text) from anon;
revoke execute on function public.get_tenant_secret(uuid, text, text) from authenticated;
revoke execute on function public.get_tenant_secret(uuid, text, text) from public;
grant execute on function public.set_tenant_secret(uuid, text, text, text) to service_role;
grant execute on function public.get_tenant_secret(uuid, text, text) to service_role;