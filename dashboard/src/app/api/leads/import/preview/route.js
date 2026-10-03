import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import {
  autoMapColumns,
  mappingOptions,
  parseCsvDocument,
  planImportRows,
  sampleValuesForHeaders,
} from '@/lib/csvImport';

const MAX_CSV_BYTES = 5 * 1024 * 1024;

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function loadCustomFieldsSchema(tenantId) {
  const { data } = await supabase
    .from('tenants')
    .select('config')
    .eq('id', tenantId)
    .maybeSingle();
  return Array.isArray(data?.config?.custom_fields) ? data.config.custom_fields : [];
}

async function loadExistingLeads(tenantId, rows, mappings) {
  const planSeed = rows.map((row) => ({ rowNumber: row.rowNumber, cells: row.cells }));
  const drafts = planSeed.map((row) => planImportRows([row], mappings).creates[0]?.draft).filter(Boolean);
  const emails = [...new Set(drafts.map((draft) => draft.email).filter(Boolean))];
  const phones = [...new Set(drafts.map((draft) => draft.phone_e164).filter(Boolean))];

  if (emails.length === 0 && phones.length === 0) return [];

  const [emailRes, phoneRes] = await Promise.all([
    emails.length
      ? supabase.from('leads').select('id, email, phone_e164, first_name, last_name, source, custom_fields, raw_payload').eq('tenant_id', tenantId).in('email', emails).limit(5000)
      : Promise.resolve({ data: [], error: null }),
    phones.length
      ? supabase.from('leads').select('id, email, phone_e164, first_name, last_name, source, custom_fields, raw_payload').eq('tenant_id', tenantId).in('phone_e164', phones).limit(5000)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (emailRes.error || phoneRes.error) throw new Error(`Duplicate lookup failed: ${emailRes.error?.message || phoneRes.error?.message}`);
  return [...new Map([...(emailRes.data || []), ...(phoneRes.data || [])].map((lead) => [lead.id, lead])).values()];
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase service role key is missing.' }, { status: 503 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const campaignType = String(formData.get('campaign_type') || 'csv_import').trim() || 'csv_import';

    if (!file) return NextResponse.json({ error: 'File is required.' }, { status: 400 });
    if (file.size > MAX_CSV_BYTES) return NextResponse.json({ error: 'CSV file is too large. Maximum size is 5 MB.' }, { status: 400 });

    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant configured.' }, { status: 404 });

    const buffer = Buffer.from(await file.arrayBuffer());
    let parsed;
    try {
      parsed = parseCsvDocument(buffer.toString('utf8'));
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const uniqueFilename = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const storagePath = `${tenantId}/${uniqueFilename}`;
    const { error: uploadError } = await supabase.storage
      .from('csv-uploads')
      .upload(storagePath, buffer, { contentType: 'text/csv', duplex: 'half' });
    if (uploadError) return NextResponse.json({ error: `Failed to upload CSV to storage: ${uploadError.message}` }, { status: 500 });

    const { data: batch, error: batchError } = await supabase
      .from('import_batches')
      .insert({
        tenant_id: tenantId,
        source: 'csv',
        source_filename: file.name,
        storage_path: storagePath,
        campaign_type: campaignType,
        status: 'staged',
        total_rows: parsed.rows.length,
        notes: 'CSV staged for native column mapping review.'
      })
      .select()
      .single();
    if (batchError) return NextResponse.json({ error: `Failed to create import batch: ${batchError.message}` }, { status: 500 });

    const customFields = await loadCustomFieldsSchema(tenantId);
    const mappings = autoMapColumns(parsed.headers, customFields);
    const existingLeads = await loadExistingLeads(tenantId, parsed.rows, mappings);
    const plan = planImportRows(parsed.rows, mappings, existingLeads, { duplicateMode: 'skip', campaignType });
    const unmappedCount = Object.values(mappings).filter((value) => value === '__skip').length;
    const mappedCount = Object.keys(mappings).length - unmappedCount;

    return NextResponse.json({
      data: {
        batch,
        headers: parsed.headers,
        samples: sampleValuesForHeaders(parsed.headers, parsed.rows),
        preview_rows: parsed.rows.slice(0, 5),
        mappings,
        mapping_options: mappingOptions(customFields),
        review: {
          total_rows: parsed.rows.length,
          ready_rows: plan.creates.length,
          error_rows: plan.errors.length,
          duplicate_rows: plan.skipped.filter((row) => row.duplicate).length,
          unmapped_columns: unmappedCount,
          mapped_columns: mappedCount,
          errors: plan.errors.slice(0, 20),
          duplicates: plan.skipped.filter((row) => row.duplicate).slice(0, 20),
        }
      }
    });
  } catch (err) {
    console.error('CSV preview failed:', err);
    return NextResponse.json({ error: err.message || 'CSV preview failed' }, { status: 500 });
  }
}
