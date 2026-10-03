// CRUD for the per-tenant Retell agent registry.
// Backed by the retell_agents table (migration 20260618000000_retell_agents.sql).
// Surface area:
//   GET    /api/retell-agents          → list active agents for current tenant
//   POST   /api/retell-agents          → create
//   PUT    /api/retell-agents          → update (by id)
//   DELETE /api/retell-agents?id=...   → hard delete (callers may also soft-delete via PUT active=false)
//
// Used by: settings page (manage list) and journey builder call node side panel (dropdown source).

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function GET(request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ data: [] });

    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get('include_inactive') === '1';

    let q = supabase
      .from('retell_agents')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });
    if (!includeInactive) q = q.eq('active', true);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Error fetching retell agents:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase configuration missing.' }, { status: 503 });
  }
  try {
    const body = await request.json();
    const { name, agent_id, from_number, description, active } = body;
    if (!name || !agent_id) {
      return NextResponse.json({ error: 'name and agent_id are required' }, { status: 400 });
    }
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant found' }, { status: 404 });

    const insert = {
      tenant_id: tenantId,
      name,
      agent_id,
      from_number: from_number || null,
      description: description || null,
      active: active ?? true,
    };
    const { data, error } = await supabase.from('retell_agents').insert([insert]).select();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: `Agent ID '${agent_id}' already exists for this tenant.` }, { status: 400 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error creating retell agent:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase configuration missing.' }, { status: 503 });
  }
  try {
    const body = await request.json();
    const { id, name, agent_id, from_number, description, active } = body;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (agent_id !== undefined) updates.agent_id = agent_id;
    if (from_number !== undefined) updates.from_number = from_number || null;
    if (description !== undefined) updates.description = description || null;
    if (active !== undefined) updates.active = active;

    const { data, error } = await supabase
      .from('retell_agents')
      .update(updates)
      .eq('id', id)
      .select();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || !data.length) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error updating retell agent:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase configuration missing.' }, { status: 503 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const { error } = await supabase.from('retell_agents').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting retell agent:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
