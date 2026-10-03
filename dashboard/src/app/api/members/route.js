// Tenant membership API.
//   GET    — list current members + pending invites for the caller's tenant.
//   POST   — invite an email at a role.
//   DELETE — revoke a pending invite (?inviteId=) or remove a member (?memberId=).
//
// Mutating endpoints are operator-only.

import { NextResponse } from "next/server"
import { getTenantId } from "@/utils/tenant"
import { supabase } from "@/utils/supabase"
import { requireOperator } from "@/utils/role"

const VALID_ROLES = new Set(["owner", "admin", "member", "client_viewer"])

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request)

    const [membersRes, invitesRes] = await Promise.all([
      supabase
        .from("tenant_members")
        .select("id, role, created_at, user_id")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true }),
      supabase
        .from("tenant_invites")
        .select("id, email, role, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true }),
    ])

    if (membersRes.error) return NextResponse.json({ error: membersRes.error.message }, { status: 500 })
    if (invitesRes.error) return NextResponse.json({ error: invitesRes.error.message }, { status: 500 })

    // Hydrate member emails by looking up auth.users via the admin API.
    const userIds = (membersRes.data || []).map(m => m.user_id)
    const emailById = {}
    for (const uid of userIds) {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid)
        if (data?.user?.email) emailById[uid] = data.user.email
      } catch {
        // best-effort
      }
    }

    return NextResponse.json({
      data: {
        members: (membersRes.data || []).map(m => ({ ...m, email: emailById[m.user_id] || null })),
        invites: invitesRes.data || [],
      },
    })
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
    const { email, role } = await request.json()
    const clean = String(email || "").trim().toLowerCase()
    const cleanRole = String(role || "client_viewer")
    if (!clean) return NextResponse.json({ error: "email is required" }, { status: 400 })
    if (!VALID_ROLES.has(cleanRole)) {
      return NextResponse.json({ error: `role must be one of: ${[...VALID_ROLES].join(", ")}` }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("tenant_invites")
      .upsert({ tenant_id: tenantId, email: clean, role: cleanRole }, { onConflict: "email,tenant_id" })
      .select()
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // If the auth user already exists for this email, consume the invite
    // immediately rather than waiting for the signup trigger.
    try {
      const { data: list } = await supabase.auth.admin.listUsers({ filter: `email.eq.${clean}` })
      const existing = list?.users?.find(u => u.email?.toLowerCase() === clean)
      if (existing) {
        await supabase.from("tenant_members").upsert(
          { tenant_id: tenantId, user_id: existing.id, role: cleanRole },
          { onConflict: "tenant_id,user_id" }
        )
        await supabase.from("tenant_invites").delete().eq("id", data.id)
      }
    } catch {}

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
    const inviteId = searchParams.get("inviteId")
    const memberId = searchParams.get("memberId")
    if (!inviteId && !memberId) {
      return NextResponse.json({ error: "inviteId or memberId is required" }, { status: 400 })
    }

    if (inviteId) {
      const { error } = await supabase
        .from("tenant_invites")
        .delete()
        .eq("id", inviteId)
        .eq("tenant_id", tenantId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (memberId) {
      const { error } = await supabase
        .from("tenant_members")
        .delete()
        .eq("id", memberId)
        .eq("tenant_id", tenantId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status })
  }
}
