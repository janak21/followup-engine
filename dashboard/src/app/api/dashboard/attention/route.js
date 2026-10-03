import { NextResponse } from "next/server"
import { buildAttentionItems } from "@/lib/attentionItems"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"

const SINCE_7D = 7 * 24 * 3600_000

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request)
    const now = Date.now()
    const since7d = new Date(now - SINCE_7D).toISOString()
    const stuckBefore = new Date(now - 60_000).toISOString()

    const [
      aiRes,
      callbackRes,
      failedRes,
      stuckRes,
      suppressionRes,
      errorRes,
    ] = await Promise.all([
      supabase
        .from("ai_reply_events")
        .select("id, intent, confidence, escalation_reason, created_at, lead_id")
        .eq("tenant_id", tenantId)
        .not("escalation_reason", "is", null)
        .gte("created_at", since7d)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("leads")
        .select("id, first_name, last_name, email, phone_e164, callback_requested, callback_at, journey_status, updated_at, created_at")
        .eq("tenant_id", tenantId)
        .or("callback_requested.eq.true,journey_status.eq.callback_booked")
        .order("callback_at", { ascending: true, nullsFirst: false })
        .limit(20),
      supabase
        .from("actions")
        .select("id, action_type, lead_id, status, error_message, run_at, completed_at, created_at")
        .eq("tenant_id", tenantId)
        .in("status", ["failed", "failed_permanent", "cancelled"])
        .gte("created_at", since7d)
        .order("completed_at", { ascending: false, nullsFirst: false })
        .limit(20),
      supabase
        .from("actions")
        .select("id, action_type, lead_id, locked_until, run_at, created_at")
        .eq("tenant_id", tenantId)
        .eq("status", "in_progress")
        .lt("locked_until", stuckBefore)
        .order("locked_until", { ascending: true })
        .limit(20),
      supabase
        .from("suppressions")
        .select("id, channel, email, phone_e164, reason, source, lead_id, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", since7d)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("error_logs")
        .select("id, severity, status, workflow_name, node_name, error_message, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", since7d)
        .order("created_at", { ascending: false })
        .limit(10),
    ])

    const firstError = [aiRes, callbackRes, failedRes, stuckRes, suppressionRes, errorRes].find((res) => res.error)
    if (firstError?.error) {
      return NextResponse.json({ error: firstError.error.message }, { status: 500 })
    }

    const aiEscalations = (aiRes.data || []).filter((row) => !String(row.escalation_reason || "").startsWith("llm_error"))
    const failedActions = failedRes.data || []
    const stuckActions = stuckRes.data || []
    const suppressions = suppressionRes.data || []
    const callbacks = callbackRes.data || []
    const errors = (errorRes.data || []).filter((row) => !["resolved", "ignored"].includes(row.status))

    const leadIds = Array.from(new Set([
      ...aiEscalations.map((row) => row.lead_id),
      ...failedActions.map((row) => row.lead_id),
      ...stuckActions.map((row) => row.lead_id),
      ...suppressions.map((row) => row.lead_id),
    ].filter(Boolean)))

    const leadMap = await fetchLeadMap(tenantId, leadIds)
    const withLeadNames = (rows) => rows.map((row) => ({
      ...row,
      leadName: leadMap.get(row.lead_id)?.name,
      email: row.email || leadMap.get(row.lead_id)?.email,
      phone_e164: row.phone_e164 || leadMap.get(row.lead_id)?.phone_e164,
    }))

    const items = buildAttentionItems({
      aiEscalations: withLeadNames(aiEscalations),
      callbacks,
      failedActions: withLeadNames(failedActions),
      stuckActions: withLeadNames(stuckActions),
      suppressions: withLeadNames(suppressions),
      errors,
    }, { limit: 8 })

    return NextResponse.json({
      data: {
        items,
        generated_at: new Date().toISOString(),
        source_counts: {
          ai_escalations: aiEscalations.length,
          callbacks: callbacks.length,
          failed_actions: failedActions.length,
          stuck_actions: stuckActions.length,
          suppressions: suppressions.length,
          errors: errors.length,
        },
      },
    })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}

async function fetchLeadMap(tenantId, leadIds) {
  if (leadIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from("leads")
    .select("id, first_name, last_name, email, phone_e164")
    .eq("tenant_id", tenantId)
    .in("id", leadIds)
  if (error) throw error
  return new Map((data || []).map((lead) => {
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email || lead.phone_e164 || "Lead"
    return [lead.id, { ...lead, name }]
  }))
}
