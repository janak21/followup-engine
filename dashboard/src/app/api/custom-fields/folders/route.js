import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function loadTenant(request) {
  const tenantId = await getTenantId(request);
  const { data, error } = await supabase
    .from('tenants').select('id, config').eq('id', tenantId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('No tenant configured');
  return data;
}

// Returns the merged folder list: explicit folders + folders inferred from existing fields.
async function mergedFolders(tenant) {
  const explicit = Array.isArray(tenant.config?.custom_field_folders) ? tenant.config.custom_field_folders : [];
  const fields = Array.isArray(tenant.config?.custom_fields) ? tenant.config.custom_fields : [];
  const inferred = fields.map(f => f.folder).filter(Boolean);
  return Array.from(new Set([...explicit, ...inferred])).sort();
}

export async function GET(request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const tenant = await loadTenant(request);
    return NextResponse.json({ data: { folders: await mergedFolders(tenant) } });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const tenant = await loadTenant(request);
    const { name } = await request.json();
    const trimmed = String(name || '').trim();
    if (!trimmed) return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });

    const existing = await mergedFolders(tenant);
    if (existing.some(f => f.toLowerCase() === trimmed.toLowerCase())) {
      return NextResponse.json({ error: `Folder "${trimmed}" already exists` }, { status: 400 });
    }
    const explicit = Array.isArray(tenant.config?.custom_field_folders) ? [...tenant.config.custom_field_folders] : [];
    explicit.push(trimmed);
    const mergedConfig = { ...(tenant.config || {}), custom_field_folders: explicit };
    const { error } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: { name: trimmed, folders: await mergedFolders({ ...tenant, config: mergedConfig }) } });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

// PUT — rename a folder. Body: { from, to }. Renames in custom_field_folders + on every field
// that currently has folder = from.
export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const tenant = await loadTenant(request);
    const { from, to } = await request.json();
    const fromName = String(from || '').trim();
    const toName = String(to || '').trim();
    if (!fromName || !toName) return NextResponse.json({ error: 'from and to required' }, { status: 400 });

    const explicit = (tenant.config?.custom_field_folders || []).map(f => f === fromName ? toName : f);
    if (!explicit.includes(toName)) explicit.push(toName);
    const fields = (tenant.config?.custom_fields || []).map(f => f.folder === fromName ? { ...f, folder: toName } : f);
    const mergedConfig = { ...(tenant.config || {}), custom_field_folders: Array.from(new Set(explicit)), custom_fields: fields };
    const { error } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: { renamed: { from: fromName, to: toName } } });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE ?name=...  removes the folder name from custom_field_folders AND clears the folder on
// any field using it (fields stay, become Uncategorized).
export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const name = (searchParams.get('name') || '').trim();
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    const tenant = await loadTenant(request);
    const explicit = (tenant.config?.custom_field_folders || []).filter(f => f !== name);
    const fields = (tenant.config?.custom_fields || []).map(f => f.folder === name ? { ...f, folder: null } : f);
    const mergedConfig = { ...(tenant.config || {}), custom_field_folders: explicit, custom_fields: fields };
    const { error } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: { deleted: name } });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
