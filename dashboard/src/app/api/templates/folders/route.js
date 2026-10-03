import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import { getMockTenant, updateMockTenant, getMockTemplates } from '@/utils/mockDb';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && 
         (!!process.env.SUPABASE_SERVICE_ROLE_KEY || !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

async function loadTenant(request) {
  if (!isSupabaseConfigured()) {
    return getMockTenant();
  }
  const tenantId = await getTenantId(request);
  const { data, error } = await supabase
    .from('tenants').select('id, config').eq('id', tenantId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('No tenant configured');
  return data;
}

async function loadTemplates(request, tenantId) {
  if (!isSupabaseConfigured()) {
    return getMockTemplates();
  }
  const { data, error } = await supabase
    .from('templates')
    .select('id, template_key')
    .eq('tenant_id', tenantId);
  if (error) throw error;
  return data || [];
}

async function mergedFolders(tenant, templates) {
  const explicit = Array.isArray(tenant.config?.template_folders) ? tenant.config.template_folders : [];
  const mappings = tenant.config?.template_folder_mappings || {};
  const inferred = templates.map(t => mappings[t.template_key]).filter(Boolean);
  return Array.from(new Set([...explicit, ...inferred])).sort();
}

export async function GET(request) {
  try {
    const tenant = await loadTenant(request);
    const templates = await loadTemplates(request, tenant.id);
    return NextResponse.json({ data: { folders: await mergedFolders(tenant, templates) } });
  } catch (err) {
    console.error('Failed to get template folders:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const tenant = await loadTenant(request);
    const templates = await loadTemplates(request, tenant.id);
    const { name } = await request.json();
    const trimmed = String(name || '').trim();
    if (!trimmed) return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });

    const existing = await mergedFolders(tenant, templates);
    if (existing.some(f => f.toLowerCase() === trimmed.toLowerCase())) {
      return NextResponse.json({ error: `Folder "${trimmed}" already exists` }, { status: 400 });
    }

    const explicit = Array.isArray(tenant.config?.template_folders) ? [...tenant.config.template_folders] : [];
    explicit.push(trimmed);
    const mergedConfig = { ...(tenant.config || {}), template_folders: explicit };

    if (isSupabaseConfigured()) {
      const { error } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      updateMockTenant({ config: mergedConfig });
    }

    const updatedTenant = { ...tenant, config: mergedConfig };
    return NextResponse.json({ data: { name: trimmed, folders: await mergedFolders(updatedTenant, templates) } });
  } catch (err) {
    console.error('Failed to create template folder:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const tenant = await loadTenant(request);
    const templates = await loadTemplates(request, tenant.id);
    const { from, to } = await request.json();
    const fromName = String(from || '').trim();
    const toName = String(to || '').trim();
    if (!fromName || !toName) return NextResponse.json({ error: 'from and to required' }, { status: 400 });

    const explicit = (tenant.config?.template_folders || []).map(f => f === fromName ? toName : f);
    if (!explicit.includes(toName)) explicit.push(toName);

    // Update the templates mappings inside config
    const mappings = { ...(tenant.config?.template_folder_mappings || {}) };
    Object.keys(mappings).forEach(key => {
      if (mappings[key] === fromName) {
        mappings[key] = toName;
      }
    });

    const mergedConfig = { 
      ...(tenant.config || {}), 
      template_folders: Array.from(new Set(explicit)),
      template_folder_mappings: mappings
    };

    if (isSupabaseConfigured()) {
      const { error } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      updateMockTenant({ config: mergedConfig });
    }

    return NextResponse.json({ data: { renamed: { from: fromName, to: toName } } });
  } catch (err) {
    console.error('Failed to rename template folder:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const { searchParams } = new URL(request.url);
    const name = (searchParams.get('name') || '').trim();
    if (!name) return NextResponse.json({ error: 'name query param is required' }, { status: 400 });

    const tenant = await loadTenant(request);
    const explicit = (tenant.config?.template_folders || []).filter(f => f !== name);

    // Clear folder for templates that use it inside mappings
    const mappings = { ...(tenant.config?.template_folder_mappings || {}) };
    Object.keys(mappings).forEach(key => {
      if (mappings[key] === name) {
        delete mappings[key];
      }
    });

    const mergedConfig = { 
      ...(tenant.config || {}), 
      template_folders: explicit,
      template_folder_mappings: mappings
    };

    if (isSupabaseConfigured()) {
      const { error } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      updateMockTenant({ config: mergedConfig });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Failed to delete template folder:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
