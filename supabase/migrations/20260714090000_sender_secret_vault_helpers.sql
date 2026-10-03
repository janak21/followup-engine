-- Stage 1: Vault-backed per-sender secret helpers.
--
-- Scope: public.senders plaintext columns google_refresh_token,
-- google_access_token, and google_client_secret. These move into
-- vault.decrypted_secrets, addressed by:
--   sender_secret:<sender_id>:<secret_key>
--
-- Both helpers are SECURITY DEFINER so the Edge Functions / dashboard
-- (which carry the service_role key, bypassing RLS) can write/read encrypted
-- secrets without needing direct vault schema grants. EXECUTE is granted ONLY
-- to service_role; explicitly revoked from anon/authenticated/public.
--
-- Non-secret sender columns (google_client_id, google_token_expires_at,
-- google_connected_at, google_scopes, gmail_readonly_granted, etc.) STAY on
-- the senders row.

create or replace function public.set_sender_secret(
  p_sender_id uuid,
  p_key       text,
  p_value     text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_name text := 'sender_secret:' || p_sender_id::text || ':' || p_key;
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
    'sender=' || p_sender_id::text || ' key=' || p_key
  );
end;
$$;

create or replace function public.get_sender_secret(
  p_sender_id uuid,
  p_key       text
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_name text := 'sender_secret:' || p_sender_id::text || ':' || p_key;
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
revoke execute on function public.set_sender_secret(uuid, text, text) from anon;
revoke execute on function public.set_sender_secret(uuid, text, text) from authenticated;
revoke execute on function public.set_sender_secret(uuid, text, text) from public;
revoke execute on function public.get_sender_secret(uuid, text) from anon;
revoke execute on function public.get_sender_secret(uuid, text) from authenticated;
revoke execute on function public.get_sender_secret(uuid, text) from public;
grant execute on function public.set_sender_secret(uuid, text, text) to service_role;
grant execute on function public.get_sender_secret(uuid, text) to service_role;

-- Bulk helper for the dashboard: return all sender IDs in a tenant that have a
-- given secret key stored in Vault. Used to compute the derived
-- `google_client_secret_set` flag without exposing the secret value. The
-- underlying vault.decrypted_secrets view is only accessible to the function
-- owner (SECURITY DEFINER), so callers cannot enumerate secrets directly.
create or replace function public.get_sender_ids_with_secret(
  p_tenant_id uuid,
  p_key       text
)
returns table(sender_id uuid)
language sql
security definer
set search_path = public, vault
as $$
  select s.id
    from public.senders s
    join vault.decrypted_secrets d
      on d.name = 'sender_secret:' || s.id::text || ':' || p_key
   where s.tenant_id = p_tenant_id;
$$;

revoke execute on function public.get_sender_ids_with_secret(uuid, text) from anon;
revoke execute on function public.get_sender_ids_with_secret(uuid, text) from authenticated;
revoke execute on function public.get_sender_ids_with_secret(uuid, text) from public;
grant execute on function public.get_sender_ids_with_secret(uuid, text) to service_role;
