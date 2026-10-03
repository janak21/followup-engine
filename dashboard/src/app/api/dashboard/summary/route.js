import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request)
    const { data, error } = await supabase.rpc("dashboard_summary", { p_tenant_id: tenantId })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
