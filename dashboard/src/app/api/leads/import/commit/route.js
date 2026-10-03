import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";
import {
  parseCsvDocument,
  planImportRows,
} from '@/lib/csvImport';

const DUPLICATE_MODES = new Set(['skip', 'update_missing', 'overwrite']);

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function loadExistingLeads(tenantId, rows, mappings, campaignType) {
  const draftPlan = planImportRows(rows, mappings, [], { duplicateMode: 'skip', campaignType });
  const drafts = [...draftPlan.creates.map((item) => item.draft)];
  const emails = [...new Set(drafts.map((draft) => draft.email).filter(Boolean))];
  const phones = [...new Set(drafts.map((draft) => draft.phone_e164).filter(Boolean))];

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
    const body = await request.json();
    const batchId = body?.batch_id;
    const mappings = body?.mappings || {};
    const duplicateMode = DUPLICATE_MODES.has(body?.duplicate_mode) ? body.duplicate_mode : 'skip';

    if (!batchId) return NextResponse.json({ error: 'batch_id is required.' }, { status: 400 });

    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant configured.' }, { status: 404 });

    const { data: batch, error: batchError } = await supabase
      .from('import_batches')
      .select('*')
      .eq('id', batchId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (batchError) return NextResponse.json({ error: batchError.message }, { status: 500 });
    if (!batch) return NextResponse.json({ error: 'Import batch not found.' }, { status: 404 });
    if (!batch.storage_path) return NextResponse.json({ error: 'Import batch has no staged CSV file.' }, { status: 400 });

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('csv-uploads')
      .download(batch.storage_path);
    if (downloadError) return NextResponse.json({ error: `Failed to read staged CSV: ${downloadError.message}` }, { status: 500 });

    const csvText = Buffer.from(await fileData.arrayBuffer()).toString('utf8');
    const parsed = parseCsvDocument(csvText);
    const campaignType = batch.campaign_type || 'csv_import';
    const existingLeads = await loadExistingLeads(tenantId, parsed.rows, mappings, campaignType);
    const plan = planImportRows(parsed.rows, mappings, existingLeads, { duplicateMode, batchId, campaignType });

    const rowErrors = [...plan.errors];
    let created = 0;
    let updated = 0;

    for (const item of plan.creates) {
      const { error } = await supabase.from('leads').insert([{
        tenant_id: tenantId,
        source_batch_id: batch.id,
        source: item.draft.source || 'CSV Import',
        first_name: item.draft.first_name || '',
        last_name: item.draft.last_name || '',
        email: item.draft.email || null,
        phone_raw: item.draft.phone_raw || null,
        phone_e164: item.draft.phone_e164 || null,
        campaign_type: campaignType,
        custom_fields: item.draft.custom_fields || {},
        raw_payload: item.draft.raw_payload || {},
      }]);
      if (error) rowErrors.push({ row: item.row, error: error.message });
      else created += 1;
    }

    for (const item of plan.updates) {
      const update = {
        ...item.draft,
        updated_at: new Date().toISOString(),
      };
      delete update.source_batch_id;
      const { error } = await supabase
        .from('leads')
        .update(update)
        .eq('id', item.lead_id)
        .eq('tenant_id', tenantId);
      if (error) rowErrors.push({ row: item.row, lead_id: item.lead_id, error: error.message });
      else updated += 1;
    }

    const skipped = plan.skipped.length;
    const finalStatus = rowErrors.length === 0 ? 'completed' : (created || updated || skipped) ? 'completed_with_errors' : 'failed';
    const summary = {
      total_rows: parsed.rows.length,
      created,
      updated,
      skipped_duplicates: skipped,
      failed_rows: rowErrors.length,
      duplicate_mode: duplicateMode,
      error_log: rowErrors.slice(0, 200),
    };

    const { data: updatedBatch } = await supabase
      .from('import_batches')
      .update({
        status: finalStatus,
        inserted: created,
        updated,
        skipped,
        errors: rowErrors.length,
        error_log: summary.error_log,
        processed_at: new Date().toISOString(),
        notes: `Native CSV import completed. ${created} created, ${updated} updated, ${skipped} duplicate(s) skipped, ${rowErrors.length} failed row(s).`
      })
      .eq('id', batch.id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    return NextResponse.json({
      data: updatedBatch || batch,
      summary,
    }, { status: created || updated || skipped ? 200 : 400 });
  } catch (err) {
    console.error('CSV commit failed:', err);
    return NextResponse.json({ error: err.message || 'CSV import failed' }, { status: 500 });
  }
}
