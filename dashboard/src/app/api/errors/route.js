import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.SUPABASE_SERVICE_ROLE_KEY || !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export async function GET(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' },
      { status: 503 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const tenantId = await getTenantId(request);
    const severity = searchParams.get('severity');
    const status = searchParams.get('status');
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 500);
    const grouped = searchParams.get('grouped') === '1';

    // Grouped view collapses repeating errors so N occurrences of the same
    // signature appear as one row with count + first/last seen.
    if (grouped) {
      const { data, error } = await supabase.rpc('error_groups', {
        p_tenant_id: tenantId,
        p_limit: limit,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ data: data || [] });
    }

    let q = supabase
      .from('error_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (tenantId) q = q.eq('tenant_id', tenantId);
    if (severity) q = q.eq('severity', severity);
    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  try {
    const { id, status } = await request.json();
    if (!id || !status) {
      return NextResponse.json({ error: 'id and status required' }, { status: 400 });
    }
    const tenantId = await getTenantId(request);
    const { data, error } = await supabase
      .from('error_logs')
      .update({ status })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
