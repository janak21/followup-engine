// GET /api/oauth/google/callback?code=<auth_code>&state=<csrf_state>
//
// Google redirects here after the user consents. We:
//   1. Look up the state row to know which sender + tenant this connects.
//   2. Exchange the auth code for {access_token, refresh_token, expires_in}.
//   3. Hit Google's userinfo endpoint to confirm which Gmail account was just
//      authorized (sanity check against sender_email — log if mismatch).
//   4. Store the tokens on the sender row.
//   5. Delete the consumed state row.
//   6. Redirect the user back to wherever they came from (Settings by default)
//      with a success/error query param the UI can read.
//
// Error handling: bubble OAuth errors into the redirect as ?gmail_error=...
// so the UI can show a toast. Don't leak tokens in URLs.

import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function redirectWith(origin, path, params) {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return NextResponse.redirect(url.toString());
}

export async function GET(request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const code        = url.searchParams.get('code');
  const state       = url.searchParams.get('state');
  const oauthError  = url.searchParams.get('error');

  // User cancelled or Google returned an error in the redirect.
  if (oauthError) {
    return redirectWith(origin, '/settings', {
      gmail_status: 'error',
      gmail_error:  oauthError,
    });
  }
  if (!code || !state) {
    return redirectWith(origin, '/settings', {
      gmail_status: 'error',
      gmail_error:  'Missing code or state in callback',
    });
  }
  if (!isSupabaseConfigured()) {
    return redirectWith(origin, '/settings', {
      gmail_status: 'error',
      gmail_error:  'Supabase not configured',
    });
  }

  // 1. Resolve the state row.
  const { data: stateRow, error: stateErr } = await supabase
    .from('google_oauth_states')
    .select('state, tenant_id, sender_id, redirect_after')
    .eq('state', state)
    .maybeSingle();
  if (stateErr || !stateRow) {
    return redirectWith(origin, '/settings', {
      gmail_status: 'error',
      gmail_error:  'Invalid or expired state. Please retry the connection.',
    });
  }

  // 2. Resolve OAuth client: sender override wins, tenant default falls back.
  //    The pair we use here is the pair we'll snapshot onto the sender, so
  //    future token refreshes use the exact same client that issued the token.
  //    Without snapshotting, rotating tenant credentials would silently break
  //    every existing sender connection.
  const { data: senderRow } = await supabase
    .from('senders')
    .select('google_client_id')
    .eq('id', stateRow.sender_id)
    .maybeSingle();

  let clientId = senderRow?.google_client_id || null;
  // google_client_secret is a SECRET — read the per-sender override from Vault.
  const { data: senderClientSecret } = await supabase.rpc('get_sender_secret', {
    p_sender_id: stateRow.sender_id,
    p_key:       'google_client_secret',
  });
  let clientSecret = senderClientSecret || null;

  if (!clientId || !clientSecret) {
    const { data: cred } = await supabase
      .from('tenant_credentials')
      .select('config')
      .eq('tenant_id', stateRow.tenant_id)
      .eq('provider', 'gmail')
      .eq('active', true)
      .maybeSingle();
    clientId = clientId || cred?.config?.google_client_id;
    if (!clientSecret) {
      const { data: tenantClientSecret } = await supabase.rpc('get_tenant_secret', {
        p_tenant_id: stateRow.tenant_id,
        p_provider:  'gmail',
        p_key:       'google_client_secret',
      });
      clientSecret = tenantClientSecret || null;
    }
  }

  if (!clientId || !clientSecret) {
    return redirectWith(origin, stateRow.redirect_after || '/settings', {
      gmail_status: 'error',
      gmail_error:  'Gmail OAuth client missing. Set Client ID + Secret on this sender (Settings → Senders → Edit) or as a tenant default (Settings → Credentials → Gmail).',
    });
  }

  // 3. Exchange code for tokens.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  `${origin}/api/oauth/google/callback`,
      grant_type:    'authorization_code',
    }).toString(),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    console.error('Google token exchange failed:', tokenJson);
    return redirectWith(origin, stateRow.redirect_after || '/settings', {
      gmail_status: 'error',
      gmail_error:  tokenJson?.error_description || tokenJson?.error || `HTTP ${tokenRes.status}`,
    });
  }

  // 4. Confirm the authorized email via userinfo. Sanity check + audit.
  let authorizedEmail = null;
  try {
    const uiRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (uiRes.ok) {
      const ui = await uiRes.json();
      authorizedEmail = ui?.email || null;
    }
  } catch (e) {
    console.warn('userinfo lookup failed (non-fatal):', e);
  }

  // 5. Store tokens on the sender row.
  // refresh_token is only returned on the FIRST consent (or when prompt=consent
  // forces re-issuance). Our /start route sets prompt=consent so we always get
  // one. If it's missing, surface that — the user needs to remove the app from
  // their Google account's third-party access list and retry.
  if (!tokenJson.refresh_token) {
    return redirectWith(origin, stateRow.redirect_after || '/settings', {
      gmail_status: 'error',
      gmail_error:  'No refresh_token returned by Google. Revoke our app at https://myaccount.google.com/permissions and retry.',
    });
  }

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + (Number(tokenJson.expires_in) - 60) * 1000).toISOString()
    : null;

  // Snapshot the client_id+secret used onto the sender so future token
  // refreshes use the SAME client that issued this token. Critical for
  // multi-Workspace tenants — each sender's refresh path stays correct
  // even if the tenant default later changes or a different sender
  // overrides with its own client.
  //
  // Also flip gmail_readonly_granted based on whether the operator
  // approved the readonly scope (Google may have shown a chooser; users
  // can in theory decline individual scopes). Without readonly the poll
  // worker can't read inbox, so we record it explicitly.
  const grantedScopes = String(tokenJson.scope || '').toLowerCase();
  const readonlyGranted = grantedScopes.includes('gmail.readonly');

  // Secrets (client_secret, refresh_token, access_token) go to Vault via
  // set_sender_secret — never onto the senders row. Only non-secret metadata
  // is written to the row here.
  const secretErr =
    (await supabase.rpc('set_sender_secret', {
      p_sender_id: stateRow.sender_id,
      p_key:       'google_client_secret',
      p_value:     clientSecret,
    })).error ||
    (await supabase.rpc('set_sender_secret', {
      p_sender_id: stateRow.sender_id,
      p_key:       'google_refresh_token',
      p_value:     tokenJson.refresh_token,
    })).error ||
    (await supabase.rpc('set_sender_secret', {
      p_sender_id: stateRow.sender_id,
      p_key:       'google_access_token',
      p_value:     tokenJson.access_token,
    })).error;
  if (secretErr) {
    return redirectWith(origin, stateRow.redirect_after || '/settings', {
      gmail_status: 'error',
      gmail_error:  `Failed to save tokens: ${secretErr.message}`,
    });
  }

  const { error: upErr } = await supabase
    .from('senders')
    .update({
      google_client_id:        clientId,
      google_token_expires_at: expiresAt,
      google_connected_at:     new Date().toISOString(),
      google_scopes:           tokenJson.scope || null,
      gmail_readonly_granted:  readonlyGranted,
      // Reset the history cursor on reconnect — we'll bootstrap from
      // the current historyId on the next poll. Otherwise an old cursor
      // could be ahead of what a re-auth'd account can fetch.
      gmail_history_id:        null,
    })
    .eq('id', stateRow.sender_id)
    .eq('tenant_id', stateRow.tenant_id);

  if (upErr) {
    return redirectWith(origin, stateRow.redirect_after || '/settings', {
      gmail_status: 'error',
      gmail_error:  `Failed to save tokens: ${upErr.message}`,
    });
  }

  // 6. Consume the state row.
  await supabase.from('google_oauth_states').delete().eq('state', state);

  return redirectWith(origin, stateRow.redirect_after || '/settings', {
    gmail_status:           'connected',
    gmail_sender_id:        stateRow.sender_id,
    gmail_authorized_email: authorizedEmail || '',
  });
}
