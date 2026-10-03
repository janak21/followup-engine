import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import {
  SENDER_SAFE_COLUMNS,
  enrichSenders,
  fetchSenderIdsWithClientSecret,
} from '@/lib/senderColumns';

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request);
    // 1. Fetch Tenant configuration
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id, name, slug, status, timezone, business_hours, team_alert_email, config')
      .eq('id', tenantId)
      .maybeSingle();

    if (tenantError) {
      console.error('Error fetching tenant settings:', tenantError);
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // 2. Fetch Senders pool. Never select the plaintext secret columns — they
    // live in Vault now. We return only SENDER_SAFE_COLUMNS plus derived flags.
    const { data: senders, error: sendersError } = await supabase
      .from('senders')
      .select(SENDER_SAFE_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true });

    if (sendersError) {
      console.error('Error fetching senders:', sendersError);
      return NextResponse.json({ error: sendersError.message }, { status: 500 });
    }

    const secretSetIds = await fetchSenderIdsWithClientSecret(supabase, tenantId);
    const enrichedSenders = enrichSenders(senders, secretSetIds);

    // 3. Fetch Templates
    const { data: templates, error: templatesError } = await supabase
      .from('templates')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('template_key', { ascending: true })
      .order('version', { ascending: false });

    if (templatesError) {
      console.error('Error fetching templates:', templatesError);
      return NextResponse.json({ error: templatesError.message }, { status: 500 });
    }

    return NextResponse.json({
      data: {
        tenant,
        senders: enrichedSenders,
        templates: templates || []
      }
    });
  } catch (err) {
    console.error('Unexpected error fetching settings:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const tenantId = await getTenantId(request);
    const body = await request.json().catch(() => ({}));
    const { tenant, senders, templates } = body;

    // 1. Update Tenant settings if provided
    if (tenant) {
      const tenantUpdates = {};
      if (tenant.team_alert_email !== undefined) tenantUpdates.team_alert_email = tenant.team_alert_email;
      if (tenant.business_hours !== undefined) tenantUpdates.business_hours = tenant.business_hours;
      if (tenant.timezone !== undefined) tenantUpdates.timezone = tenant.timezone;
      if (tenant.config !== undefined) tenantUpdates.config = tenant.config;

      if (Object.keys(tenantUpdates).length > 0) {
        const { error: tenantError } = await supabase
          .from('tenants')
          .update(tenantUpdates)
          .eq('id', tenantId);

        if (tenantError) {
          console.error('Error updating tenant:', tenantError);
          return NextResponse.json({ error: `Failed to update tenant: ${tenantError.message}` }, { status: 500 });
        }
      }
    }

    // 2. Update Senders if provided
    if (Array.isArray(senders)) {
      for (const senderUpdate of senders) {
        if (!senderUpdate.id) continue;

        const senderData = {};
        if (senderUpdate.active !== undefined) senderData.active = senderUpdate.active;
        if (senderUpdate.daily_limit !== undefined) senderData.daily_limit = senderUpdate.daily_limit;
        if (senderUpdate.limit !== undefined) senderData.daily_limit = senderUpdate.limit; // support both keys

        if (Object.keys(senderData).length > 0) {
          const { error: senderError } = await supabase
            .from('senders')
            .update(senderData)
            .eq('tenant_id', tenantId)
            .eq('id', senderUpdate.id);

          if (senderError) {
            console.error(`Error updating sender ${senderUpdate.id}:`, senderError);
            return NextResponse.json({ error: `Failed to update sender ${senderUpdate.id}: ${senderError.message}` }, { status: 500 });
          }
        }
      }
    }

    // 3. Upsert Templates if provided
    if (Array.isArray(templates)) {
      for (const templateItem of templates) {
        // Ensure required fields are present
        if (!templateItem.template_key || !templateItem.body) {
          return NextResponse.json({ error: 'template_key and body are required for each template.' }, { status: 400 });
        }

        const templateData = {
          tenant_id: tenantId,
          template_key: templateItem.template_key,
          channel: templateItem.channel || 'email',
          subject: templateItem.subject || null,
          body: templateItem.body,
          variables: templateItem.variables || [],
          notes: templateItem.notes || null,
          version: templateItem.version || 1,
          active: templateItem.active !== undefined ? templateItem.active : true
        };

        if (templateItem.id) {
          const { error: templateError } = await supabase
            .from('templates')
            .update(templateData)
            .eq('tenant_id', tenantId)
            .eq('id', templateItem.id);

          if (templateError) {
            console.error(`Error updating template ${templateItem.id}:`, templateError);
            return NextResponse.json({ error: `Failed to update template ${templateItem.id}: ${templateError.message}` }, { status: 500 });
          }
        } else {
          const { error: templateError } = await supabase
            .from('templates')
            .upsert(templateData, { onConflict: 'tenant_id,template_key,version' });

          if (templateError) {
            console.error(`Error upserting template ${templateItem.template_key}:`, templateError);
            return NextResponse.json({ error: `Failed to upsert template ${templateItem.template_key}: ${templateError.message}` }, { status: 500 });
          }
        }
      }
    }

    // Fetch the updated settings to return as response
    const { data: updatedTenant } = await supabase
      .from('tenants')
      .select('id, name, slug, status, timezone, business_hours, team_alert_email, config')
      .eq('id', tenantId)
      .maybeSingle();

    const { data: updatedSenders } = await supabase
      .from('senders')
      .select(SENDER_SAFE_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true });
    const updatedSecretSetIds = await fetchSenderIdsWithClientSecret(supabase, tenantId);
    const enrichedUpdatedSenders = enrichSenders(updatedSenders, updatedSecretSetIds);

    const { data: updatedTemplates } = await supabase
      .from('templates')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('template_key', { ascending: true })
      .order('version', { ascending: false });

    return NextResponse.json({
      message: 'Settings updated successfully',
      data: {
        tenant: updatedTenant,
        senders: enrichedUpdatedSenders,
        templates: updatedTemplates || []
      }
    });
  } catch (err) {
    console.error('Unexpected error updating settings:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
