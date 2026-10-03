// /api/ai-agents/[id]/knowledge
//
// CRUD for KB snippets owned by one agent. Always tenant-scoped via the
// parent agent's tenant_id (we re-check on every write to prevent
// cross-tenant edits through guessed agent ids).
//
// GET    — list active KB items for the agent
// POST   — create one  ({ title, content, sort_order?, active? })
// PUT    — update one  ({ id, ... })
// DELETE — remove one  (?item_id=...)

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function resolveAgent(agentId, tenantId) {
  const { data: agent, error } = await supabase
    .from('ai_agents')
    .select('id, tenant_id')
    .eq('id', agentId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!agent) return { error: 'Agent not found' };
  if (agent.tenant_id !== tenantId) return { error: 'Agent does not belong to this tenant' };
  return { agent };
}

export async function GET(request, { params }) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  try {
    const { id: agentId } = await params;
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ data: [] });

    const { agent, error: aErr } = await resolveAgent(agentId, tenantId);
    if (aErr) return NextResponse.json({ error: aErr }, { status: 404 });

    const { data, error } = await supabase
      .from('ai_agent_knowledge')
      .select('*')
      .eq('agent_id', agent.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Error listing KB:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  try {
    const { id: agentId } = await params;
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant configured' }, { status: 404 });

    const { agent, error: aErr } = await resolveAgent(agentId, tenantId);
    if (aErr) return NextResponse.json({ error: aErr }, { status: 404 });

    const body = await request.json();
    const title   = (body?.title   || '').trim();
    const content = (body?.content || '').trim();
    if (!title)   return NextResponse.json({ error: 'title is required' }, { status: 400 });
    if (!content) return NextResponse.json({ error: 'content is required' }, { status: 400 });

    const row = {
      agent_id:   agent.id,
      title,
      content,
      active:     body?.active === undefined ? true : !!body.active,
      sort_order: Number.isFinite(body?.sort_order) ? body.sort_order : 0,
    };
    const { data, error } = await supabase
      .from('ai_agent_knowledge')
      .insert([row])
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (err) {
    console.error('Error creating KB:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  try {
    const { id: agentId } = await params;
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant configured' }, { status: 404 });

    const { agent, error: aErr } = await resolveAgent(agentId, tenantId);
    if (aErr) return NextResponse.json({ error: aErr }, { status: 404 });

    const body = await request.json();
    if (!body?.id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const updates = {};
    if (body.title       !== undefined) updates.title      = String(body.title).trim();
    if (body.content     !== undefined) updates.content    = String(body.content).trim();
    if (body.active      !== undefined) updates.active     = !!body.active;
    if (body.sort_order  !== undefined && Number.isFinite(body.sort_order)) updates.sort_order = body.sort_order;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('ai_agent_knowledge')
      .update(updates)
      .eq('id', body.id)
      .eq('agent_id', agent.id)  // belt + suspenders: enforce ownership
      .select()
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data)  return NextResponse.json({ error: 'KB item not found' }, { status: 404 });
    return NextResponse.json({ data });
  } catch (err) {
    console.error('Error updating KB:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  try {
    const { id: agentId } = await params;
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant configured' }, { status: 404 });

    const { agent, error: aErr } = await resolveAgent(agentId, tenantId);
    if (aErr) return NextResponse.json({ error: aErr }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get('item_id');
    if (!itemId) return NextResponse.json({ error: 'item_id is required' }, { status: 400 });

    const { error } = await supabase
      .from('ai_agent_knowledge')
      .delete()
      .eq('id', itemId)
      .eq('agent_id', agent.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting KB:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
