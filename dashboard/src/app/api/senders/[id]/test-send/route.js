// POST /api/senders/[id]/test-send
//
// Operator-only end-to-end test of the Gmail dispatch chain for a single
// sender:
//   1. Sender belongs to the caller's tenant AND has google_refresh_token.
//   2. Refresh access_token if expired (persists back to senders).
//   3. Build the same RFC822 the dispatcher would: multipart/alternative,
//      X-Example Co-Lead-Id header (set to "test-send"), Message-ID we own.
//   4. POST to Gmail messages.send. No queue, no action row, no template.
//      The user gets immediate pass/fail feedback.
//
// We deliberately bypass get_email_payload + dispatch-gmail-email here:
//   * we don't want to pollute actions/templates/leads tables with test rows
//   * we don't want to wait on the dispatcher tick to see a result
//   * the OAuth + RFC822 + Gmail call are the only things that can fail
//     in a way that wouldn't show up before going live anyway
//
// Body: { to, subject, body_html?, body_plain?, body_format? }
// body_format defaults to 'both'; if both bodies omitted we use defaults.
//
// Response: { ok: true, gmail_id, thread_id, message_id, to, via }
//        or { ok: false, stage, error, gmail? }
//
// Caller (the Settings UI) toasts the stage+error so the operator can fix
// the right thing (oauth client missing, refresh_token revoked, etc).
//
// IMPORTANT: we update sender.google_access_token + last_sent_at + sent_today
// the same way real sends do, so the daily counter and cool-down are honest.

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function fail(stage, message, status = 400, extra = {}) {
  return NextResponse.json({ ok: false, stage, error: message, ...extra }, { status });
}

