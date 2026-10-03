import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";

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
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) {
      return NextResponse.json({ error: 'No tenant configured' }, { status: 404 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error('Unexpected error fetching tenant:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role key missing. Add SUPABASE_SERVICE_ROLE_KEY and restart.' },
      { status: 503 }
    );
  }
  try {
    const body = await request.json();
    const {
      id, name, timezone, business_hours, team_alert_email, config, channel_pauses,
      // AI controls (Phase 1)
      ai_replies_enabled, default_ai_agent_id,
    } = body;

    let tenantId = id;
    if (!tenantId) {
      tenantId = await getTenantId(request);
    }

    const tenantUpdate = {
      name, timezone, business_hours, team_alert_email, config, channel_pauses,
      ai_replies_enabled, default_ai_agent_id,
    };
    Object.keys(tenantUpdate).forEach(k => tenantUpdate[k] === undefined && delete tenantUpdate[k]);

    if (Object.keys(tenantUpdate).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    if (tenantUpdate.business_hours) {
      const bh = tenantUpdate.business_hours;
      if (!bh.start || !bh.end || !Array.isArray(bh.days) || bh.days.length === 0) {
        return NextResponse.json(
          { error: 'business_hours must have { start, end, days[] } with at least one day selected' },
          { status: 400 }
        );
      }
    }

    const { data, error } = await supabase
      .from('tenants')
      .update(tenantUpdate)
      .eq('id', tenantId)
      .select();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }
    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error in PUT tenant settings:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
