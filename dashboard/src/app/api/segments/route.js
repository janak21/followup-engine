// GET    /api/segments              — list segments for the current tenant
// POST   /api/segments               — body { name, filters }   creates/upserts by name
// DELETE /api/segments?id=          — remove one

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request)
    const { data, error } = await supabase
      .from("lead_segments")
      .select("id, name, filters, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data: data || [] })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}

export async function POST(request) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const tenantId = await getTenantId(request)
    const body = await request.json()
    const name = String(body?.name || "").trim()
    const filters = body?.filters && typeof body.filters === "object" ? body.filters : {}
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })

    const { data, error } = await supabase
      .from("lead_segments")
      .upsert({ tenant_id: tenantId, name, filters, updated_at: new Date().toISOString() },
              { onConflict: "tenant_id,name" })
      .select()
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}

export async function DELETE(request) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const tenantId = await getTenantId(request)
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
    const { error } = await supabase
      .from("lead_segments")
      .delete()
      .eq("id", id)
      .eq("tenant_id", tenantId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