// --- MIME helpers (mirror of the edge function; small enough to inline) ---

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
function b64url(str) {
  return b64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function wrap76(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}
function encodeHeaderWord(s) {
  if (/^[\x20-\x7E]*$/.test(s) && !/[?=]/.test(s)) return s;
  return `=?UTF-8?B?${b64(s)}?=`;
}
function formatFromHeader(name, email) {
  if (!name) return email;
  return `"${encodeHeaderWord(name).replace(/"/g, '\\"')}" <${email}>`;
}
function newMessageId(senderEmail) {
  const domain = senderEmail.split('@')[1] || 'followup.local';
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/-/g, '');
  return `<${id}.${Date.now()}@${domain}>`;
}
function htmlToPlain(html) {
  if (!html) return '';
  let t = html;
  t = t.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
                (_m, h, inner) => `${inner.replace(/<[^>]+>/g, '')} (${h})`);
  t = t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `- ${inner}\n`);
  t = t.replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|tr|table)>/gi, '\n\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, '')
       .replace(/<script[\s\S]*?<\/script>/gi, '')
       .replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;|&apos;/gi, "'");
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}
// Detect HTML so we can convert plain-text input to HTML before stuffing
// it into the text/html MIME part. Otherwise newlines collapse and the
// reader sees a wall of single-line text.
function looksLikeHtml(s) {
  if (!s) return false;
  return /<\/?[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/.test(s);
}
function plainToHtml(s) {
  if (!s) return '';
  const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = escaped.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`);
  return paragraphs.join('\n');
}

function buildMimeBody({ bodyHtml, bodyPlain, format }) {
  const rawBody = bodyHtml ?? '';
  const inputIsHtml = looksLikeHtml(rawBody);
  // htmlOut: always HTML. plainOut: always plain. Pick the right source for each.
  const htmlOut  = inputIsHtml ? rawBody : plainToHtml(rawBody);
  const plainOut = bodyPlain ?? (inputIsHtml ? htmlToPlain(rawBody) : rawBody);

  if (format === 'plain') {
    return {
      header: 'text/plain; charset=UTF-8',
      body: 'Content-Transfer-Encoding: base64\r\n\r\n' + wrap76(b64(plainOut)),
    };
  }
  if (format === 'html') {
    return {
      header: 'text/html; charset=UTF-8',
      body: 'Content-Transfer-Encoding: base64\r\n\r\n' + wrap76(b64(htmlOut)),
    };
  }
  // MIME boundary must be 7-bit ASCII per RFC 2046 §5.1.1. Earlier version
  // appended ⁿ (superscript n) which Gmail rejected, causing the raw
  // multipart payload to render in the inbox.
  const boundary = `_followup_${(crypto.randomUUID?.() || Date.now().toString()).replace(/-/g, '')}`;
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(plainOut)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(htmlOut)),
    `--${boundary}--`,
  ];
  return {
    header: `multipart/alternative; boundary="${boundary}"`,
    body: parts.join('\r\n'),
  };
}

// -------------------------------------------------------------------------

export async function POST(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  if (!isSupabaseConfigured()) {
    return fail('config', 'Supabase service role key missing.', 503);
  }

  // Next.js 15: params is a Promise — must be awaited.
  const { id: senderId } = await params;
  if (!senderId) return fail('input', 'Missing sender id', 400);

  let body;
  try { body = await request.json(); }
  catch { return fail('input', 'Invalid JSON body', 400); }

  const to       = (body?.to || '').trim();
  const subject  = (body?.subject || 'Example Co test send').slice(0, 200);
  // Optional per-step From display-name override (inline composer). Address is
  // always the sender's authenticated Gmail address; only the name changes.
  const fromName = typeof body?.from_name === 'string' ? body.from_name.trim().slice(0, 200) : '';
  const fmtIn    = body?.body_format;
  const format   = (fmtIn === 'plain' || fmtIn === 'html') ? fmtIn : 'both';
  const bodyHtml = body?.body_html ?? '<p>This is a Example Co test send. If you see this, the Gmail dispatch chain is working.</p>';
  const bodyPlain= body?.body_plain ?? null;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return fail('input', 'Provide a valid "to" email address.', 400);
  }

  const tenantId = await getTenantId(request);
  if (!tenantId) return fail('tenant', 'No tenant for this user.', 404);

  // 1. Sender belongs to tenant. Secret columns live in Vault now — never
  //    select them; read each one via get_sender_secret below.
  const { data: sender, error: senderErr } = await supabase
    .from('senders')
    .select('id, tenant_id, sender_email, sender_name, google_token_expires_at, google_client_id, daily_limit, sent_today, last_reset_date, last_sent_at, min_seconds_between_sends, active, warmup_stage, pause_until, total_sent')
    .eq('id', senderId)
    .maybeSingle();
  if (senderErr) return fail('read_sender', senderErr.message, 500);
  if (!sender)   return fail('read_sender', 'Sender not found', 404);
  if (sender.tenant_id !== tenantId) return fail('auth', 'Sender does not belong to this tenant', 403);

  // Pull the sender's secrets from Vault (they used to be plaintext columns).
  const [refreshToken, accessTokenFromVault, senderClientSecret] = await Promise.all([
    supabase.rpc('get_sender_secret', { p_sender_id: sender.id, p_key: 'google_refresh_token' }).then((r) => r.data ?? null),
    supabase.rpc('get_sender_secret', { p_sender_id: sender.id, p_key: 'google_access_token' }).then((r) => r.data ?? null),
    supabase.rpc('get_sender_secret', { p_sender_id: sender.id, p_key: 'google_client_secret' }).then((r) => r.data ?? null),
  ]);

  if (!refreshToken) {
    return fail('check_oauth', 'Sender is not connected to Google. Click "Connect Google" first.', 400);
  }

  // Be honest about throttling on test sends too: don't let the test
  // sneak past the cap and create confusion later.
  const today = new Date().toISOString().slice(0, 10);
  const effectiveSentToday = (sender.last_reset_date && sender.last_reset_date >= today)
    ? (sender.sent_today || 0)
    : 0;
  if (!sender.active) return fail('throttle', 'Sender is inactive. Re-enable it before testing.', 409);
  if (sender.pause_until && new Date(sender.pause_until).getTime() > Date.now()) {
    return fail('throttle', `Sender is paused until ${sender.pause_until}.`, 409);
  }
  if (effectiveSentToday >= (sender.daily_limit ?? 0)) {
    return fail('throttle', `Daily limit reached: ${effectiveSentToday}/${sender.daily_limit}. Increase the cap or wait until tomorrow.`, 409);
  }
  if (sender.last_sent_at && sender.min_seconds_between_sends) {
    const next = new Date(sender.last_sent_at).getTime() + sender.min_seconds_between_sends * 1000;
    if (Date.now() < next) {
      const waitSec = Math.ceil((next - Date.now()) / 1000);
      return fail('throttle', `Cooldown active: wait ~${waitSec}s before next send.`, 409);
    }
  }

  // 2. Resolve OAuth client: sender override wins, tenant default falls back.
  //    Must match whatever client_id+secret pair issued the refresh_token,
  //    or Google returns invalid_grant.
  let clientId     = sender.google_client_id;
  let clientSecret = senderClientSecret;
  if (!clientId || !clientSecret) {
    const { data: cred, error: credErr } = await supabase
      .from('tenant_credentials')
      .select('config')
      .eq('tenant_id', tenantId)
      .eq('provider', 'gmail')
      .eq('active', true)
      .maybeSingle();
    if (credErr) return fail('read_credentials', credErr.message, 500);
    clientId = clientId || cred?.config?.google_client_id;
    // google_client_secret is a SECRET — read the tenant fallback from Vault.
    if (!clientSecret) {
      const { data: vaultSecret, error: secretErr } = await supabase.rpc('get_tenant_secret', {
        p_tenant_id: tenantId,
        p_provider:  'gmail',
        p_key:       'google_client_secret',
      });
      if (secretErr) return fail('read_credentials', secretErr.message, 500);
      clientSecret = vaultSecret;
    }
  }
  if (!clientId || !clientSecret) {
    return fail('read_credentials', 'No Gmail OAuth client. Set Client ID + Secret on this sender (edit it) or as a tenant default.', 400);
  }

  // 3. Refresh access token if absent or expiring within 60s.
  let accessToken = accessTokenFromVault;
  const expiresAt = sender.google_token_expires_at ? new Date(sender.google_token_expires_at).getTime() : 0;
  if (!accessToken || expiresAt - Date.now() < 60_000) {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }).toString(),
    });
    const tokJson = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokJson.access_token) {
      const errMsg = tokJson?.error_description || tokJson?.error || `HTTP ${tokRes.status}`;
      const isInvalidGrant = tokJson?.error === 'invalid_grant';
      return fail(
        'refresh_token',
        isInvalidGrant
          ? `Google refresh_token invalid (${errMsg}). Reconnect Google for this sender.`
          : `Token refresh failed: ${errMsg}`,
        401,
      );
    }
    accessToken = tokJson.access_token;
    const newExpiresAt = tokJson.expires_in
      ? new Date(Date.now() + (Number(tokJson.expires_in) - 60) * 1000).toISOString()
      : null;
    // Persist the refreshed access token to Vault, NOT the plaintext column.
    const { error: vaultWriteErr } = await supabase.rpc('set_sender_secret', {
      p_sender_id: sender.id,
      p_key:       'google_access_token',
      p_value:     accessToken,
    });
    if (vaultWriteErr) return fail('write_secret', vaultWriteErr.message, 500);
    await supabase.from('senders')
      .update({ google_token_expires_at: newExpiresAt })
      .eq('id', sender.id);
  }

  // 4. Build RFC822.
  const messageId = newMessageId(sender.sender_email);
  const mime = buildMimeBody({ bodyHtml, bodyPlain, format });
  const headers = [
    `From: ${formatFromHeader(fromName || sender.sender_name, sender.sender_email)}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Message-ID: ${messageId}`,
    `X-Example Co-Lead-Id: test-send`,
    `X-Example Co-Test-Send: true`,
    'MIME-Version: 1.0',
    `Content-Type: ${mime.header}`,
    '',
    mime.body,
  ];
  const rfc822 = headers.join('\r\n');

  // 5. POST to Gmail.
  let gRes;
  try {
    gRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ raw: b64url(rfc822) }),
    });
  } catch (err) {
    return fail('gmail_fetch', err.message || 'Network error', 502);
  }
  let gJson;
  try { gJson = await gRes.json(); } catch { gJson = await gRes.text(); }
  if (!gRes.ok) {
    const msg = typeof gJson === 'object' ? (gJson?.error?.message || JSON.stringify(gJson)) : String(gJson);
    return fail('gmail_api', msg, gRes.status, { gmail: gJson });
  }
  const gmailId  = gJson?.id;
  const threadId = gJson?.threadId;
  if (!gmailId) return fail('gmail_api', 'Gmail returned 2xx but no id', 502, { gmail: gJson });

  // 6. Honest counter bookkeeping (so test sends count against daily cap).
  await supabase.from('senders').update({
    sent_today:      effectiveSentToday + 1,
    last_reset_date: today,
    last_sent_at:    new Date().toISOString(),
    total_sent:      (sender.total_sent || 0) + 1,
  }).eq('id', sender.id);

  return NextResponse.json({
    ok:         true,
    gmail_id:   gmailId,
    thread_id:  threadId,
    message_id: messageId,
    to,
    via:        sender.sender_email,
    format,
  });
}
