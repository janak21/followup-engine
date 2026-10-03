// GET /api/retell-phone-numbers — read-only list of phone numbers synced
// from Retell for the calling tenant. Source of truth is the retell_phone_numbers
// table, populated by /api/retell-agents/sync.

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';

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
      .from('retell_phone_numbers')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('phone_number', { ascending: true });
    if (!includeInactive) q = q.eq('active', true);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Error fetching retell phone numbers:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
