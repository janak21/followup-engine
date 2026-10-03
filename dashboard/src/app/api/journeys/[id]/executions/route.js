// GET /api/journeys/[id]/executions
// Returns the last 50 lead enrollments into this journey + their action chain.
// Each enrollment carries: lead {id, name, contact}, started_at, journey_status,
// actions[] (sorted by step_index then created_at).

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

const ACTION_SELECT = "id, lead_id, run_id, action_type, step_index, template_key, status, run_at, completed_at, error_message, last_error, retry_count, max_retries, created_at, payload, result"

function extractPayloadValue(payload, path) {
  if (!payload) return null
  return path.reduce((current, key) => {
    if (current == null) return null
    return current[key]
  }, payload)
}

function contactFromPayload(payload) {
  const fields = extractPayloadValue(payload, ["data", "fields"])
  if (Array.isArray(fields)) {
    const byKey = Object.fromEntries(fields.map((field) => [field?.key, field?.value]))
    return {
      name: [byKey.first_name, byKey.last_name].filter(Boolean).join(" ") || null,
      email: byKey.email || null,
      phone: byKey.phone || null,
    }
  }
  return {
    name: [payload?.first_name, payload?.last_name].filter(Boolean).join(" ") || null,
    email: payload?.email || null,
    phone: payload?.phone || payload?.phone_e164 || payload?.phone_raw || null,
  }
}

export async function GET(request, { params }) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const { id } = await params
    const tenantId = await getTenantId(request)

    const { data: journey } = await supabase
      .from("journeys").select("id, tenant_id, journey_key, name, spec")
      .eq("id", id).maybeSingle()
    if (!journey || journey.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Journey not found" }, { status: 404 })
    }

    if (journey.spec?.mode === "event_workflow") {
      const { data: runs, error: runsErr } = await supabase
        .from("journey_runs")
        .select("id, tenant_id, lead_id, status, current_step, raw_payload, started_at, completed_at, failed_at, updated_at, last_error")
        .eq("tenant_id", tenantId)
        .eq("journey_id", journey.id)
        .eq("mode", "event_workflow")
        .order("started_at", { ascending: false })
        .limit(50)
      if (runsErr) return NextResponse.json({ error: runsErr.message }, { status: 500 })

      const runIds = (runs || []).map((run) => run.id)
      if (runIds.length === 0) {
        return NextResponse.json({ data: { journey, executions: [] } })
      }

      const leadIds = [...new Set((runs || []).map((run) => run.lead_id).filter(Boolean))]
      const [{ data: unified, error: unifiedErr }, { data: runLeads, error: runLeadsErr }] = await Promise.all([
        supabase
          .from("actions")
          .select(ACTION_SELECT)
          .eq("tenant_id", tenantId)
          .in("run_id", runIds)
          .order("created_at", { ascending: true }),
        leadIds.length > 0
          ? supabase
              .from("leads")
              .select("id, first_name, last_name, email, phone_e164, journey_status, current_step")
              .eq("tenant_id", tenantId)
              .in("id", leadIds)
          : Promise.resolve({ data: [], error: null }),
      ])
      if (unifiedErr) return NextResponse.json({ error: unifiedErr.message }, { status: 500 })
      if (runLeadsErr) return NextResponse.json({ error: runLeadsErr.message }, { status: 500 })

      const leadsById = Object.fromEntries((runLeads || []).map((lead) => [lead.id, lead]))
      const byRun = {}
      for (const action of unified || []) {
        const normalized = {
          ...action,
          error_message: action.error_message || action.last_error || null,
        }
        byRun[action.run_id] = byRun[action.run_id] || []
        byRun[action.run_id].push(normalized)
      }
      for (const actions of Object.values(byRun)) {
        actions.sort((a, b) => (a.step_index - b.step_index) || String(a.created_at).localeCompare(String(b.created_at)))
      }

      const executions = (runs || []).map((run) => {
        const lead = run.lead_id ? leadsById[run.lead_id] : null
        const fallback = contactFromPayload(run.raw_payload)
        return {
          lead: {
            id: lead?.id || run.id,
            name: [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || fallback.name || "Event run",
            email: lead?.email || fallback.email,
            phone: lead?.phone_e164 || fallback.phone,
            journey_status: lead?.journey_status || run.status,
            current_step: lead?.current_step ?? run.current_step,
          },
          started_at: run.started_at,
          last_action_at: run.completed_at || run.failed_at || run.updated_at || run.started_at,
          actions: byRun[run.id] || [],
        }
      })

      return NextResponse.json({ data: { journey, executions } })
    }

    // Recent leads enrolled into this journey, regardless of current status.
    const { data: leads, error: leadsErr } = await supabase
      .from("leads")
      .select("id, first_name, last_name, email, phone_e164, journey_status, current_step, created_at, updated_at, last_action_at")
      .eq("tenant_id", tenantId)
      .eq("journey_template", journey.journey_key)
      .order("updated_at", { ascending: false })
      .limit(50)
    if (leadsErr) return NextResponse.json({ error: leadsErr.message }, { status: 500 })

    const leadIds = (leads || []).map(l => l.id)
    if (leadIds.length === 0) {
      return NextResponse.json({ data: { journey, executions: [] } })
    }

    // Fetch all actions for these leads in one round trip.
    // IMPORTANT: actions table is append-only and accumulates across journey
    // enrollments. A lead that was previously enrolled in another journey will
    // carry historical actions tagged with that other journey_key in
    // payload->>'enrolled_via'. Filter so the Recent Runs panel only shows
    // actions that belong to *this* journey enrollment.
    const { data: actions, error: actErr } = await supabase
      .from("actions")
      .select(ACTION_SELECT)
      .in("lead_id", leadIds)
      .order("step_index", { ascending: true })
      .order("created_at", { ascending: true })
    if (actErr) return NextResponse.json({ error: actErr.message }, { status: 500 })

    const byLead = {}
    for (const a of actions || []) {
      // enrolled_via is stamped by advance_journey when each downstream action
      // is created. Initial enrollment actions may not have it set; we treat
      // missing-enrolled_via as "belongs to current journey" only if the lead's
      // journey_template still points here (which is already guaranteed by the
      // leads query above).
      const enrolledVia = a.payload?.enrolled_via
      if (enrolledVia && enrolledVia !== journey.journey_key) continue
      byLead[a.lead_id] = byLead[a.lead_id] || []
      byLead[a.lead_id].push(a)
    }

    const executions = (leads || []).map(l => ({
      lead: {
        id: l.id,
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || null,
        email: l.email,
        phone: l.phone_e164,
        journey_status: l.journey_status,
        current_step: l.current_step,
      },
      started_at: l.created_at,
      last_action_at: l.last_action_at || l.updated_at,
      actions: byLead[l.id] || [],
    }))

    return NextResponse.json({ data: { journey, executions } })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
