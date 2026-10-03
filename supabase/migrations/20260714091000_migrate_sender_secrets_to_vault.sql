-- Stage 2 (one-time data migration): copy each plaintext sender secret from
-- public.senders into Vault via set_sender_secret(), then NULL the plaintext
-- columns — keeping non-secret columns untouched.
--
-- ACCEPTED SECRET COLUMNS:
--   google_refresh_token, google_access_token, google_client_secret
--
-- SAFETY (per ticket):
--   * Idempotent: safe to re-run (only acts on rows where the secret column is
--     still non-null; once nulled, that row/column is skipped).
--   * Same-transaction round-trip verification: after writing each secret, we
--     read it back from Vault; any mismatch raises and the whole tx rolls back.
--   * DEV ONLY applied via MCP. Prod is promoted separately by the reviewer.
--   * REVERSIBLE: the plaintext columns are NOT dropped. A later cleanup
--     migration can drop them once prod is confirmed. Rollback would re-hydrate
--     the columns by reading from get_sender_secret, but the secrets are NEVER
--     lost — they stay in Vault after this migration.

do $$
declare
  r          record;
  secret_map jsonb := jsonb_build_object(
    'google_refresh_token',  'google_refresh_token',
    'google_access_token',   'google_access_token',
    'google_client_secret',  'google_client_secret'
  );
  col_name   text;
  vault_key  text;
  v_val      text;
  v_roundtrip text;
  migrated   int := 0;
  failure    text;
begin
  for r in select id,
                  google_refresh_token,
                  google_access_token,
                  google_client_secret
             from public.senders
            where google_refresh_token is not null
               or google_access_token is not null
               or google_client_secret is not null
  loop
    for col_name, vault_key in select * from jsonb_each_text(secret_map) loop
      -- Dynamic column read via JSONB. Only migrate if the plaintext column
      -- still holds a non-empty value; otherwise this row/column is skipped.
      v_val := to_jsonb(r) ->> col_name;

      if v_val is null or v_val = '' then
        continue;
      end if;

      -- Write to Vault.
      perform public.set_sender_secret(r.id, vault_key, v_val);

      -- Round-trip verification (same transaction).
      select public.get_sender_secret(r.id, vault_key) into v_roundtrip;
      if v_roundtrip is distinct from v_val then
        failure := format('vault round-trip FAILED for sender=%s key=%s (got=%L expected=%L)',
          r.id, vault_key, v_roundtrip, v_val);
        raise '%', failure;
      end if;

      migrated := migrated + 1;
    end loop;
  end loop;

  -- Strip the plaintext columns in one pass. NULLs are idempotent and preserve
  -- non-secret sender data.
  update public.senders s
     set google_refresh_token = null,
         google_access_token  = null,
         google_client_secret = null
   where s.google_refresh_token is not null
      or s.google_access_token is not null
      or s.google_client_secret is not null;

  raise notice 'senders → Vault migration complete: % secret values copied', migrated;
end $$;

-- Verification SELECT — should show ZERO rows where any recognized secret
-- column is still non-null:
select
  count(*) filter (where google_refresh_token is not null
                    or google_access_token is not null
                    or google_client_secret is not null) as rows_with_remaining_plaintext_secrets_after_migration,
  count(*) as total_rows
from public.senders;
