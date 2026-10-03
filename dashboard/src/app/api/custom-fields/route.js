import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Storage: tenants.config.custom_fields is a jsonb array of field definitions.
// Schema:
// {
//   id: string (uuid),
//   key: string (lowercase snake_case, unique within tenant),
//   label: string,
//   type: 'single_line' | 'multi_line' | 'number' | 'date' | 'boolean' | 'dropdown' | 'radio' | 'multi_select' | 'url' | 'email' | 'phone',
//   folder: string | null,
//   description?: string,
//   placeholder?: string,
//   default_value?: any,
//   options?: string[],  // for dropdown / radio / multi_select
//   required?: boolean,
//   display_order?: number,
//   active?: boolean,
//   created_at?: ISO string
// }

const VALID_TYPES = [
  'single_line', 'multi_line', 'number', 'date', 'boolean',
  'dropdown', 'radio', 'multi_select', 'url', 'email', 'phone'
];

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

function validateField(f, { existingKeys = [], isCreate = false } = {}) {
  if (!f.label || !String(f.label).trim()) return 'label is required';
  if (!f.type || !VALID_TYPES.includes(f.type)) return `type must be one of: ${VALID_TYPES.join(', ')}`;
  const key = normalizeKey(f.key || f.label);
  if (!key) return 'key cannot be empty';
  if (isCreate && existingKeys.includes(key)) return `A field with key "${key}" already exists`;
  if ((f.type === 'dropdown' || f.type === 'radio' || f.type === 'multi_select')
      && (!Array.isArray(f.options) || f.options.length === 0)) {
    return `${f.type} requires at least one option`;
  }
  return null;
}

async function loadTenant(request) {
  const tenantId = await getTenantId(request);
  const { data, error } = await supabase
    .from('tenants')
    .select('id, config')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('No tenant configured');
  return data;
}

async function writeFields(tenantId, fields) {
  const { data, error } = await supabase
    .from('tenants')
    .update({ config: supabase.rpc ? undefined : undefined }) // placeholder — see below
    .eq('id', tenantId)
    .select('config')
    .maybeSingle();
  // The supabase JS client doesn't support partial jsonb merge cleanly without RPC;
  // fall back to full-config update from the caller. Caller should pass full mergedConfig.
  return { data, error };
}

