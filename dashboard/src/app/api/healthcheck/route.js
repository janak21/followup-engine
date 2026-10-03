import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';

export async function GET() {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const checks = {};

  // Tenants probe
  try {
    const { error, count } = await supabase.from('tenants').select('id', { count: 'exact', head: true });
    checks.tenants = { ok: !error, count: count || 0, error: error?.message || null };
  } catch (err) {
    checks.tenants = { ok: false, error: err.message };
  }

  // Leads probe
  try {
    const { data, error, count } = await supabase.from('leads').select('id', { count: 'exact', head: true });
    checks.leads = { ok: !error, total_count: count || 0, error: error?.message || null };
  } catch (err) {
    checks.leads = { ok: false, error: err.message };
  }

  // Journeys probe
  try {
    const { error, count } = await supabase.from('journeys').select('id', { count: 'exact', head: true });
    checks.journeys = { ok: !error, count: count || 0, error: error?.message || null };
  } catch (err) {
    checks.journeys = { ok: false, error: err.message };
  }

  const usingServiceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  const diagnosis = !env.NEXT_PUBLIC_SUPABASE_URL
    ? 'NEXT_PUBLIC_SUPABASE_URL not set. Add it to .env.local and restart.'
    : !usingServiceRole
      ? 'SUPABASE_SERVICE_ROLE_KEY missing. The dashboard is using the anon key. RLS will block almost all reads. Add the service_role key (not the publishable key) to .env.local and restart.'
      : checks.leads.total_count === 0 && checks.tenants.count === 0
        ? 'Service role key looks set but Supabase returned 0 rows. Check that you are pointing at the right project (NEXT_PUBLIC_SUPABASE_URL).'
        : 'OK';

  return NextResponse.json({
    diagnosis,
    using_service_role_key: usingServiceRole,
    env,
    checks,
  });
}
