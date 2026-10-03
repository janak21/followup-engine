import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role key missing. Add SUPABASE_SERVICE_ROLE_KEY and restart.' },
      { status: 503 }
    );
  }
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('id, name, slug, status')
      .order('created_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Unexpected error fetching tenants:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role key missing.' },
      { status: 503 }
    );
  }
  
  try {
    const body = await request.json();
    const { name, team_alert_email, timezone } = body;
    
    if (!name) {
      return NextResponse.json({ error: 'Tenant name is required' }, { status: 400 });
    }
    
    // Generate a simple slug from the name
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    
    // Insert new tenant with defaults
    const { data, error } = await supabase
      .from('tenants')
      .insert([
        {
          name,
          slug,
          timezone: timezone || 'America/New_York',
          team_alert_email: team_alert_email || null,
        }
      ])
      .select()
      .single();
      
    if (error) {
      if (error.code === '23505') { // Unique violation
        return NextResponse.json({ error: 'A tenant with a similar name already exists.' }, { status: 400 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    
    return NextResponse.json({ data });
  } catch (err) {
    console.error('Error creating tenant:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
