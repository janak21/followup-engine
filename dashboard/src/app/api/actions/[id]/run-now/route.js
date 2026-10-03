import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import { getTenantId } from '@/utils/tenant';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// POST /api/actions/{id}/run-now
// Resets a pending action to fire immediately. Useful for testing — bypasses any
// previously rescheduled run_at. Returns the updated row.
export async function POST(request, { params }) {
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
    const tenantId = await getTenantId(request);

    // Only act on rows that are pending or already failed/skipped — never on in_progress (race risk).
    const { data: action, error: readErr } = await supabase
      .from('actions')
      .select('id, status, action_type, lead_id, run_at')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    if (!action) return NextResponse.json({ error: 'Action not found' }, { status: 404 });

    if (action.status === 'completed') {
      return NextResponse.json({ error: 'Action already completed' }, { status: 400 });
    }
    if (action.status === 'in_progress') {
      return NextResponse.json(
        { error: 'Action is currently in progress. Wait for it to finish or expire its lock.' },
        { status: 409 }
      );
    }

    const { data, error } = await supabase
      .from('actions')
      .update({
        status: 'pending',
        run_at: new Date().toISOString(),
        locked_until: null,
        locked_by: null,
        last_skip_reason: null,
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      data,
      message: 'Action set to run immediately. The dispatcher will pick it up within ~1 minute.',
    });
  } catch (err) {
    console.error('Error in run-now:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
