// Canonical safe reading list + derived-flag helpers for `senders`.
//
// The `senders` table previously held three plaintext secret columns:
//   - google_refresh_token
//   - google_access_token
//   - google_client_secret
//
// These have been migrated to Supabase Vault and MUST NOT be returned to the
// browser. Instead, the API computes two derived booleans server-side and
// sends ONLY those:
//   - google_connected         (true when google_connected_at exists)
//   - google_client_secret_set (true when a Vault secret exists for this key)
//
// `google_client_secret_set` is computed via the SECURITY DEFINER RPC
// get_sender_ids_with_secret, which returns only IDs — the secret VALUE never
// crosses the wire.

export const SENDER_SAFE_COLUMNS =
  'id, tenant_id, sender_slot, sender_email, sender_name, n8n_credential_name, domain, active, ' +
  'daily_limit, sent_today, last_reset_date, min_seconds_between_sends, last_sent_at, warmup_stage, ' +
  'health_status, pause_until, total_sent, last_error, created_at, google_connected_at, google_scopes, ' +
  'google_client_id, gmail_history_id, gmail_last_polled_at, gmail_poll_error, gmail_readonly_granted';

export const SENDER_SECRET_COLUMNS = [
  'google_refresh_token',
  'google_access_token',
  'google_client_secret',
];

// Returns a Set of sender IDs that have a `google_client_secret` value stored
// in Vault for this tenant. The RPC returns only IDs — the secret value itself
// never crosses the wire.
export async function fetchSenderIdsWithClientSecret(supabase, tenantId) {
  const { data, error } = await supabase.rpc('get_sender_ids_with_secret', {
    p_tenant_id: tenantId,
    p_key:       'google_client_secret',
  });
  if (error) throw error;
  return new Set((data || []).map((r) => r.sender_id));
}

// Given raw sender rows fetched with SENDER_SAFE_COLUMNS, attach the two
// derived booleans the UI needs (the raw rows contain no secret values by
// construction). `secretSetIds` is the Set returned by the helper above.
export function enrichSenders(senders, secretSetIds) {
  return (senders || []).map((s) => ({
    ...s,
    google_connected: Boolean(s.google_connected_at),
    google_client_secret_set: secretSetIds ? secretSetIds.has(s.id) : false,
  }));
}