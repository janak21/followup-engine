import { supabase } from "@/utils/supabase"
import { getCurrentUser } from "@/utils/supabase-server"

const SEED_TENANT = "00000000-0000-0000-0000-000000000001"

function isDevAnonAllowed() {
  return process.env.ALLOW_ANON_TENANT === "1"
}

/**
 * Resolve the tenant for the current request from the auth session.
 *
 *   1. If the user is signed in, return the earliest tenant_members row for
 *      that user. Multi-tenant switching is a later feature; today one user → one tenant.
 *   2. If ALLOW_ANON_TENANT=1 (dev only) and no session, fall back to the seed
 *      tenant so local development keeps working. NEVER set this in production.
 *   3. Otherwise throw UnauthorizedError — the API route maps to a 401.
 *
 * Also pushes the auth user id into the per-tx GUC `app.current_actor` so the
 * audit triggers can capture who made the change.
 */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message)
    this.code = 401
  }
}

export async function getTenantId(_request) {
  let user = null
  try {
    user = await getCurrentUser()
  } catch {
    // getCurrentUser throws when called outside a request context; treat as anon.
  }

  if (user) {
    await setAuditActor(user.id)
    const { data, error } = await supabase
      .from("tenant_members")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new UnauthorizedError("User is not a member of any tenant")
    return data.tenant_id
  }

  if (isDevAnonAllowed()) {
    try {
      const { data } = await supabase
        .from("tenants")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
      if (data?.id) return data.id
    } catch {}
    return SEED_TENANT
  }

  throw new UnauthorizedError()
}

// Push the auth user id into a per-transaction GUC so audit_row_change() can
// pick it up. Best-effort; failures are swallowed because audit is
// observability, not correctness.
export async function setAuditActor(userId) {
  try {
    await supabase.rpc("set_audit_actor", { p_actor: userId })
  } catch {}
}
