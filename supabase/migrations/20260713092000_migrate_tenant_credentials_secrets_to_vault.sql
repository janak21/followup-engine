-- Stage 3 (one-time data migration): copy each plaintext secret from
-- tenant_credentials.config into Vault via set_tenant_secret(), then NULL the
-- plaintext key in config — keeping non-secret keys (from_number, agent_id,
-- account_sid, google_client_id, messaging_service_sid, n8n_credential_name).
--
-- ACCEPTED SECRET KEYS (the rest of config is left untouched):
--   auth_token, api_key, client_secret, google_refresh_token,
--   google_access_token, google_client_secret
--
-- SAFETY (per ticket):
--   * Idempotent: safe to re-run (only acts on rows where the secret key still
--     exists in config; once nulled, skip).
--   * Same-transaction round-trip verification: after writing each secret, we
--     read it back from Vault; any mismatch raises and the whole tx rolls back.
--   * DEV ONLY applied via MCP. Prod (xlvthuuinxbpyinviqvp) is promoted separately.
--   * REVERSIBLE: rollback would re-hydrate config by reading from
--     get_tenant_secret, but the secrets are NEVER lost — they stay in Vault
--     after this migration. (Vault rows are NOT deleted by rollback — a future
--     rollback migration could re-populate config if needed.)

do $$
declare
  r           record;
  secret_keys text[] := array[
    'auth_token','api_key','client_secret',
    'google_refresh_token','google_access_token','google_client_secret'
  ];
  k           text;
  v_val       text;
  v_roundtrip text;
  migrated    int := 0;
  failure     text;
begin
  for r in select id, tenant_id, provider, config
             from tenant_credentials
            where config is not null
            and provider is not null
            and tenant_id is not null
  loop
    foreach k in array secret_keys loop
      if r.config ? k then
        v_val := r.config ->> k;

        -- Skip empty/null values but DO remove the key from config (don't migrate empties).
        if v_val is null or v_val = '' then
          continue;
        end if;

        -- Write to Vault.
        perform public.set_tenant_secret(r.tenant_id, r.provider, k, v_val);

        -- Round-trip verification (same transaction).
        select public.get_tenant_secret(r.tenant_id, r.provider, k) into v_roundtrip;
        if v_roundtrip is distinct from v_val then
          failure := format('vault round-trip FAILED for tenant=%s provider=%s key=%s (got=%L expected=%L)',
            r.tenant_id, r.provider, k, v_roundtrip, v_val);
          raise '%', failure;
        end if;

        migrated := migrated + 1;
      end if;
    end loop;
  end loop;

  -- Strip ALL recognized secret keys from config in one pass per row,
  -- preserving non-secret keys.
  update tenant_credentials c
     set config = c.config - secret_keys
   where c.config is not null
     and exists (
       select 1 from jsonb_object_keys(c.config) ok
       where ok = any(secret_keys)
     );

  raise notice 'tenant_credentials → Vault migration complete: % secret values copied', migrated;
end $$;

-- Verification SELECT — should show ZERO rows where any recognized secret key
-- still exists in config:
select
  count(*) filter (
    where config ?| array[
      'auth_token','api_key','client_secret',
      'google_refresh_token','google_access_token','google_client_secret'
    ]
  ) as rows_with_remaining_plaintext_secrets_after_migration,
  count(*) as total_rows
from tenant_credentials;