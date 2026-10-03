import { NextResponse } from "next/server";

import {
  BULK_ENROLL_STATUSES,
  getFirstJourneyStep,
  normalizeLeadIds,
  planBulkEnroll,
  summarizeBulkEnrollResults,
} from "@/lib/bulkEnroll";
import { requireOperator } from "@/utils/role";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";

const MAX_LEADS_PER_CALL = 5000;
const LEAD_SELECT = "id, tenant_id, first_name, last_name, email, phone_raw, phone_e164, journey_template, journey_status, opt_out, source_batch_id";

function badRequest(message) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizeJourneyKey(value) {
  return String(value || "").trim();
}

function normalizeImportId(value) {
  return String(value || "").trim();
}

async function loadSuppressions(tenantId, leads) {
  const emails = [...new Set((leads || []).map((lead) => String(lead.email || "").trim().toLowerCase()).filter(Boolean))];
  const phones = [...new Set((leads || []).map((lead) => String(lead.phone_e164 || lead.phone_raw || "").trim()).filter(Boolean))];
  const leadIds = [...new Set((leads || []).map((lead) => lead.id).filter(Boolean))];

  const queries = [];
  if (emails.length > 0) {
    queries.push(
      supabase
        .from("suppressions")
        .select("id, lead_id, email, phone_e164, channel")
        .eq("tenant_id", tenantId)
        .in("email", emails)
        .limit(5000)
    );
  }
  if (phones.length > 0) {
    queries.push(
      supabase
        .from("suppressions")
        .select("id, lead_id, email, phone_e164, channel")
        .eq("tenant_id", tenantId)
        .in("phone_e164", phones)
        .limit(5000)
    );
  }
  if (leadIds.length > 0) {
    queries.push(
      supabase
        .from("suppressions")
        .select("id, lead_id, email, phone_e164, channel")
        .eq("tenant_id", tenantId)
        .in("lead_id", leadIds)
        .limit(5000)
    );
  }

  if (queries.length === 0) return [];

  const responses = await Promise.all(queries);
  const merged = new Map();
  for (const response of responses) {
    if (response.error) throw response.error;
    for (const row of response.data || []) {
      merged.set(row.id, row);
    }
  }
  return [...merged.values()];
}

async function loadJourney(tenantId, body) {
  const journeyKey = normalizeJourneyKey(body?.journey_key || body?.journey_template);
  const journeyId = normalizeJourneyKey(body?.journey_id);
  if (!journeyKey && !journeyId) {
    throw new Error("journey_key or journey_id is required");
  }

  let query = supabase
    .from("journeys")
    .select("id, tenant_id, journey_key, name, active, spec")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1);

  query = journeyId ? query.eq("id", journeyId) : query.eq("journey_key", journeyKey);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

