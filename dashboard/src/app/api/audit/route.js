// GET /api/audit?actor=&table=&op=&days=30&limit=200
// Returns recent audit_log entries scoped to the caller's tenant.
// Filters: actor (email substring), table (exact name), op (INSERT|UPDATE|DELETE), days back.

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

export async function GET(request) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const tenantId = await getTenantId(request)
    const { searchParams } = new URL(request.url)
    const actor   = (searchParams.get("actor") || "").trim().toLowerCase()
    const table   = (searchParams.get("table") || "").trim()
    const op      = (searchParams.get("op")    || "").trim().toUpperCase()
    const days    = Math.max(1, Math.min(180, parseInt(searchParams.get("days") || "30", 10)))
    const limit   = Math.max(10, Math.min(500, parseInt(searchParams.get("limit") || "200", 10)))

    let q = supabase
      .from("audit_log")
      .select("id, at, actor_id, actor_email, table_name, row_id, op, before, after, changed_keys")
      .eq("tenant_id", tenantId)
      .gte("at", new Date(Date.now() - days * 86400000).toISOString())
      .order("at", { ascending: false })
      .limit(limit)

    if (table)         q = q.eq("table_name", table)
    if (["INSERT","UPDATE","DELETE"].includes(op)) q = q.eq("op", op)
    if (actor)         q = q.ilike("actor_email", `%${actor}%`)

    const { data, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Build a distinct-table list so the UI's filter dropdown stays accurate.
    const { data: tableData } = await supabase
      .from("audit_log").select("table_name").eq("tenant_id", tenantId).limit(2000)
    const tables = Array.from(new Set((tableData || []).map(r => r.table_name))).sort()

    return NextResponse.json({ data: { rows: data || [], tables } })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
