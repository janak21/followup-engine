// GET /api/usage?days=30
// Returns: { totals: { sms: {...}, call: {...}, email: {...} },
//            daily:  [{ day, sms, call, email }, ...] }
// Recomputes the requested window first so newly-arrived events are reflected.

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request)
    const { searchParams } = new URL(request.url)
    const days = Math.max(1, Math.min(365, parseInt(searchParams.get("days") || "30", 10)))
    const today = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

    await supabase.rpc("recompute_tenant_usage", {
      p_tenant_id: tenantId,
      p_from: from,
      p_to: today,
    })

    const { data, error } = await supabase
      .from("tenant_usage_daily")
      .select("day, channel, msg_count, units, est_cost_cents")
      .eq("tenant_id", tenantId)
      .gte("day", from)
      .order("day", { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = data || []
    const totals = { sms: blank(), call: blank(), email: blank() }
    const daily = {}
    for (const r of rows) {
      const t = totals[r.channel]
      if (t) {
        t.msg_count += r.msg_count
        t.units += Number(r.units)
        t.est_cost_cents += r.est_cost_cents
      }
      const day = r.day
      daily[day] = daily[day] || { day, sms: 0, call: 0, email: 0, total_cents: 0 }
      daily[day][r.channel] = r.est_cost_cents
      daily[day].total_cents += r.est_cost_cents
    }
    return NextResponse.json({
      data: {
        totals,
        daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
        window_days: days,
      },
    })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}

function blank() {
  return { msg_count: 0, units: 0, est_cost_cents: 0 }
}
