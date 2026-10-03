// POST /api/leads/[id]/reply
//
// Operator-typed inline reply to a lead. Creates an actions row in the
// existing queue (so sender selection, throttling, threading, retry all
// "just work"), then directly invokes the appropriate dispatch edge
// function so the operator sees the result within seconds instead of
// waiting for the next dispatcher tick.
//
// Body: { channel: 'email' | 'sms', subject?: string, body: string }
//
// Returns: { ok, action_id, dispatched: bool, dispatch_result? }
//
// Idempotency: each request gets a fresh idempotency_key built from the
// lead id + timestamp + random. Won't dedupe with retries; that's fine —
// you don't accidentally double-fire a reply because there's no automatic
// retry path on this endpoint.

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';
import { getEdgeAuthHeader, getEdgeFunctionUrl } from '@/utils/edge-auth';
import crypto from 'crypto';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function bad(message, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  if (!isSupabaseConfigured()) return bad('Supabase not configured.', 503);

  const { id: leadId } = await params;
  if (!leadId) return bad('Missing lead id', 400);

  let body;
  try { body = await request.json(); }
  catch { return bad('Invalid JSON body'); }

  const channel = body?.channel === 'sms' ? 'sms' : 'email';
  const replyBody = (body?.body || '').trim();
  const replySubject = (body?.subject || '').trim();
  if (!replyBody) return bad('Body is required');

  const tenantId = await getTenantId(request);
  if (!tenantId) return bad('No tenant for this user', 404);

  // 1. Lead exists in this tenant.
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, tenant_id, email, phone_e164, journey_status, opt_out, current_step, assigned_sender_id, email_thread_id, last_email_message_id')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) return bad(leadErr.message, 500);
  if (!lead) return bad('Lead not found', 404);
  if (lead.tenant_id !== tenantId) return bad('Lead does not belong to this tenant', 403);

  // Refuse to send to an opted-out lead. Operator can still see the
  // conversation — this just blocks new sends.
  if (lead.opt_out) return bad('Lead has opted out; cannot send.', 409);

  if (channel === 'email' && !lead.email) return bad('Lead has no email address');
  if (channel === 'sms'   && !lead.phone_e164) return bad('Lead has no phone number');

  // 2. Build action row. For email we pass payload.inline so get_email_payload
  //    uses the operator's text instead of a template. For SMS the existing
  //    get_sms_payload also has to honor inline (separate migration if not).
  const idempotencyKey = `reply:${leadId}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
  const subjectForInsert =
    channel === 'email'
      ? (replySubject || 'Re:')   // placeholder; the dispatcher prepends Re: properly using lead.email_thread_id
      : null;

  const actionInsert = {
    tenant_id:        tenantId,
    lead_id:          leadId,
    action_type:      channel,
    step_index:       lead.current_step ?? 0,
    template_key:     '__inline_reply__',  // sentinel; dispatcher uses inline payload instead
    run_at:           new Date().toISOString(),
    status:           'pending',
    idempotency_key:  idempotencyKey,
    payload: {
      source: 'operator_inline_reply',
      inline: {
        subject: subjectForInsert,
        body:    replyBody,
        // body_format defaults to 'both' in the dispatcher; operator-typed
        // reply is plain text from a textarea, the dispatcher's plain->HTML
        // auto-detect handles formatting.
      },
    },
  };

  const { data: action, error: insErr } = await supabase
    .from('actions')
    .insert([actionInsert])
    .select()
    .single();
  if (insErr) return bad(`Failed to enqueue reply: ${insErr.message}`, 500);

  // 3. Fire-and-wait the dispatch immediately. If this fails, the action is
  //    still pending so the next dispatcher tick will retry. Either way we
  //    return ok=true so the UI optimistically renders the bubble.
  //
  // Auth via centralized helper: prefers INTERNAL_DISPATCH_KEY (stable),
  // falls back to SUPABASE_SERVICE_ROLE_KEY for backwards compat.
  const dispatchFn = channel === 'sms' ? 'dispatch-twilio-sms' : 'dispatch-gmail-email';

  let dispatchResult = null;
  try {
    const dispRes = await fetch(getEdgeFunctionUrl(dispatchFn), {
      method: 'POST',
      headers: {
        Authorization: getEdgeAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action_id: action.id }),
    });
    dispatchResult = await dispRes.json().catch(() => ({ ok: dispRes.ok, status: dispRes.status }));
  } catch (err) {
    dispatchResult = { ok: false, error: err.message || String(err), deferred: true };
  }

  return NextResponse.json({
    ok: true,
    action_id: action.id,
    channel,
    dispatched: dispatchResult?.ok === true,
    dispatch_result: dispatchResult,
  });
}
