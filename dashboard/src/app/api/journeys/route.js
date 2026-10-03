import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { getMockJourneys, addMockJourney, editMockJourney, deleteMockJourney } from '@/utils/mockDb';
import { requireOperator } from "@/utils/role";

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function maxIso(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return new Date(candidate).getTime() > new Date(current).getTime() ? candidate : current;
}

async function attachJourneyMetrics(tenantId, journeys) {
  if (!journeys.length) return journeys;

  const keys = journeys.map((j) => j.journey_key).filter(Boolean);
  if (!keys.length) {
    return journeys.map((j) => ({ ...j, metrics: null }));
  }

  const metricsByKey = new Map(keys.map((key) => [key, {
    running_leads: 0,
    replied_leads: 0,
    failed_actions: 0,
    last_activity_at: null,
  }]));

  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, journey_template, journey_status, responded, created_at, updated_at, last_action_at')
    .eq('tenant_id', tenantId)
    .in('journey_template', keys);

  if (leadsError) {
    console.warn('Failed to load journey list lead metrics:', leadsError.message);
    return journeys.map((j) => ({ ...j, metrics: null }));
  }

  const leadJourneyById = new Map();
  for (const lead of leads || []) {
    const key = lead.journey_template;
    const metrics = metricsByKey.get(key);
    if (!metrics) continue;

    leadJourneyById.set(lead.id, key);
    if (lead.journey_status === 'active') metrics.running_leads += 1;
    if (lead.responded) metrics.replied_leads += 1;
    metrics.last_activity_at = maxIso(metrics.last_activity_at, lead.last_action_at || lead.updated_at || lead.created_at);
  }

  const leadIds = [...leadJourneyById.keys()];
  if (leadIds.length > 0) {
    const { data: failedActions, error: actionsError } = await supabase
      .from('actions')
      .select('id, lead_id, status, created_at, completed_at, payload')
      .in('lead_id', leadIds)
      .in('status', ['failed', 'failed_permanent']);

    if (actionsError) {
      console.warn('Failed to load journey list action metrics:', actionsError.message);
    } else {
      for (const action of failedActions || []) {
        const key = action.payload?.enrolled_via || leadJourneyById.get(action.lead_id);
        const metrics = metricsByKey.get(key);
        if (!metrics) continue;
        metrics.failed_actions += 1;
        metrics.last_activity_at = maxIso(metrics.last_activity_at, action.completed_at || action.created_at);
      }
    }
  }

  return journeys.map((journey) => ({
    ...journey,
    metrics: metricsByKey.get(journey.journey_key) || null,
  }));
}



export async function GET(request) {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: 'Supabase service role key is missing. Add SUPABASE_SERVICE_ROLE_KEY to .env.local and restart.' },
        { status: 503 }
      );
    }

    const tenantId = await getTenantId(request);
    const { searchParams } = new URL(request.url);
    // Drafts (active=false) are useful in the builder list. Toggle them in by
    // passing ?include_inactive=1; default keeps the legacy active-only view.
    const includeInactive = searchParams.get('include_inactive') === '1';
    const includeMetrics = searchParams.get('include_metrics') === '1';
    let q = supabase
      .from('journeys')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('journey_key', { ascending: true });
    if (!includeInactive) q = q.eq('active', true);
    const { data, error } = await q;

    if (error) {
      console.error('Failed to fetch journeys from Supabase:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = includeMetrics ? await attachJourneyMetrics(tenantId, data || []) : (data || []);

    return NextResponse.json({ data: rows });
  } catch (err) {
    console.error('Unexpected error fetching journeys:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const body = await request.json();
    const { journey_key, name, spec, active, ai_agent_id } = body;

    if (!journey_key || !name) {
      return NextResponse.json({ error: 'journey_key and name are required' }, { status: 400 });
    }

    // Default basic spec if none provided
    const journeySpec = spec || {
      key: journey_key,
      name: name,
      trigger: 'lead.enrolled',
      steps: [],
      exit_conditions: []
    };

    if (!isSupabaseConfigured()) {
      const newJ = addMockJourney({ journey_key, name, active, spec: journeySpec });
      return NextResponse.json({ data: newJ });
    }

    const tenantId = await getTenantId(request);
    const journeyInsert = {
      tenant_id: tenantId,
      journey_key,
      name,
      spec: journeySpec,
      active: active ?? true,
      // Per-journey AI agent override. NULL = use tenant default when the
      // dispatcher asks "which agent should reply to this lead?". Explicit
      // agent_id here scopes AI replies for this journey to a specific
      // use-case (Speed-to-Lead / Reactivation / Cold Follow-up / etc.).
      ai_agent_id: ai_agent_id || null,
    };

    const { data, error } = await supabase
      .from('journeys')
      .insert([journeyInsert])
      .select();

    if (error) {
      console.warn('Failed to insert journey in Supabase, using mock DB:', error.message);
      const newJ = addMockJourney({ journey_key, name, active, spec: journeySpec });
      return NextResponse.json({ data: newJ });
    }

    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error in POST journeys:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const body = await request.json();
    const { id, journey_key, name, spec, active, paused, ai_agent_id } = body;

    if (!id) {
      return NextResponse.json({ error: 'Journey ID is required' }, { status: 400 });
    }

    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: 'Supabase service role key is missing. Add SUPABASE_SERVICE_ROLE_KEY to .env.local and restart.' },
        { status: 503 }
      );
    }
    const tenantId = await getTenantId(request);

    const journeyUpdate = {
      journey_key,
      name,
      active,
      // PHASE6: paused is a direct column (like active), not versioned.
      paused,
      // Undefined = don't touch. Explicit null = clear the override (fall
      // back to tenant default). Explicit uuid = pin to a specific agent.
      ai_agent_id,
    };

    // Phase 5: spec edits land in draft_spec — the engine reads spec only.
    // Publishing is the sole path that promotes draft -> spec (RPC).
    if (spec !== undefined) {
      journeyUpdate.draft_spec = spec;
      journeyUpdate.draft_updated_at = new Date().toISOString();
    }

    // Remove undefined fields
    Object.keys(journeyUpdate).forEach(key => journeyUpdate[key] === undefined && delete journeyUpdate[key]);

    const { data, error } = await supabase
      .from('journeys')
      .update(journeyUpdate)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error in PUT journeys:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Journey ID is required' }, { status: 400 });
    }

    if (!isSupabaseConfigured()) {
      const success = deleteMockJourney(id);
      return NextResponse.json({ success });
    }
    const tenantId = await getTenantId(request);

    const { error } = await supabase
      .from('journeys')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) {
      console.warn('Failed to delete journey in Supabase, deleting from mock DB:', error.message);
      const success = deleteMockJourney(id);
      return NextResponse.json({ success });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE journeys:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
