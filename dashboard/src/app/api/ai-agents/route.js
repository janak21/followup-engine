// /api/ai-agents
//
// GET    — list agents for the operator's tenant
// POST   — create a new agent
// PUT    — update an existing agent (body must include id)
// DELETE — remove an agent (cascades KB items via FK)
//
// All writes are operator-only. Reads are tenant-scoped via getTenantId.
// The shape mirrors what /settings/ai-agents renders, with all numeric
// + array fields coerced before DB write so the UI can ship strings.

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

const VALID_PROVIDERS = ['anthropic', 'openai', 'openrouter'];
const VALID_INTENTS = [
  'positive', 'negative', 'question', 'objection',
  'out_of_office', 'complex', 'unsubscribe', 'auto_reply',
  'meeting_request', 'pricing_question', 'other',
];

function buildPayload(body) {
  const out = {};
  const fields = [
    'name', 'description', 'enabled',
    'provider', 'model', 'system_prompt',
    'temperature', 'max_tokens',
    'escalate_on_intents', 'confidence_threshold',
    'max_replies_per_lead',
  ];
  for (const f of fields) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  if (out.temperature !== undefined)          out.temperature = Number(out.temperature);
  if (out.max_tokens !== undefined)           out.max_tokens = Number(out.max_tokens);
  if (out.confidence_threshold !== undefined) out.confidence_threshold = Number(out.confidence_threshold);
  if (out.max_replies_per_lead !== undefined) out.max_replies_per_lead = Number(out.max_replies_per_lead);
  if (out.escalate_on_intents !== undefined && !Array.isArray(out.escalate_on_intents)) {
    out.escalate_on_intents = [];
  }
  return out;
}

function validate(payload, { isCreate = false } = {}) {
  if (isCreate) {
    for (const f of ['name', 'provider', 'model']) {
      if (!payload[f] || (typeof payload[f] === 'string' && payload[f].trim() === '')) {
        return `${f} is required`;
      }
    }
  }
  if (payload.provider && !VALID_PROVIDERS.includes(payload.provider)) {
    return `provider must be one of: ${VALID_PROVIDERS.join(', ')}`;
  }
  if (payload.temperature !== undefined && (!Number.isFinite(payload.temperature) || payload.temperature < 0 || payload.temperature > 2)) {
    return 'temperature must be between 0 and 2';
  }
  if (payload.max_tokens !== undefined && (!Number.isFinite(payload.max_tokens) || payload.max_tokens < 1 || payload.max_tokens > 32000)) {
    return 'max_tokens must be between 1 and 32000';
  }
  if (payload.confidence_threshold !== undefined && (!Number.isFinite(payload.confidence_threshold) || payload.confidence_threshold < 0 || payload.confidence_threshold > 1)) {
    return 'confidence_threshold must be between 0 and 1';
  }
  if (payload.max_replies_per_lead !== undefined && (!Number.isFinite(payload.max_replies_per_lead) || payload.max_replies_per_lead < 0)) {
    return 'max_replies_per_lead must be a non-negative number';
  }
  if (Array.isArray(payload.escalate_on_intents)) {
    const bad = payload.escalate_on_intents.find((x) => !VALID_INTENTS.includes(x));
    if (bad) return `unknown intent: "${bad}". Allowed: ${VALID_INTENTS.join(', ')}`;
  }
  return null;
}

export async function GET(request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  }
  try {
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ data: [] });

    const { data, error } = await supabase
      .from('ai_agents')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Error listing ai_agents:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  try {
    const body = await request.json();
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant configured' }, { status: 404 });

    const payload = buildPayload(body);
    const err = validate(payload, { isCreate: true });
    if (err) return NextResponse.json({ error: err }, { status: 400 });

    payload.tenant_id = tenantId;
    if (payload.enabled === undefined) payload.enabled = true;

    const { data, error } = await supabase
      .from('ai_agents')
      .insert([payload])
      .select()
      .single();
    if (error) {
      const friendly = error.code === '23505'
        ? `An agent named "${payload.name}" already exists for this tenant.`
        : error.message;
      return NextResponse.json({ error: friendly }, { status: 400 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error('Error creating ai_agent:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const tenantId = await getTenantId(request);

    const payload = buildPayload(body);
    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    const err = validate(payload);
    if (err) return NextResponse.json({ error: err }, { status: 400 });

    const { data, error } = await supabase
      .from('ai_agents')
      .update(payload)
      .eq('id', body.id)
      .eq('tenant_id', tenantId)
      .select()
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data)  return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json({ data });
  } catch (err) {
    console.error('Error updating ai_agent:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const tenantId = await getTenantId(request);

    // If this agent is referenced as tenant default or any journey default,
    // clear those references before delete (FK is on delete set null, so
    // this is just a UX nudge — actually it's automatic; nothing to do).
    const { error } = await supabase.from('ai_agents').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting ai_agent:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
