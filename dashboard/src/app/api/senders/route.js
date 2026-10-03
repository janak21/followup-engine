import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import { SENDER_SAFE_COLUMNS } from '@/lib/senderColumns';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function GET(request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role key missing. Add SUPABASE_SERVICE_ROLE_KEY and restart.' },
      { status: 503 }
    );
  }
  try {
    const tenantId = await getTenantId(request);
    const { data, error } = await supabase
      .from('senders')
      .select('id, tenant_id, sender_slot, sender_email, sender_name, n8n_credential_name, domain, active, daily_limit, sent_today, last_reset_date, min_seconds_between_sends, last_sent_at, warmup_stage, health_status, pause_until, total_sent, last_error, created_at, google_connected_at, google_scopes, google_client_id, gmail_history_id, gmail_last_polled_at, gmail_poll_error, gmail_readonly_granted')
      .eq('tenant_id', tenantId)
      .order('sender_slot', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Unexpected error fetching senders:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

const VALID_WARMUP = ['warming', 'active', 'paused', 'burnt'];
const VALID_HEALTH = ['green', 'yellow', 'red'];

function buildSenderPayload(body) {
  const out = {};
  const fields = [
    'sender_slot',
    'sender_email',
    'sender_name',
    'n8n_credential_name',
    'domain',
    'active',
    'daily_limit',
    'sent_today',
    'min_seconds_between_sends',
    'warmup_stage',
    'health_status',
    'pause_until',
    'last_error',
    // Per-sender OAuth client id (Option C). Empty string from the form means
    // "no override; use tenant default" — coerce to null below. The matching
    // client_secret is a SECRET and is handled separately via Vault (see
    // getSenderClientSecret + set_sender_secret), never stored on the row.
    'google_client_id',
  ];
  for (const f of fields) {
    if (body[f] !== undefined) out[f] = body[f];
  }

  if (out.daily_limit !== undefined) out.daily_limit = Number(out.daily_limit);
  if (out.sent_today !== undefined) out.sent_today = Number(out.sent_today);
  if (out.min_seconds_between_sends !== undefined) {
    out.min_seconds_between_sends = Number(out.min_seconds_between_sends);
  }
  // Empty-string OAuth field → null. Lets the operator clear an override
  // by saving the form with blank fields (falls back to tenant default).
  if (out.google_client_id === '') out.google_client_id = null;
  return out;
}

// Extract the per-sender OAuth client secret from the request body. Returns:
//   undefined -> caller did not send the field; leave the stored secret alone.
//   null      -> caller cleared it; delete the Vault secret.
//   string    -> new secret value to persist to Vault.
// The secret is NEVER placed on the senders row — it lives only in Vault,
// addressed by sender id via set_sender_secret.
function getSenderClientSecret(body) {
  if (body.google_client_secret === undefined) return undefined;
  const v = body.google_client_secret;
  return v === '' ? null : v;
}

// Persist (or clear) a sender's google_client_secret in Vault. No-op when the
// caller did not include the field.
async function persistSenderClientSecret(senderId, clientSecret) {
  if (clientSecret === undefined) return null;
  const { error } = await supabase.rpc('set_sender_secret', {
    p_sender_id: senderId,
    p_key:       'google_client_secret',
    p_value:     clientSecret,
  });
  return error || null;
}

function validateSenderPayload(payload, { isCreate = false } = {}) {
  if (isCreate) {
    const required = ['sender_slot', 'sender_email', 'sender_name', 'n8n_credential_name', 'domain'];
    for (const f of required) {
      if (!payload[f] || (typeof payload[f] === 'string' && payload[f].trim() === '')) {
        return `${f} is required`;
      }
    }
  }
  if (payload.warmup_stage && !VALID_WARMUP.includes(payload.warmup_stage)) {
    return `warmup_stage must be one of: ${VALID_WARMUP.join(', ')}`;
  }
  if (payload.health_status && !VALID_HEALTH.includes(payload.health_status)) {
    return `health_status must be one of: ${VALID_HEALTH.join(', ')}`;
  }
  if (payload.daily_limit !== undefined && (!Number.isFinite(payload.daily_limit) || payload.daily_limit < 0)) {
    return 'daily_limit must be a non-negative number';
  }
  if (payload.sent_today !== undefined && (!Number.isFinite(payload.sent_today) || payload.sent_today < 0)) {
    return 'sent_today must be a non-negative number';
  }
  if (payload.min_seconds_between_sends !== undefined
      && (!Number.isFinite(payload.min_seconds_between_sends) || payload.min_seconds_between_sends < 0)) {
    return 'min_seconds_between_sends must be a non-negative number';
  }
  if (payload.sender_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.sender_email)) {
    return 'sender_email must be a valid email address';
  }
  return null;
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const body = await request.json();
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant configured' }, { status: 404 });

    const payload = buildSenderPayload(body);
    const clientSecret = getSenderClientSecret(body);
    const err = validateSenderPayload(payload, { isCreate: true });
    if (err) return NextResponse.json({ error: err }, { status: 400 });

    payload.tenant_id = tenantId;
    if (payload.active === undefined) payload.active = true;
    if (payload.daily_limit === undefined) payload.daily_limit = 30;
    if (payload.warmup_stage === undefined) payload.warmup_stage = 'active';
    if (payload.health_status === undefined) payload.health_status = 'green';
    if (payload.min_seconds_between_sends === undefined) payload.min_seconds_between_sends = 1200;

    const { data, error } = await supabase
      .from('senders')
      .insert([payload])
      .select(SENDER_SAFE_COLUMNS)
      .maybeSingle();

    if (error) {
      const friendly = error.code === '23505'
        ? `A sender with sender_slot "${payload.sender_slot}" already exists for this tenant.`
        : error.message;
      return NextResponse.json({ error: friendly }, { status: 400 });
    }

    // Persist the per-sender OAuth client secret to Vault (never on the row).
    if (data?.id) {
      const secretErr = await persistSenderClientSecret(data.id, clientSecret);
      if (secretErr) return NextResponse.json({ error: secretErr.message }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error('Error in POST senders:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: 'Sender id is required' }, { status: 400 });
    const tenantId = await getTenantId(request);

    const payload = buildSenderPayload(body);
    const clientSecret = getSenderClientSecret(body);
    if (body.reset_today === true) {
      payload.sent_today = 0;
      payload.last_reset_date = new Date().toISOString().slice(0, 10);
    }
    if (Object.keys(payload).length === 0 && clientSecret === undefined) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    const err = validateSenderPayload(payload);
    if (err) return NextResponse.json({ error: err }, { status: 400 });

    // Confirm the sender exists for this tenant, then apply the row update (if
    // any). We always re-read via SENDER_SAFE_COLUMNS so no secret crosses the wire.
    let data;
    if (Object.keys(payload).length > 0) {
      const res = await supabase
        .from('senders')
        .update(payload)
        .eq('id', body.id)
        .eq('tenant_id', tenantId)
        .select(SENDER_SAFE_COLUMNS)
        .maybeSingle();
      if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
      if (!res.data) return NextResponse.json({ error: 'Sender not found' }, { status: 404 });
      data = res.data;
    } else {
      const res = await supabase
        .from('senders')
        .select(SENDER_SAFE_COLUMNS)
        .eq('id', body.id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
      if (!res.data) return NextResponse.json({ error: 'Sender not found' }, { status: 404 });
      data = res.data;
    }

    // Persist the per-sender OAuth client secret to Vault (never on the row).
    const secretErr = await persistSenderClientSecret(body.id, clientSecret);
    if (secretErr) return NextResponse.json({ error: secretErr.message }, { status: 500 });

    return NextResponse.json({ data });
  } catch (err) {
    console.error('Error in PUT senders:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Sender id is required' }, { status: 400 });
    const tenantId = await getTenantId(request);

    const { count, error: refErr } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('assigned_sender_id', id);
    if (refErr) return NextResponse.json({ error: refErr.message }, { status: 500 });
    if (count && count > 0) {
      return NextResponse.json(
        { error: `Cannot delete: ${count} lead(s) are assigned to this sender. Reassign or wait until their journeys complete.` },
        { status: 409 }
      );
    }

    const { error } = await supabase.from('senders').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE senders:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
