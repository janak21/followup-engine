// GET /api/journeys/[id]/funnel — per-step counts + median time-to-next-step.
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

    const { data: journey } = await supabase
      .from("journeys").select("id, tenant_id").eq("id", id).maybeSingle()
    if (!journey || journey.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Journey not found" }, { status: 404 })
    }

    const { data, error } = await supabase.rpc("journey_funnel", { p_journey_id: id })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
