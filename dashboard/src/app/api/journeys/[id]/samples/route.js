// GET    /api/journeys/[id]/samples              — last N webhook samples
// POST   /api/journeys/[id]/samples              — body { sample_id } replays through engine
// Result fields on each sample: received_at, payload, headers, result_status,
//   result_reason, result_lead_id, result_action_id, result_message, plus
//   event workflow run/action metadata when the remote migration is present.

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

export async function GET(request, { params }) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const { id } = await params
    const tenantId = await getTenantId(request)

    // RLS: ensure the journey belongs to this tenant.
    const { data: journey } = await supabase
      .from("journeys").select("id, tenant_id, journey_key, webhook_token, webhook_auth_mode")
      .eq("id", id).maybeSingle()
    if (!journey || journey.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Journey not found" }, { status: 404 })
    }

    const { data, error } = await supabase
      .from("journey_webhook_samples")
      .select("id, received_at, payload, headers, result_status, result_reason, result_lead_id, result_action_id, result_message, result_run_id, result_workflow_action_id, result_details")
      .eq("journey_id", id)
      .order("received_at", { ascending: false })
      .limit(20)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data: { journey, samples: data || [] } })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}

// POST body: { sample_id: uuid } — replay that sample through process_journey_webhook
// so the user can iterate on webhook_mapping without re-submitting from the upstream tool.
export async function POST(request, { params }) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const { id } = await params
    const tenantId = await getTenantId(request)
    const body = await request.json()
    const sampleId = body?.sample_id
    if (!sampleId) return NextResponse.json({ error: "sample_id required" }, { status: 400 })

    // Ensure the sample belongs to a journey in this tenant.
    const { data: sample } = await supabase
      .from("journey_webhook_samples")
      .select("id, journey_id, payload, headers, journeys!inner(tenant_id, webhook_token)")
      .eq("id", sampleId)
      .maybeSingle()
    if (!sample || sample.journey_id !== id || sample.journeys?.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Sample not found" }, { status: 404 })
    }
    if (!sample.journeys?.webhook_token) {
      return NextResponse.json({ error: "Journey webhook token not found" }, { status: 400 })
    }

    const headers = { ...(sample.headers || {}) }
    delete headers["idempotency-key"]
    delete headers["Idempotency-Key"]
    delete headers["x-idempotency-key"]
    delete headers["X-Idempotency-Key"]
    headers["Idempotency-Key"] = `manual-replay:${sampleId}:${Date.now()}`

    const { data, error } = await supabase.rpc("process_journey_webhook", {
      p_token: sample.journeys.webhook_token,
      p_payload: sample.payload || {},
      p_headers: headers,
      p_auth_header: null,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      data: {
        ...(data || {}),
        replay: true,
        replayed_from_sample_id: sampleId,
      }
    })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
