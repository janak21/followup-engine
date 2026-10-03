// Role utilities for the Follow-Up Engine.
//
// Roles (stored on tenant_members.role):
//   owner          — full control + delete tenant
//   admin          — manage everything except billing/membership
//   member         — operate (run actions, edit leads, view dashboards)
//   client_viewer  — read-only access to the client dashboard, leads list,
//                    conversations. Cannot mutate anything.
//
// "Operator" = owner | admin | member. Everyone else (client_viewer or null)
// is treated as view-only.
//
// All helpers read the auth session, so they must be called from a request
// context (Server Components, Route Handlers, middleware).

import { NextResponse } from "next/server"
import { getCurrentUser } from "@/utils/supabase-server"
import { supabase } from "@/utils/supabase"
import { UnauthorizedError } from "@/utils/tenant"

const OPERATOR_ROLES = new Set(["owner", "admin", "member"])

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message)
    this.code = 403
  }
}

/**
 * Resolve { user, tenantId, role } for the current request. Throws Unauthorized
 * if no session, or no membership exists. Service-role callers (no session)
 * also resolve to null user/role and the caller decides.
 */
export async function resolveRequestContext() {
  const user = await getCurrentUser().catch(() => null)
  if (!user) {
    if (process.env.ALLOW_ANON_TENANT === "1") {
      // Local dev backdoor — used by getTenantId already.
      return { user: null, tenantId: null, role: null }
    }
    throw new UnauthorizedError()
  }
  const { data, error } = await supabase
    .from("tenant_members")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new UnauthorizedError("User is not a member of any tenant")
  return { user, tenantId: data.tenant_id, role: data.role }
}

export function isOperatorRole(role) {
  return OPERATOR_ROLES.has(role)
}

export function isClientViewerRole(role) {
  return role === "client_viewer"
}

/**
 * Guard for API route handlers that mutate state. Use at the top of POST/PUT/
 * DELETE/PATCH:
 *
 *     const guard = await requireOperator(request)
 *     if (guard) return guard
 *
 * Returns null when the caller is allowed, or a NextResponse to short-circuit
 * the handler with 401/403.
 */
export async function requireOperator(_request) {
  try {
    const { role } = await resolveRequestContext()
    if (process.env.ALLOW_ANON_TENANT === "1" && !role) return null
    if (!isOperatorRole(role)) {
      return NextResponse.json(
        { error: "This action is not available for your role." },
        { status: 403 }
      )
    }
    return null
  } catch (err) {
    const status = err?.code === 401 ? 401 : err?.code === 403 ? 403 : 500
    return NextResponse.json({ error: err.message || "Unauthorized" }, { status })
  }
}
