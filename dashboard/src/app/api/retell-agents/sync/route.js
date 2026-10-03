// POST /api/retell-agents/sync
//
// Pulls the canonical list of agents + phone numbers from Retell's API and
// reconciles into retell_agents and retell_phone_numbers for the calling
// tenant. Idempotent: upsert by (tenant_id, agent_id/phone_number); rows
// missing from the Retell response are soft-deactivated (active=false)
// so historical references remain intact but the dropdowns hide them.
//
// Reads the tenant's Retell API key from tenant_credentials.config.api_key.
//
// Error surfacing: every internal step that can fail returns a structured
// JSON body with the underlying message so the browser console shows what
// actually went wrong, not an opaque 500.

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

const RETELL_BASE = 'https://api.retellai.com';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function fail(stage, message, extra = {}) {
  // Mirror the failure to the server log AND return it to the client.
  console.error(`[retell-sync] ${stage}:`, message, extra);
  return NextResponse.json({ error: message, stage, ...extra }, { status: 500 });
}

async function retellFetch(path, apiKey) {
  let res, text, body;
  try {
    res = await fetch(`${RETELL_BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error calling Retell: ${err.message}` };
  }
  try { text = await res.text(); body = text ? JSON.parse(text) : null; }
  catch { body = text; }
  if (!res.ok) {
    return { ok: false, status: res.status, body, error: typeof body === 'string' ? body : (body?.message || `HTTP ${res.status}`) };
  }
  return { ok: true, status: res.status, body };
}

export async function POST(request) {
  // Top-level catch so even an unhandled throw returns a JSON body the
  // browser can read, instead of Next.js's opaque 500 HTML page.
  try {
    return await handleSync(request);
  } catch (err) {
    console.error('[retell-sync] unhandled:', err);
    return NextResponse.json({
      error: err?.message || 'Unhandled error in sync route',
      stage: 'unhandled',
      stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
    }, { status: 500 });
  }
}

