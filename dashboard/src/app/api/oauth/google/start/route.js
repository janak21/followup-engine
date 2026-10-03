// GET /api/oauth/google/start?sender_id=<uuid>
//
// Kicks off the Google OAuth flow to connect a sender to its Gmail account.
//
// Reads the tenant's per-tenant Google OAuth client (client_id) from
// tenant_credentials.config under provider='gmail'. The tenant brings their
// own Google Cloud project + OAuth client. No broad Google verification is
// needed when the OAuth app is scoped to the tenant's Google Workspace.
// client_secret is only used on
// the callback side, never in the redirect URL.
//
// Generates a random opaque state token, stores it in google_oauth_states
// keyed to {sender_id, tenant_id}, then 302s to Google's consent screen.

import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function GET(request) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }

  try {
    const url = new URL(request.url);
    const senderId = url.searchParams.get('sender_id');
    if (!senderId) {
      return NextResponse.json({ error: 'sender_id query param required' }, { status: 400 });
    }

    const tenantId = await getTenantId(request);
    if (!tenantId) {
      return NextResponse.json({ error: 'No tenant found' }, { status: 404 });
    }

    // Verify the sender belongs to this tenant. Pull its per-sender
    // OAuth client (if set) so we can use it instead of the tenant default.
    const { data: sender, error: senderErr } = await supabase
      .from('senders')
      .select('id, tenant_id, sender_email, sender_name, google_client_id')
      .eq('id', senderId)
      .maybeSingle();
    if (senderErr) return NextResponse.json({ error: senderErr.message }, { status: 500 });
    if (!sender || sender.tenant_id !== tenantId) {
      return NextResponse.json({ error: 'Sender not found' }, { status: 404 });
    }

    // Resolution: sender.google_client_id wins over tenant default. This is
    // what makes multi-Workspace senders work — each sender can have an
    // OAuth client scoped to its own Workspace. NULL falls back to the
    // tenant-level client (single-Workspace tenants don't override).
    let clientId = sender.google_client_id;
    if (!clientId) {
      const { data: cred } = await supabase
        .from('tenant_credentials')
        .select('config')
        .eq('tenant_id', tenantId)
        .eq('provider', 'gmail')
        .eq('active', true)
        .maybeSingle();
      clientId = cred?.config?.google_client_id;
    }
    if (!clientId) {
      return NextResponse.json({
        error: 'No Gmail OAuth client configured. Either set Client ID + Secret on this sender (Settings → Senders → Edit), or set a tenant default in Settings → Credentials → Gmail.',
      }, { status: 400 });
    }

    // Cleanup: drop state rows older than 30 minutes — they're useless and
    // would otherwise accumulate forever.
    await supabase
      .from('google_oauth_states')
      .delete()
      .lt('created_at', new Date(Date.now() - 30 * 60 * 1000).toISOString());

    // Generate a CSRF-resistant state.
    const state = crypto.randomBytes(32).toString('base64url');
    const redirectAfter = url.searchParams.get('redirect_after') || '/settings';

    const { error: stateErr } = await supabase
      .from('google_oauth_states')
      .insert({
        state,
        tenant_id:      tenantId,
        sender_id:      senderId,
        redirect_after: redirectAfter,
      });
    if (stateErr) return NextResponse.json({ error: stateErr.message }, { status: 500 });

    // Construct the redirect URI from the request origin — must match exactly
    // what the tenant configured in their Google Cloud OAuth client.
    const origin = url.origin;
    const redirectUri = `${origin}/api/oauth/google/callback`;

    // Scopes:
    //   * gmail.send     — required, for outbound dispatch
    //   * gmail.readonly — required for native inbound polling. We only
    //     READ messages, never modify or delete. With an Internal-type
    //     OAuth consent screen (each tenant's own GCP project) this scope
    //     does NOT trigger Google's restricted-scope verification — internal
    //     apps bypass it entirely.
    //   * userinfo.email + openid — identify the connected mailbox in the
    //     callback for audit + UI display.
    const scope = [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid',
    ].join(' ');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',     clientId);
    authUrl.searchParams.set('redirect_uri',  redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope',         scope);
    authUrl.searchParams.set('access_type',   'offline');  // refresh token
    // 'consent' forces a refresh_token re-issue even if previously consented;
    // 'select_account' forces Google's account chooser so we don't silently
    // re-authorize whatever Google account happens to be signed in. This
    // matters when an operator has multiple senders / multiple Workspaces.
    authUrl.searchParams.set('prompt',        'consent select_account');
    authUrl.searchParams.set('state',         state);
    authUrl.searchParams.set('login_hint',    sender.sender_email);

    return NextResponse.redirect(authUrl.toString());
  } catch (err) {
    console.error('OAuth start error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
