import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { getMockTemplates, addMockTemplate, editMockTemplate, deleteMockTemplate } from '@/utils/mockDb';
import { requireOperator } from "@/utils/role";

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && 
         (!!process.env.SUPABASE_SERVICE_ROLE_KEY || !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}



export async function GET(request) {
  try {
    if (!isSupabaseConfigured()) {
      const mappings = globalThis.mockDb?.tenant?.config?.template_folder_mappings || {};
      const enrichedMock = getMockTemplates().map(t => ({
        ...t,
        folder: mappings[t.template_key] || null
      }));
      return NextResponse.json({ data: enrichedMock });
    }

    const tenantId = await getTenantId(request);
    const { data: tenantData } = await supabase
      .from('tenants').select('config').eq('id', tenantId).maybeSingle();
    const folderMappings = tenantData?.config?.template_folder_mappings || {};

    const { data, error } = await supabase
      .from('templates')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('template_key', { ascending: true });

    if (error) {
      console.warn('Failed to fetch templates from Supabase, using mock:', error.message);
      const mappings = globalThis.mockDb?.tenant?.config?.template_folder_mappings || {};
      const enrichedMock = getMockTemplates().map(t => ({
        ...t,
        folder: mappings[t.template_key] || null
      }));
      return NextResponse.json({ data: enrichedMock });
    }

    if (!data || data.length === 0) {
      const mappings = globalThis.mockDb?.tenant?.config?.template_folder_mappings || {};
      const enrichedMock = getMockTemplates().map(t => ({
        ...t,
        folder: mappings[t.template_key] || null
      }));
      return NextResponse.json({ data: enrichedMock });
    }

    const enrichedData = data.map(t => ({
      ...t,
      folder: folderMappings[t.template_key] || null
    }));

    return NextResponse.json({ data: enrichedData });
  } catch (err) {
    console.error('Unexpected error fetching templates:', err);
    const mappings = globalThis.mockDb?.tenant?.config?.template_folder_mappings || {};
    const enrichedMock = getMockTemplates().map(t => ({
      ...t,
      folder: mappings[t.template_key] || null
    }));
    return NextResponse.json({ data: enrichedMock });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const body = await request.json();
    const { template_key, channel, subject, body: tBody, variables, notes, active, folder } = body;

    if (!template_key || !channel || !tBody) {
      return NextResponse.json({ error: 'template_key, channel, and body are required' }, { status: 400 });
    }

    if (!isSupabaseConfigured()) {
      const newTpl = addMockTemplate({ template_key, channel, subject, body: tBody, active });
      if (folder !== undefined) {
        const tenant = globalThis.mockDb.tenant;
        const mappings = { ...(tenant.config?.template_folder_mappings || {}) };
        if (folder) {
          mappings[template_key] = folder;
        } else {
          delete mappings[template_key];
        }
        tenant.config = { ...(tenant.config || {}), template_folder_mappings: mappings };
      }
      return NextResponse.json({ data: { ...newTpl, folder: folder || null } });
    }

    const tenantId = await getTenantId(request);

    // Save folder to tenant config if provided
    if (folder !== undefined) {
      const { data: tenantData } = await supabase
        .from('tenants').select('config').eq('id', tenantId).maybeSingle();
      const mappings = { ...(tenantData?.config?.template_folder_mappings || {}) };
      if (folder) {
        mappings[template_key] = folder;
      } else {
        delete mappings[template_key];
      }
      const mergedConfig = { ...(tenantData?.config || {}), template_folder_mappings: mappings };
      await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenantId);
    }

    const templateInsert = {
      tenant_id: tenantId,
      template_key,
      channel,
      subject: subject || null,
      body: tBody,
      variables: variables || [],
      notes: notes || '',
      active: active ?? true
    };

    const { data, error } = await supabase
      .from('templates')
      .insert([templateInsert])
      .select();

    if (error) {
      console.warn('Failed to insert template in Supabase, using mock DB:', error.message);
      const newTpl = addMockTemplate({ template_key, channel, subject, body: tBody, active });
      return NextResponse.json({ data: { ...newTpl, folder: folder || null } });
    }

    return NextResponse.json({ data: { ...data[0], folder: folder || null } });
  } catch (err) {
    console.error('Error in POST templates:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const body = await request.json();
    const { id, template_key, channel, subject, body: tBody, variables, notes, active, folder } = body;

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required' }, { status: 400 });
    }

    if (!isSupabaseConfigured()) {
      // Find old template key before editing
      const oldTpl = globalThis.mockDb.templates.find(t => t.id === id);
      const oldKey = oldTpl?.template_key;

      const updated = editMockTemplate(id, { template_key, channel, subject, body: tBody, active });
      if (folder !== undefined && template_key) {
        const tenant = globalThis.mockDb.tenant;
        const mappings = { ...(tenant.config?.template_folder_mappings || {}) };
        if (oldKey && oldKey !== template_key) {
          delete mappings[oldKey];
        }
        if (folder) {
          mappings[template_key] = folder;
        } else {
          delete mappings[template_key];
        }
        tenant.config = { ...(tenant.config || {}), template_folder_mappings: mappings };
      }
      return NextResponse.json({ data: { ...updated, folder: folder || null } });
    }
    const tenantId = await getTenantId(request);

    // If template_key or folder changes, update mappings in tenant config
    if (folder !== undefined || template_key) {
      // Fetch old template key first to clean up old mapping if template_key changed
      const { data: oldTemplate } = await supabase
        .from('templates')
        .select('template_key')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      const { data: tenantData } = await supabase
        .from('tenants').select('config').eq('id', tenantId).maybeSingle();
      const mappings = { ...(tenantData?.config?.template_folder_mappings || {}) };
      
      if (oldTemplate?.template_key && oldTemplate.template_key !== template_key) {
        delete mappings[oldTemplate.template_key];
      }
      const targetKey = template_key || oldTemplate?.template_key;
      if (targetKey) {
        if (folder) {
          mappings[targetKey] = folder;
        } else {
          delete mappings[targetKey];
        }
      }
      const mergedConfig = { ...(tenantData?.config || {}), template_folder_mappings: mappings };
      await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenantId);
    }

    const templateUpdate = {
      template_key,
      channel,
      subject: subject !== undefined ? subject : null,
      body: tBody,
      variables,
      notes,
      active
    };

    // Remove undefined fields
    Object.keys(templateUpdate).forEach(key => templateUpdate[key] === undefined && delete templateUpdate[key]);

    const { data, error } = await supabase
      .from('templates')
      .update(templateUpdate)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select();

    if (error) {
      console.warn('Failed to update template in Supabase, using mock DB:', error.message);
      const updated = editMockTemplate(id, { template_key, channel, subject, body: tBody, active });
      return NextResponse.json({ data: { ...updated, folder: folder || null } });
    }

    return NextResponse.json({ data: { ...data[0], folder: folder || null } });
  } catch (err) {
    console.error('Error in PUT templates:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required' }, { status: 400 });
    }

    if (!isSupabaseConfigured()) {
      // Find template key to delete from mappings
      const oldTpl = globalThis.mockDb.templates.find(t => t.id === id);
      if (oldTpl?.template_key) {
        const tenant = globalThis.mockDb.tenant;
        const mappings = { ...(tenant.config?.template_folder_mappings || {}) };
        delete mappings[oldTpl.template_key];
        tenant.config = { ...(tenant.config || {}), template_folder_mappings: mappings };
      }
      const success = deleteMockTemplate(id);
      return NextResponse.json({ success });
    }
    const tenantId = await getTenantId(request);

    // Fetch template key to delete mapping in tenant config
    const { data: oldTemplate } = await supabase
      .from('templates')
      .select('template_key')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (oldTemplate?.template_key) {
      const { data: tenantData } = await supabase
        .from('tenants').select('config').eq('id', tenantId).maybeSingle();
      const mappings = { ...(tenantData?.config?.template_folder_mappings || {}) };
      delete mappings[oldTemplate.template_key];
      const mergedConfig = { ...(tenantData?.config || {}), template_folder_mappings: mappings };
      await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenantId);
    }

    const { error } = await supabase
      .from('templates')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) {
      console.warn('Failed to delete template in Supabase, deleting from mock DB:', error.message);
      const success = deleteMockTemplate(id);
      return NextResponse.json({ success });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE templates:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