async function loadImportBatch(tenantId, importId) {
  if (!importId) return null;
  const { data, error } = await supabase
    .from("import_batches")
    .select("id, tenant_id, source_filename, status")
    .eq("tenant_id", tenantId)
    .eq("id", importId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadLeadsForEnrollment({ tenantId, leadIds, importId }) {
  if (importId) {
    const batch = await loadImportBatch(tenantId, importId);
    if (!batch) {
      const error = new Error("Import not found for this workspace.");
      error.status = 404;
      throw error;
    }

    const { data, error } = await supabase
      .from("leads")
      .select(LEAD_SELECT)
      .eq("tenant_id", tenantId)
      .eq("source_batch_id", importId)
      .limit(MAX_LEADS_PER_CALL);
    if (error) throw error;
    return {
      source: "import",
      import: batch,
      requestedLeadIds: (data || []).map((lead) => lead.id),
      leads: data || [],
    };
  }

  const { data, error } = await supabase
    .from("leads")
    .select(LEAD_SELECT)
    .eq("tenant_id", tenantId)
    .in("id", leadIds);
  if (error) throw error;
  return {
    source: "lead_ids",
    import: null,
    requestedLeadIds: leadIds,
    leads: data || [],
  };
}

export async function POST(request) {
  const guard = await requireOperator(request);
  if (guard) return guard;

  try {
    const tenantId = await getTenantId(request);
    const body = await request.json();
    const leadIds = normalizeLeadIds(body?.lead_ids);
    const importId = normalizeImportId(body?.import_id);
    const dryRun = body?.dry_run === true || body?.mode === "preview";
    const startBehavior = String(body?.start_behavior || "now");

    if (leadIds.length === 0 && !importId) return badRequest("lead_ids or import_id required");
    if (leadIds.length > 0 && importId) return badRequest("Send lead_ids or import_id, not both");
    if (leadIds.length > MAX_LEADS_PER_CALL) return badRequest(`max ${MAX_LEADS_PER_CALL} leads per call`);
    if (startBehavior !== "now") return badRequest('start_behavior must be "now"');

    let journey;
    try {
      journey = await loadJourney(tenantId, body);
    } catch (err) {
      if (err.message === "journey_key or journey_id is required") return badRequest(err.message);
      throw err;
    }

    if (!journey) {
      return NextResponse.json({ error: "Journey not found or inactive for this tenant." }, { status: 404 });
    }

    const step0 = getFirstJourneyStep(journey);
    if (!step0) {
      return badRequest("Selected journey has no first step.");
    }

    const leadScope = await loadLeadsForEnrollment({ tenantId, leadIds, importId });
    const leads = leadScope.leads;

    const suppressions = await loadSuppressions(tenantId, leads || []);
    const { data: runRows, error: runErr } = await supabase
      .from("journey_runs")
      .select("lead_id, journey_key")
      .eq("tenant_id", tenantId)
      .eq("status", "running")
      .in("lead_id", (leads || []).map((lead) => lead.id));
    if (runErr) throw runErr;

    const activeRunsByLeadId = new Map();
    for (const row of runRows || []) {
      const key = String(row.lead_id);
      if (!activeRunsByLeadId.has(key)) activeRunsByLeadId.set(key, new Set());
      activeRunsByLeadId.get(key).add(row.journey_key);
    }

    const plan = planBulkEnroll({
      requestedLeadIds: leadScope.requestedLeadIds,
      leads: leads || [],
      journey,
      suppressions,
      activeRunsByLeadId,
    });

    if (dryRun) {
      return NextResponse.json({
        data: {
          dry_run: true,
          source: leadScope.source,
          import: leadScope.import ? { id: leadScope.import.id, source_filename: leadScope.import.source_filename, status: leadScope.import.status } : null,
          journey: { id: journey.id, journey_key: journey.journey_key, name: journey.name },
          start_behavior: "now",
          summary: plan.summary,
          results: plan.results,
        },
      });
    }

    const leadsById = new Map((leads || []).map((lead) => [String(lead.id), lead]));
    const results = [];

    for (const planned of plan.results) {
      if (planned.status !== BULK_ENROLL_STATUSES.READY) {
        results.push(planned);
        continue;
      }

      const lead = leadsById.get(planned.lead_id);
      try {
        const { data: enroll, error: enrollErr } = await supabase.rpc("enroll_lead_in_journey", {
          p_tenant_id: tenantId,
          p_lead_id: lead.id,
          p_journey_key: journey.journey_key,
          p_source: "bulk_enroll",
        });
        if (enrollErr) throw enrollErr;

        if (enroll?.status === "enrolled") {
          results.push({
            ...planned,
            status: BULK_ENROLL_STATUSES.ENROLLED,
            reason: "Lead enrolled and step 0 action queued.",
            run_id: enroll.run_id,
            action_id: enroll.action_id,
          });
        } else if (enroll?.status === "already_active") {
          results.push({
            ...planned,
            status: BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE,
            reason: "Lead already has a running enrollment in this journey.",
            run_id: enroll.run_id,
          });
        } else if (enroll?.status === "blocked_once_ever") {
          results.push({ ...planned, status: BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE, reason: "Journey allows one enrollment per lead, ever." });
        } else if (enroll?.status === "lead_opted_out") {
          results.push({ ...planned, status: BULK_ENROLL_STATUSES.SKIPPED_OPTED_OUT, reason: "Lead is opted out." });
        } else {
          results.push({ ...planned, status: BULK_ENROLL_STATUSES.FAILED, reason: `Enrollment failed: ${enroll?.status || "unknown"}` });
        }
      } catch (err) {
        results.push({
          ...planned,
          status: BULK_ENROLL_STATUSES.FAILED,
          reason: err.message || "Failed to enroll lead.",
        });
      }
    }

    return NextResponse.json({
      data: {
        dry_run: false,
        source: leadScope.source,
        import: leadScope.import ? { id: leadScope.import.id, source_filename: leadScope.import.source_filename, status: leadScope.import.status } : null,
        journey: { id: journey.id, journey_key: journey.journey_key, name: journey.name },
        start_behavior: "now",
        summary: summarizeBulkEnrollResults(results),
        results,
      },
    });
  } catch (err) {
    const status = err?.code === 401 ? 401 : err?.status || 500;
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status });
  }
}
