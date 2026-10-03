// GET /api/suppressions?channel=&reason=&q=
// POST /api/suppressions       body { entries: [{ channel, identifier, reason, notes }] }
//                              uses add_suppression() RPC so dedup logic is shared with the engine
// DELETE /api/suppressions?id= removes one row

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request)
    const { searchParams } = new URL(request.url)
    const channel = (searchParams.get("channel") || "").trim()
    const reason  = (searchParams.get("reason")  || "").trim()
    const q       = (searchParams.get("q")       || "").trim()

    let query = supabase
      .from("suppressions")
      .select("id, channel, email, phone_e164, reason, source, lead_id, notes, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(500)
    if (channel) query = query.eq("channel", channel)
    if (reason)  query = query.eq("reason", reason)
    if (q) {
      query = query.or(`email.ilike.%${q}%,phone_e164.ilike.%${q}%,notes.ilike.%${q}%`)
    }
    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // For filter dropdowns
    const { data: meta } = await supabase
      .from("suppressions").select("channel, reason").eq("tenant_id", tenantId).limit(5000)
    const channels = Array.from(new Set((meta || []).map(r => r.channel).filter(Boolean))).sort()
    const reasons  = Array.from(new Set((meta || []).map(r => r.reason).filter(Boolean))).sort()

    return NextResponse.json({ data: { rows: data || [], channels, reasons } })
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
    const entries = Array.isArray(body?.entries) ? body.entries : []
    if (entries.length === 0) {
      return NextResponse.json({ error: "entries[] required" }, { status: 400 })
    }

    const results = { added: 0, skipped: 0, errors: [] }
    for (const e of entries) {
      const channel    = (e?.channel    || "").trim() || null
      const identifier = (e?.identifier || "").trim()
      const reason     = (e?.reason     || "manual").trim() || "manual"
      const notes      = e?.notes ? String(e.notes).slice(0, 500) : null
      if (!identifier) { results.skipped++; continue }
      const { error: rpcErr } = await supabase.rpc("add_suppression", {
        p_tenant_id: tenantId,
        p_channel: channel,
        p_identifier: identifier,
        p_reason: reason,
        p_lead_id: null,
        p_source: "manual",
        p_notes: notes,
      })
      if (rpcErr) {
        results.errors.push({ identifier, error: rpcErr.message })
      } else {
        results.added++
      }
    }
    return NextResponse.json({ data: results })
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
      .from("suppressions")
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
