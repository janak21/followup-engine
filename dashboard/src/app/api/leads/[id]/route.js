import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";

export async function GET(request, { params }) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: 'Lead ID is required' }, { status: 400 });
    }

    const tenantId = await getTenantId(request);

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .maybeSingle();

    if (leadError) {
      console.error('Error fetching lead:', leadError);
      return NextResponse.json({ error: leadError.message }, { status: 500 });
    }

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    const { data: actions, error: actionsError } = await supabase
      .from('actions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('lead_id', id)
      .order('created_at', { ascending: false });

    if (actionsError) {
      console.error('Error fetching lead actions:', actionsError);
    }

    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('lead_id', id)
      .order('created_at', { ascending: false });

    if (eventsError) {
      console.error('Error fetching lead events:', eventsError);
    }

    return NextResponse.json({
      data: {
        lead,
        actions: actions || [],
        events: events || []
      }
    });
  } catch (err) {
    console.error('Unexpected error fetching lead detail:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Lead ID is required' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const {
      first_name,
      last_name,
      email,
      phone_e164,
      journey_status,
      raw_payload
    } = body;

    // Build the update object with only provided properties
    const updateData = {};
    if (first_name !== undefined) updateData.first_name = first_name;
    if (last_name !== undefined) updateData.last_name = last_name;
    if (email !== undefined) updateData.email = email;
    if (phone_e164 !== undefined) updateData.phone_e164 = phone_e164;
    if (journey_status !== undefined) updateData.journey_status = journey_status;
    if (raw_payload !== undefined) updateData.raw_payload = raw_payload;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No fields provided for update' }, { status: 400 });
    }

    const tenantId = await getTenantId(request);

    const { data: updatedLead, error: updateError } = await supabase
      .from('leads')
      .update(updateData)
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (updateError) {
      console.error('Error updating lead:', updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    if (!updatedLead) {
      return NextResponse.json({ error: 'Lead not found or update failed' }, { status: 404 });
    }

    return NextResponse.json({ data: updatedLead });
  } catch (err) {
    console.error('Unexpected error updating lead:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Lead ID is required' }, { status: 400 });
    }

    const tenantId = await getTenantId(request);

    const { error: deleteError, count } = await supabase
      .from('leads')
      .delete({ count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('id', id);

    if (deleteError) {
      console.error('Error deleting lead:', deleteError);
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ message: 'Lead deleted successfully' });
  } catch (err) {
    console.error('Unexpected error deleting lead:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