export async function GET(request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const tenant = await loadTenant(request);
    const fields = Array.isArray(tenant.config?.custom_fields) ? tenant.config.custom_fields : [];
    const explicit = Array.isArray(tenant.config?.custom_field_folders) ? tenant.config.custom_field_folders : [];
    const inferred = fields.map(f => f.folder).filter(Boolean);
    const folders = Array.from(new Set([...explicit, ...inferred])).sort();
    return NextResponse.json({ data: { fields, folders } });
  } catch (err) {
    console.error('GET /api/custom-fields:', err);
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
    const body = await request.json();
    const fields = Array.isArray(tenant.config?.custom_fields) ? [...tenant.config.custom_fields] : [];
    const existingKeys = fields.map(f => normalizeKey(f.key));
    const err = validateField(body, { existingKeys, isCreate: true });
    if (err) return NextResponse.json({ error: err }, { status: 400 });

    const newField = {
      id: crypto.randomUUID(),
      key: normalizeKey(body.key || body.label),
      label: String(body.label).trim(),
      type: body.type,
      folder: body.folder ? String(body.folder).trim() : null,
      description: body.description ? String(body.description).trim() : null,
      placeholder: body.placeholder ? String(body.placeholder).trim() : null,
      default_value: body.default_value ?? null,
      options: Array.isArray(body.options) ? body.options.map(o => String(o)).filter(Boolean) : null,
      required: !!body.required,
      display_order: typeof body.display_order === 'number' ? body.display_order : fields.length,
      active: body.active !== false,
      created_at: new Date().toISOString(),
    };

    fields.push(newField);

    const mergedConfig = { ...(tenant.config || {}), custom_fields: fields };
    const { data, error } = await supabase
      .from('tenants')
      .update({ config: mergedConfig })
      .eq('id', tenant.id)
      .select('config')
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: newField });
  } catch (err) {
    console.error('POST /api/custom-fields:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const tenant = await loadTenant(request);
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const fields = Array.isArray(tenant.config?.custom_fields) ? [...tenant.config.custom_fields] : [];
    const idx = fields.findIndex(f => f.id === body.id);
    if (idx < 0) return NextResponse.json({ error: 'Field not found' }, { status: 404 });

    const existing = fields[idx];
    const next = {
      ...existing,
      ...(body.label !== undefined ? { label: String(body.label).trim() } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.folder !== undefined ? { folder: body.folder ? String(body.folder).trim() : null } : {}),
      ...(body.description !== undefined ? { description: body.description ? String(body.description).trim() : null } : {}),
      ...(body.placeholder !== undefined ? { placeholder: body.placeholder ? String(body.placeholder).trim() : null } : {}),
      ...(body.default_value !== undefined ? { default_value: body.default_value } : {}),
      ...(body.options !== undefined ? { options: Array.isArray(body.options) ? body.options.map(o => String(o)).filter(Boolean) : null } : {}),
      ...(body.required !== undefined ? { required: !!body.required } : {}),
      ...(body.display_order !== undefined ? { display_order: Number(body.display_order) || 0 } : {}),
      ...(body.active !== undefined ? { active: !!body.active } : {}),
    };
    // key is immutable to avoid breaking lead data referencing it
    next.key = existing.key;

    const err = validateField(next);
    if (err) return NextResponse.json({ error: err }, { status: 400 });

    fields[idx] = next;
    const mergedConfig = { ...(tenant.config || {}), custom_fields: fields };
    const { error } = await supabase
      .from('tenants')
      .update({ config: mergedConfig })
      .eq('id', tenant.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: next });
  } catch (err) {
    console.error('PUT /api/custom-fields:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

// PATCH — reorder fields. Body: { ordered_ids: [id1, id2, ...] }
// Recomputes display_order on each provided field to match the array's index.
// Unmentioned fields keep their existing order. Drives drag-and-drop UI on the settings page.
export async function PATCH(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const tenant = await loadTenant(request);
    const body = await request.json();
    const orderedIds = Array.isArray(body.ordered_ids) ? body.ordered_ids : null;
    if (!orderedIds || orderedIds.length === 0) {
      return NextResponse.json({ error: 'ordered_ids must be a non-empty array' }, { status: 400 });
    }

    const fields = Array.isArray(tenant.config?.custom_fields) ? [...tenant.config.custom_fields] : [];
    const known = new Set(fields.map(f => f.id));
    const unknown = orderedIds.filter(id => !known.has(id));
    if (unknown.length) {
      return NextResponse.json({ error: `Unknown field ids: ${unknown.join(', ')}` }, { status: 400 });
    }

    // Assign display_order based on position in the supplied list.
    const positionById = new Map(orderedIds.map((id, idx) => [id, idx]));
    const updated = fields.map(f =>
      positionById.has(f.id) ? { ...f, display_order: positionById.get(f.id) } : f
    );

    const mergedConfig = { ...(tenant.config || {}), custom_fields: updated };
    const { error } = await supabase
      .from('tenants')
      .update({ config: mergedConfig })
      .eq('id', tenant.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ data: { reordered: orderedIds.length } });
  } catch (err) {
    console.error('PATCH /api/custom-fields:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key missing.' }, { status: 503 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const tenant = await loadTenant(request);
    const fields = Array.isArray(tenant.config?.custom_fields) ? [...tenant.config.custom_fields] : [];
    const next = fields.filter(f => f.id !== id);
    if (next.length === fields.length) return NextResponse.json({ error: 'Field not found' }, { status: 404 });
    const mergedConfig = { ...(tenant.config || {}), custom_fields: next };
    const { error } = await supabase
      .from('tenants')
      .update({ config: mergedConfig })
      .eq('id', tenant.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/custom-fields:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
