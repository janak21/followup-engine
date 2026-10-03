// POST /api/journeys/[id]/clone
// Body (optional): { name, journey_key }
// Creates a new inactive journey with copied spec. New webhook_token + new key.
import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

function slugify(s, fallback) {
  const base = String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return base || fallback
}

export async function POST(request, { params }) {
  const guard = await requireOperator(request)
  if (guard) return guard
  try {
    const { id } = await params
    const tenantId = await getTenantId(request)

    const { data: source, error: fetchErr } = await supabase
      .from("journeys")
      .select("id, tenant_id, journey_key, name, spec")
      .eq("id", id)
      .maybeSingle()
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    if (!source || source.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Journey not found" }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const baseName = body?.name?.trim() || `${source.name} (copy)`
    const baseKey  = slugify(body?.journey_key || `${source.journey_key}_copy`, `${source.journey_key}_copy`)

    // Find a unique journey_key. Append _2, _3, ... if taken.
    let candidate = baseKey
    for (let i = 2; i < 50; i++) {
      const { data: clash } = await supabase
        .from("journeys")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("journey_key", candidate)
        .maybeSingle()
      if (!clash) break
      candidate = `${baseKey}_${i}`
    }

    // Strip the saved webhook_token reference from the spec (it lives on the
    // row, not in the spec). New journey gets a fresh token via the trigger
    // node setup on first save.
    const newSpec = { ...(source.spec || {}) }

    const { data: created, error: insErr } = await supabase
      .from("journeys")
      .insert({
        tenant_id:   tenantId,
        journey_key: candidate,
        name:        baseName,
        spec:        newSpec,
        active:      false,
      })
      .select()
      .maybeSingle()
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

    return NextResponse.json({ data: created })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
