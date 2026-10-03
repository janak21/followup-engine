// /api/operations
//
// One endpoint, multiple sections. Read-only summary of system state for
// the Operations dashboard. Tenant-scoped, operator-required.
//
// Sections:
//   * pipeline   — counts of actions by (action_type, status)
//   * stuck      — actions in_progress past locked_until + 60s (would
//                  trigger stale-action recovery on next dispatcher tick)
//   * recent_failures — actions failed in last 24h with reason
//   * ai_24h     — ai_reply_events last 24h: replied/escalated/failed/cost
//   * cron       — cron.job last run status + next planned (best-effort,
//                  pg_cron exposes job_run_details)
//   * recent_pg_net — last 20 pg_net responses (success/error counts last hour)
//
// The single endpoint keeps the page snappy (one request) and lets the
// SQL run as a tenant-scoped transaction.

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function GET(request) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });

  try {
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant' }, { status: 404 });

    // 1. Pipeline counts by (action_type, status)
    const { data: pipelineRows, error: pErr } = await supabase
      .from('actions')
      .select('action_type, status')
      .eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 7 * 86400_000).toISOString())
      .limit(5000);
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
    const pipeline = {};
    for (const r of pipelineRows || []) {
      const key = `${r.action_type}__${r.status}`;
      pipeline[key] = (pipeline[key] || 0) + 1;
    }

    // 2. Stuck actions — in_progress past locked_until + 60s
    const { data: stuck, error: sErr } = await supabase
      .from('actions')
      .select('id, action_type, lead_id, locked_by, locked_until, run_at, error_message, retry_count')
      .eq('tenant_id', tenantId)
      .eq('status', 'in_progress')
      .lt('locked_until', new Date(Date.now() - 60_000).toISOString())
      .order('locked_until', { ascending: true })
      .limit(50);
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });

    // 3. Recent failures (24h)
    const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: failures, error: fErr } = await supabase
      .from('actions')
      .select('id, action_type, lead_id, status, error_message, retry_count, run_at, completed_at')
      .eq('tenant_id', tenantId)
      .in('status', ['failed', 'failed_permanent', 'cancelled'])
      .gte('created_at', since24h)
      .order('completed_at', { ascending: false, nullsFirst: false })
      .limit(50);
    if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 });

    // 4. AI activity 24h
    const { data: aiEvents, error: aErr } = await supabase
      .from('ai_reply_events')
      .select('id, intent, confidence, escalation_reason, outbound_action_id, cost_estimate_usd, created_at, agent_id, lead_id')
      .eq('tenant_id', tenantId)
      .gte('created_at', since24h)
      .order('created_at', { ascending: false })
      .limit(50);
    if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 });

    const ai_24h = {
      replied:    (aiEvents || []).filter((e) => !e.escalation_reason && e.outbound_action_id).length,
      escalated:  (aiEvents || []).filter((e) =>  e.escalation_reason && !e.escalation_reason.startsWith('llm_error')).length,
      failed:     (aiEvents || []).filter((e) =>  e.escalation_reason && e.escalation_reason.startsWith('llm_error')).length,
      cost_usd:   (aiEvents || []).reduce((s, e) => s + Number(e.cost_estimate_usd || 0), 0),
      recent:     aiEvents || [],
    };

    // 5. pg_cron — needs the cron schema. Wrap in try.
    let cron = [];
    try {
      const { data: cronRows } = await supabase.rpc('ops_cron_summary');
      cron = cronRows || [];
    } catch (_) { /* cron not visible to this role; ignore */ }

    // 6. pg_net last-hour responses
    let pgNet = [];
    try {
      const { data: netRows } = await supabase.rpc('ops_pg_net_recent');
      pgNet = netRows || [];
    } catch (_) { /* ignore */ }

    // 7. Tenant + agent state — surface gotchas in the UI
    const { data: tenant } = await supabase
      .from('tenants').select('id, ai_replies_enabled, default_ai_agent_id').eq('id', tenantId).maybeSingle();
    let defaultAgent = null;
    if (tenant?.default_ai_agent_id) {
      const { data: a } = await supabase.from('ai_agents')
        .select('id, name, enabled, provider, model').eq('id', tenant.default_ai_agent_id).maybeSingle();
      defaultAgent = a;
    }
    const agentCredOk = await (async () => {
      if (!defaultAgent?.provider) return false;
      const { data: c } = await supabase.from('tenant_credentials')
        .select('id').eq('tenant_id', tenantId).eq('provider', defaultAgent.provider).eq('active', true).maybeSingle();
      return !!c;
    })();

    return NextResponse.json({
      data: {
        pipeline,
        stuck:           stuck || [],
        recent_failures: failures || [],
        ai_24h,
        cron,
        pg_net_recent:   pgNet,
        ai_status: {
          replies_enabled:   !!tenant?.ai_replies_enabled,
          default_agent:     defaultAgent,
          provider_creds_ok: agentCredOk,
        },
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('ops error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

// POST — bulk operator actions (reset stuck, retry failed).
export async function POST(request) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });

  try {
    const body = await request.json();
    const op = body?.op;
    const ids = Array.isArray(body?.action_ids) ? body.action_ids : [];
    if (!op) return NextResponse.json({ error: 'op required' }, { status: 400 });
    if (ids.length === 0) return NextResponse.json({ error: 'action_ids required' }, { status: 400 });

    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant' }, { status: 404 });

    if (op === 'reset_pending') {
      // Reset to pending, clear lock + retries so the dispatcher fires it
      // on the next tick. Useful for stuck/failed rows the operator wants
      // to give another shot.
      const { data, error } = await supabase.from('actions')
        .update({
          status: 'pending',
          run_at: new Date().toISOString(),
          locked_until: null,
          locked_by: null,
          retry_count: 0,
          error_message: null,
        })
        .eq('tenant_id', tenantId)
        .in('id', ids)
        .select('id, status');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ data, ok: true, count: data?.length || 0 });
    }

    if (op === 'cancel') {
      const { data, error } = await supabase.from('actions')
        .update({
          status: 'cancelled',
          locked_until: null,
          locked_by: null,
          error_message: 'Cancelled by operator from Operations page',
        })
        .eq('tenant_id', tenantId)
        .in('id', ids)
        .select('id, status');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ data, ok: true, count: data?.length || 0 });
    }

    if (op === 'flush_dispatcher') {
      // Manually fire dispatch_pending_actions one round.
      const { data, error } = await supabase.rpc('dispatch_pending_actions', { worker_id: 'ops-page', batch_size: 100 });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ data, ok: true });
    }

    return NextResponse.json({ error: `unknown op: ${op}` }, { status: 400 });
  } catch (err) {
    console.error('ops POST error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