async function handleSync(request) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }

  let tenantId;
  try {
    tenantId = await getTenantId(request);
  } catch (err) {
    return fail('tenant_resolution', err.message);
  }
  if (!tenantId) {
    return NextResponse.json({ error: 'No tenant found for this session.' }, { status: 404 });
  }

  // 1. Read API key.
  const { data: creds, error: credsErr } = await supabase
    .from('tenant_credentials')
    .select('id, config')
    .eq('tenant_id', tenantId)
    .eq('provider', 'retell')
    .eq('active', true)
    .maybeSingle();
  if (credsErr) return fail('read_credentials', credsErr.message);
  const apiKey = creds?.config?.api_key;
  if (!apiKey) {
    return NextResponse.json({
      error: 'Retell API key missing on the active Retell credential. Add it in Settings → Credentials → Retell.',
    }, { status: 400 });
  }

  // 2. Pull agents.
  const agentsRes = await retellFetch('/list-agents?limit=1000', apiKey);
  if (!agentsRes.ok) {
    return NextResponse.json({
      error: `Retell list-agents failed: ${agentsRes.error}`,
      http_status: agentsRes.status,
      details: agentsRes.body,
    }, { status: 502 });
  }
  // Retell currently returns an array; be defensive about shape changes.
  const agents = Array.isArray(agentsRes.body)
    ? agentsRes.body
    : Array.isArray(agentsRes.body?.data) ? agentsRes.body.data : [];

  // Retell list-agents emits one row PER AGENT VERSION (same agent_id, different
  // version numbers). Postgres ON CONFLICT DO UPDATE can't touch the same row
  // twice in one statement → reduce to one row per agent_id. Preference order:
  //   1. published versions (is_published === true)
  //   2. highest version number
  //   3. highest last_modification_timestamp
  // Stable across syncs: the same source row wins each time.
  const bestByAgentId = new Map();
  for (const a of agents) {
    if (!a || !a.agent_id) continue;
    const existing = bestByAgentId.get(a.agent_id);
    if (!existing) { bestByAgentId.set(a.agent_id, a); continue; }
    const aPub = a.is_published === true ? 1 : 0;
    const ePub = existing.is_published === true ? 1 : 0;
    if (aPub !== ePub) {
      if (aPub > ePub) bestByAgentId.set(a.agent_id, a);
      continue;
    }
    const aVer = typeof a.version === 'number' ? a.version : -1;
    const eVer = typeof existing.version === 'number' ? existing.version : -1;
    if (aVer !== eVer) {
      if (aVer > eVer) bestByAgentId.set(a.agent_id, a);
      continue;
    }
    const aTs = typeof a.last_modification_timestamp === 'number' ? a.last_modification_timestamp : 0;
    const eTs = typeof existing.last_modification_timestamp === 'number' ? existing.last_modification_timestamp : 0;
    if (aTs > eTs) bestByAgentId.set(a.agent_id, a);
  }
  const dedupedAgents = Array.from(bestByAgentId.values());

  const agentRows = dedupedAgents.map(a => ({
    tenant_id:      tenantId,
    agent_id:       a.agent_id,
    name:           a.agent_name || a.agent_id,
    voice_id:       a.voice_id || null,
    language:       a.language || null,
    description:    a.version_description || null,
    active:         true,
    last_synced_at: new Date().toISOString(),
    raw:            a,
  }));

  // Soft-deactivation strategy that avoids the fragile .not('column','in', list)
  // syntax: first set every row for this tenant to inactive, then upsert the
  // synced rows with active=true. Two writes, deterministic outcome, and the
  // upsert restores active for everything still present in Retell.
  const { error: deactivateAgentsErr } = await supabase
    .from('retell_agents')
    .update({ active: false })
    .eq('tenant_id', tenantId);
  if (deactivateAgentsErr) return fail('deactivate_agents', deactivateAgentsErr.message);

  if (agentRows.length > 0) {
    const { error: upsertErr } = await supabase
      .from('retell_agents')
      .upsert(agentRows, { onConflict: 'tenant_id,agent_id' });
    if (upsertErr) return fail('upsert_agents', upsertErr.message, { sample_row: agentRows[0] });
  }

  // 3. Pull phone numbers — non-fatal if it fails (agents are the primary).
  const phonesRes = await retellFetch('/list-phone-numbers', apiKey);
  let phoneRows = [];
  let phoneError = null;
  if (!phonesRes.ok) {
    phoneError = `Retell list-phone-numbers failed: ${phonesRes.error} (HTTP ${phonesRes.status})`;
  } else {
    const phones = Array.isArray(phonesRes.body)
      ? phonesRes.body
      : Array.isArray(phonesRes.body?.data) ? phonesRes.body.data : [];
    // Defensive: dedupe by phone_number in case Retell ever returns duplicates.
    const phoneByNumber = new Map();
    for (const p of phones) {
      if (p && p.phone_number) phoneByNumber.set(p.phone_number, p);
    }
    phoneRows = Array.from(phoneByNumber.values())
      .map(p => ({
        tenant_id:           tenantId,
        phone_number:        p.phone_number,
        phone_number_pretty: p.phone_number_pretty || null,
        nickname:            p.nickname || null,
        inbound_agent_id:    p.inbound_agent_id || null,
        outbound_agent_id:   p.outbound_agent_id || null,
        area_code:           typeof p.area_code === 'number' ? p.area_code : null,
        active:              true,
        last_synced_at:      new Date().toISOString(),
        raw:                 p,
      }));

    const { error: deactivatePhonesErr } = await supabase
      .from('retell_phone_numbers')
      .update({ active: false })
      .eq('tenant_id', tenantId);
    if (deactivatePhonesErr) {
      phoneError = `Failed to deactivate stale phone rows: ${deactivatePhonesErr.message}`;
    } else if (phoneRows.length > 0) {
      const { error: phUpsertErr } = await supabase
        .from('retell_phone_numbers')
        .upsert(phoneRows, { onConflict: 'tenant_id,phone_number' });
      if (phUpsertErr) {
        phoneError = `Failed to upsert phone numbers: ${phUpsertErr.message}`;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    agents_synced:        agentRows.length,
    phone_numbers_synced: phoneRows.length,
    phone_error:          phoneError,
    agents:               agentRows.map(r => ({ agent_id: r.agent_id, name: r.name })),
    phone_numbers:        phoneRows.map(r => ({ phone_number: r.phone_number, nickname: r.nickname })),
  });
}
