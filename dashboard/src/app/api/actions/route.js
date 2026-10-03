import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    const { data, error } = await supabase
      .from('actions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching actions:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('Unexpected error fetching actions:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
