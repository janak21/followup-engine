// POST /api/ai-agents/[id]/playground
//
// Operator-only proxy to the generate-ai-reply edge function in dry_run mode.
// Lets the operator test agent prompt + KB + escalation rules on a pasted
// sample inbound WITHOUT any DB writes (no actions, no events, no audit row).
//
// Body: {
//   overrides?: { system_prompt, provider, model, temperature, max_tokens,
//                 escalate_on_intents, confidence_threshold },  // unsaved tweaks
//   inbound: { subject?, body },                                // required
//   history?: [{ direction: 'inbound'|'outbound', body }],      // optional
//   lead?:   { first_name?, last_name?, email?,
//              email_conversation_count? },                     // optional
// }
//
// Returns the LLM decision (intent, confidence, reasoning, reply) +
// escalation result + token + cost.

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';
import { getEdgeAuthHeader, getEdgeFunctionUrl, isUsingDispatchKey } from '@/utils/edge-auth';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function POST(request, { params }) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });

  try {
    const { id: agentId } = await params;
    if (!agentId) return NextResponse.json({ error: 'agent id required' }, { status: 400 });

    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant' }, { status: 404 });

    // Verify the agent belongs to this tenant (prevent cross-tenant probing).
    const { data: agent } = await supabase
      .from('ai_agents').select('id, tenant_id, name').eq('id', agentId).maybeSingle();
    if (!agent)                         return NextResponse.json({ error: 'agent not found' }, { status: 404 });
    if (agent.tenant_id !== tenantId)   return NextResponse.json({ error: 'agent does not belong to this tenant' }, { status: 403 });

    const body = await request.json();
    if (!body?.inbound?.body) return NextResponse.json({ error: 'inbound.body required' }, { status: 400 });

    // Forward to edge fn with dry_run flag. Auth via centralized helper:
    // prefers INTERNAL_DISPATCH_KEY (stable, we control), falls back to
    // SUPABASE_SERVICE_ROLE_KEY (rotated by Supabase, can go stale).
    let authHeader, edgeUrl;
    try {
      authHeader = getEdgeAuthHeader();
      edgeUrl = getEdgeFunctionUrl('generate-ai-reply');
    } catch (err) {
      return NextResponse.json({ error: err.message, stage: 'config' }, { status: 503 });
    }

    let res;
    try {
      res = await fetch(edgeUrl, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dry_run: true,
          agent_id: agentId,
          overrides: body.overrides || {},
          inbound:   body.inbound,
          history:   Array.isArray(body.history) ? body.history : [],
          lead:      body.lead || {},
        }),
      });
    } catch (err) {
      return NextResponse.json({ error: `Network error reaching edge function: ${err?.message || String(err)}`, stage: 'edge_fetch' }, { status: 502 });
    }

    // Read body once. Handle both JSON and non-JSON responses so the operator
    // gets the actual error text instead of an empty {}.
    const rawText = await res.text();
    let j = {};
    try { j = rawText ? JSON.parse(rawText) : {}; } catch { j = { error: rawText.slice(0, 500) }; }

    if (!res.ok || !j?.ok) {
      // Surface a precise error so the operator (you) can act on it.
      const err = j?.error || `Edge function HTTP ${res.status}`;
      // Translate the most common 401 → actionable message.
      const authVar = isUsingDispatchKey() ? 'INTERNAL_DISPATCH_KEY' : 'SUPABASE_SERVICE_ROLE_KEY';
      const friendly = res.status === 401
        ? `Edge function rejected our auth (401). The ${authVar} in your Next.js .env.local doesn't match what the edge function expects. ${
            isUsingDispatchKey()
              ? 'Verify the same value is set in (a) .env.local, (b) Postgres Vault secret named internal_dispatch_key, (c) Edge Function Secrets in Supabase Dashboard.'
              : 'Restart your dev server after updating .env.local with the current service role key from Supabase Dashboard → Settings → API.'
          }`
        : err;
      return NextResponse.json({ error: friendly, stage: j?.stage || 'edge_response', raw: process.env.NODE_ENV === 'development' ? j : undefined }, { status: res.status });
    }
    return NextResponse.json({ data: j });
  } catch (err) {
    console.error('playground error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
