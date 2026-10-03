import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import { getMockTenant, updateMockTenant, getMockJourneys } from '@/utils/mockDb';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
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

async function loadJourneys(request, tenantId) {
  if (!isSupabaseConfigured()) {
    return getMockJourneys();
  }
  const { data, error } = await supabase
    .from('journeys')
    .select('id, spec')
    .eq('tenant_id', tenantId);
  if (error) throw error;
  return data || [];
}

function renameFolderPath(folderPath, from, to) {
  if (folderPath === from) {
    return to;
  }
  if (folderPath.startsWith(from + '/')) {
    return to + folderPath.slice(from.length);
  }
  return folderPath;
}

// Returns the merged folder list: explicit folders + folders inferred from existing journeys.
async function mergedFolders(tenant, journeys) {
  const explicit = Array.isArray(tenant.config?.journey_folders) ? tenant.config.journey_folders : [];
  const inferred = journeys.map(j => j.spec?.folder).filter(Boolean);
  return Array.from(new Set([...explicit, ...inferred])).sort();
}

export async function GET(request) {
  try {
    const tenant = await loadTenant(request);
    const journeys = await loadJourneys(request, tenant.id);
    return NextResponse.json({ data: { folders: await mergedFolders(tenant, journeys) } });
  } catch (err) {
    console.error('Failed to get journey folders:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const tenant = await loadTenant(request);
    const journeys = await loadJourneys(request, tenant.id);
    const { name } = await request.json();
    const trimmed = String(name || '').trim();
    if (!trimmed) return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });

    const existing = await mergedFolders(tenant, journeys);
    if (existing.some(f => f.toLowerCase() === trimmed.toLowerCase())) {
      return NextResponse.json({ error: `Folder "${trimmed}" already exists` }, { status: 400 });
    }

    const explicit = Array.isArray(tenant.config?.journey_folders) ? [...tenant.config.journey_folders] : [];
    explicit.push(trimmed);
    const mergedConfig = { ...(tenant.config || {}), journey_folders: explicit };

    if (isSupabaseConfigured()) {
      const { error } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      updateMockTenant({ config: mergedConfig });
    }

    const updatedTenant = { ...tenant, config: mergedConfig };
    return NextResponse.json({ data: { name: trimmed, folders: await mergedFolders(updatedTenant, journeys) } });
  } catch (err) {
    console.error('Failed to create journey folder:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

// PUT — rename a folder. Body: { from, to }. Renames in journey_folders + on every journey spec.folder
export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const tenant = await loadTenant(request);
    const journeys = await loadJourneys(request, tenant.id);
    const { from, to } = await request.json();
    const fromName = String(from || '').trim();
    const toName = String(to || '').trim();
    if (!fromName || !toName) return NextResponse.json({ error: 'from and to required' }, { status: 400 });

    // 1. Update the journey_folders configuration list (rename self and any subfolder paths)
    const explicit = (tenant.config?.journey_folders || []).map(f => renameFolderPath(f, fromName, toName));
    if (!explicit.includes(toName)) {
      explicit.push(toName);
    }
    const mergedConfig = { ...(tenant.config || {}), journey_folders: Array.from(new Set(explicit)) };

    if (isSupabaseConfigured()) {
      // Update tenant
      const { error: tError } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
      if (tError) return NextResponse.json({ error: tError.message }, { status: 500 });

      // Update journeys
      const updates = [];
      for (const j of journeys) {
        const currentFolder = j.spec?.folder;
        if (currentFolder && (currentFolder === fromName || currentFolder.startsWith(fromName + '/'))) {
          const newFolder = renameFolderPath(currentFolder, fromName, toName);
          const updatedSpec = { ...(j.spec || {}), folder: newFolder };
          updates.push(
            supabase
              .from('journeys')
              .update({ spec: updatedSpec })
              .eq('id', j.id)
          );
        }
      }
      if (updates.length > 0) {
        const results = await Promise.all(updates);
        const firstErr = results.find(r => r.error);
        if (firstErr) throw firstErr.error;
      }
    } else {
      updateMockTenant({ config: mergedConfig });
      for (const j of journeys) {
        const currentFolder = j.spec?.folder;
        if (currentFolder && (currentFolder === fromName || currentFolder.startsWith(fromName + '/'))) {
          const newFolder = renameFolderPath(currentFolder, fromName, toName);
          j.spec = { ...(j.spec || {}), folder: newFolder };
        }
      }
    }

    return NextResponse.json({ data: { renamed: { from: fromName, to: toName } } });
  } catch (err) {
    console.error('Failed to rename journey folder:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE ?name=... removes the folder name (and nested folders) from journey_folders AND clears folder attribute on impacted journeys.
export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const { searchParams } = new URL(request.url);
    const name = (searchParams.get('name') || '').trim();
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const tenant = await loadTenant(request);
    const journeys = await loadJourneys(request, tenant.id);

    // 1. Remove from the explicit journey folders config
    const explicit = (tenant.config?.journey_folders || []).filter(f => f !== name && !f.startsWith(name + '/'));
    const mergedConfig = { ...(tenant.config || {}), journey_folders: explicit };

    if (isSupabaseConfigured()) {
      // Update tenant
      const { error: tError } = await supabase.from('tenants').update({ config: mergedConfig }).eq('id', tenant.id);
      if (tError) return NextResponse.json({ error: tError.message }, { status: 500 });

      // Update journeys to move them to Uncategorized (set spec.folder to null or remove it)
      const updates = [];
      for (const j of journeys) {
        const currentFolder = j.spec?.folder;
        if (currentFolder && (currentFolder === name || currentFolder.startsWith(name + '/'))) {
          const updatedSpec = { ...(j.spec || {}) };
          delete updatedSpec.folder;
          updates.push(
            supabase
              .from('journeys')
              .update({ spec: updatedSpec })
              .eq('id', j.id)
          );
        }
      }
      if (updates.length > 0) {
        const results = await Promise.all(updates);
        const firstErr = results.find(r => r.error);
        if (firstErr) throw firstErr.error;
      }
    } else {
      updateMockTenant({ config: mergedConfig });
      for (const j of journeys) {
        const currentFolder = j.spec?.folder;
        if (currentFolder && (currentFolder === name || currentFolder.startsWith(name + '/'))) {
          if (j.spec) {
            delete j.spec.folder;
          }
        }
      }
    }

    return NextResponse.json({ data: { deleted: name } });
  } catch (err) {
    console.error('Failed to delete journey folder:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
