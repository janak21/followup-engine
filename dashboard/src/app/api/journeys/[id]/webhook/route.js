import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import crypto from 'crypto';
import { requireOperator } from "@/utils/role";
import { getTenantId } from '@/utils/tenant';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const WEBHOOK_BASE_URL = process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL
  || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/journey-trigger` : '');

// GET  /api/journeys/{id}/webhook                                  -> token info + recent samples + auth
// POST /api/journeys/{id}/webhook                                  -> ensure (generate if missing) a token, return URL
// PUT  /api/journeys/{id}/webhook  body { action }                 -> action:"rotate"|"clear_samples"|"set_auth"
//                                                                     when action=set_auth: { mode: "none"|"bearer", rotate_secret?: true }
export async function GET(request, { params }) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { data: journey, error: jErr } = await supabase
      .from('journeys')
      .select('id, journey_key, name, webhook_token, webhook_auth_mode, webhook_secret')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (jErr) return NextResponse.json({ error: jErr.message }, { status: 500 });
    if (!journey) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });

    const url = journey.webhook_token
      ? `${WEBHOOK_BASE_URL}/${journey.webhook_token}`
      : null;

    let samples = [];
    if (journey.webhook_token) {
      const { data, error } = await supabase
        .from('journey_webhook_samples')
        .select('id, payload, headers, received_at, result_status, result_reason, result_lead_id, result_action_id, result_message, result_run_id, result_workflow_action_id, result_details')
        .eq('journey_id', journey.id)
        .order('received_at', { ascending: false })
        .limit(10);
      if (!error && data) samples = data;
    }

    return NextResponse.json({
      data: {
        journey_id: journey.id,
        journey_key: journey.journey_key,
        name: journey.name,
        webhook_token: journey.webhook_token,
        webhook_url: url,
        webhook_auth_mode: journey.webhook_auth_mode || 'none',
        webhook_secret: journey.webhook_secret || null,
        samples
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { data: journey, error: journeyErr } = await supabase
      .from('journeys')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (journeyErr) return NextResponse.json({ error: journeyErr.message }, { status: 500 });
    if (!journey) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });
    const { data: token, error } = await supabase.rpc('ensure_journey_webhook_token', { p_journey_id: id });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      data: {
        webhook_token: token,
        webhook_url: `${WEBHOOK_BASE_URL}/${token}`,
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req, { params }) {
  const __guard = await requireOperator(req); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const { id } = await params;
    const tenantId = await getTenantId(req);
    const { data: journey, error: journeyErr } = await supabase
      .from('journeys')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (journeyErr) return NextResponse.json({ error: journeyErr.message }, { status: 500 });
    if (!journey) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === 'rotate') {
      const { data, error } = await supabase.rpc('rotate_journey_webhook_token', { p_journey_id: id });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({
        data: {
          webhook_token: data,
          webhook_url: `${WEBHOOK_BASE_URL}/${data}`,
        }
      });
    }

    if (action === 'clear_samples') {
      const { error } = await supabase.from('journey_webhook_samples').delete().eq('journey_id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ data: { cleared: true } });
    }

    if (action === 'set_auth') {
      const mode = body.mode;
      if (!['none', 'bearer'].includes(mode)) {
        return NextResponse.json({ error: 'mode must be "none" or "bearer"' }, { status: 400 });
      }
      const update = { webhook_auth_mode: mode };
      if (mode === 'bearer') {
        if (body.rotate_secret || !body.secret) {
          update.webhook_secret = 'wsec_' + crypto.randomBytes(24).toString('hex');
        } else {
          update.webhook_secret = body.secret;
        }
      } else {
        update.webhook_secret = null;
      }
      const { data, error } = await supabase
        .from('journeys')
        .update(update)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select('webhook_auth_mode, webhook_secret')
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ data });
    }

    return NextResponse.json({ error: 'Unknown action. Use "rotate", "clear_samples", or "set_auth".' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
