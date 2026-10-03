import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import { getTenantId } from '@/utils/tenant';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// PUT /api/actions/{id}
// Updates the status and details of an action, and optionally calls the sequence engine to advance.
export async function PUT(request, { params }) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role key missing.' },
      { status: 503 }
    );
  }
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Action id required' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const { status, last_skip_reason, advance } = body;
    const tenantId = await getTenantId(request);

    // Retrieve action payload to resolve step specifications
    const { data: action, error: readErr } = await supabase
      .from('actions')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    if (!action) return NextResponse.json({ error: 'Action not found' }, { status: 404 });

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (last_skip_reason !== undefined) updateData.last_skip_reason = last_skip_reason;

    const { data: updatedAction, error: updateErr } = await supabase
      .from('actions')
      .update(updateData)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .maybeSingle();

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    let advancedActionId = null;
    if (advance) {
      // Find the outcome to advance the journey
      const outcomeObj = action.payload?.step_spec?.on_outcome || {};
      const outcomes = Object.keys(outcomeObj);
      const outcome = outcomes[0] || 'sent';

      // Call advance_journey RPC to queue the next step
      const { data: nextActionId, error: rpcErr } = await supabase.rpc('advance_journey', {
        p_action_id: id,
        p_outcome: outcome
      });

      if (rpcErr) {
        console.error('Error calling advance_journey RPC:', rpcErr);
      } else {
        advancedActionId = nextActionId;
      }
    }

    return NextResponse.json({
      data: updatedAction,
      advancedActionId,
      message: 'Action updated successfully.'
    });
  } catch (err) {
    console.error('Error in updating action:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
