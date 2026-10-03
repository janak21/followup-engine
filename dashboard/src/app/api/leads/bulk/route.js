// POST /api/leads/bulk
// Body: { lead_ids: uuid[], op: 'exit'|'reenroll'|'set_field', value?: any, journey_template?: string }
//
// Operations:
//   exit         → journey_status = 'completed', cancels pending actions via the existing trigger.
//   reenroll     → journey_template = value, journey_status='active', current_step=0,
//                  cancels any pending actions, queues step 0 if journey defines one.
//   set_field    → updates one custom field on every selected lead. { field, value } in body.

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

export async function POST(request) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const tenantId = await getTenantId(request)
    const body = await request.json()
    const leadIds = Array.isArray(body?.lead_ids) ? body.lead_ids.filter(Boolean) : []
    if (leadIds.length === 0) return NextResponse.json({ error: "lead_ids required" }, { status: 400 })
    if (leadIds.length > 5000) return NextResponse.json({ error: "max 5000 leads per call" }, { status: 400 })

    const op = String(body?.op || "").trim()
    if (!["exit", "reenroll", "set_field"].includes(op)) {
      return NextResponse.json({ error: "op must be exit | reenroll | set_field" }, { status: 400 })
    }

    let updated = 0
    if (op === "exit") {
      const { data, error } = await supabase
        .from("leads")
        .update({ journey_status: "completed" })
        .eq("tenant_id", tenantId)
        .in("id", leadIds)
        .select("id")
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      updated = (data || []).length
    } else if (op === "reenroll") {
      const journey = String(body?.journey_template || "").trim()
      if (!journey) return NextResponse.json({ error: "journey_template required for reenroll" }, { status: 400 })

      // Cancel any pending actions on these leads first so they don't double-fire.
      await supabase.from("actions")
        .update({ status: "cancelled", error_message: "bulk_reenroll" })
        .in("lead_id", leadIds)
        .eq("status", "pending")

      const { data, error } = await supabase
        .from("leads")
        .update({ journey_template: journey, journey_status: "active", current_step: 0 })
        .eq("tenant_id", tenantId)
        .in("id", leadIds)
        .select("id, tenant_id, journey_template")
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      // Queue step 0 action for each enrolled lead so the dispatcher picks them up.
      const { data: journeyRow } = await supabase
        .from("journeys")
        .select("spec")
        .eq("tenant_id", tenantId)
        .eq("journey_key", journey)
        .eq("active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()
      const step0 = (journeyRow?.spec?.steps || []).find(s => s.index === 0)
      if (step0) {
        const inserts = (data || []).map(l => ({
          tenant_id: tenantId,
          lead_id: l.id,
          action_type: step0.type,
          step_index: 0,
          template_key: step0.template_key || null,
          run_at: new Date().toISOString(),
          status: "pending",
          idempotency_key: `${l.id}:${journey}:0:bulk_reenroll:${Date.now()}`,
          payload: { enrolled_via: "bulk_reenroll", step_spec: step0 },
        }))
        if (inserts.length > 0) {
          await supabase.from("actions").insert(inserts)
        }
      }
      updated = (data || []).length
    } else if (op === "set_field") {
      const field = String(body?.field || "").trim()
      const value = body?.value
      if (!field) return NextResponse.json({ error: "field required" }, { status: 400 })

      // Mutate one row at a time so each row's existing custom_fields is preserved.
      const { data: leads } = await supabase
        .from("leads")
        .select("id, custom_fields")
        .eq("tenant_id", tenantId)
        .in("id", leadIds)
      for (const l of leads || []) {
        const next = { ...(l.custom_fields || {}), [field]: value }
        const { error: upErr } = await supabase
          .from("leads")
          .update({ custom_fields: next })
          .eq("id", l.id)
          .eq("tenant_id", tenantId)
        if (!upErr) updated++
      }
    }

    return NextResponse.json({ data: { op, updated } })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
