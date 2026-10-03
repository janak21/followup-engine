// POST /api/tenant/active
//
// Sets the signed, httpOnly `active_tenant_id` cookie after verifying the
// requested tenant is one the current user actually belongs to. The cookie is
// only a hint; every API route re-verifies membership via getTenantId().
//
// GET /api/tenant/active returns the server-resolved active tenant id so the
// switcher UI can stay in sync without reading the httpOnly cookie.
//
// DELETE /api/tenant/active clears the cookie.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/utils/supabase-server";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";
import {
  ACTIVE_TENANT_COOKIE_NAME,
  getActiveTenantCookieSecret,
  signActiveTenantId,
  buildActiveTenantCookie,
  buildClearCookie,
} from "@/utils/activeTenantCookie";

function isValidUuid(value) {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(request) {
  try {
    const tenantId = await getTenantId(request);
    if (!tenantId) {
      return NextResponse.json({ error: "No tenant resolved" }, { status: 404 });
    }
    return NextResponse.json({ tenant_id: tenantId });
  } catch (err) {
    const status = err?.code === 401 ? 401 : 500;
    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status }
    );
  }
}

export async function POST(request) {
  try {
    const user = await getCurrentUser().catch(() => null);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const tenantId = body?.tenant_id;

    if (!isValidUuid(tenantId)) {
      return NextResponse.json({ error: "Invalid tenant_id" }, { status: 400 });
    }

    // Verify membership server-side. Never trust the cookie alone.
    const { data: membership, error: mErr } = await supabase
      .from("tenant_members")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!membership) {
      return NextResponse.json(
        { error: "You are not a member of this tenant" },
        { status: 403 }
      );
    }

    const secret = getActiveTenantCookieSecret();
    const signed = signActiveTenantId(tenantId, secret);

    const response = NextResponse.json({ ok: true, tenant_id: tenantId });
    response.cookies.set(buildActiveTenantCookie(signed));
    // Clear the legacy client-written tenant_id cookie so it cannot confuse
    // any remaining client-side code.
    response.cookies.set(buildClearCookie("tenant_id"));
    return response;
  } catch (err) {
    console.error("Error setting active tenant:", err);
    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const response = NextResponse.json({ ok: true });
    response.cookies.set(buildClearCookie(ACTIVE_TENANT_COOKIE_NAME));
    response.cookies.set(buildClearCookie("tenant_id"));
    return response;
  } catch (err) {
    console.error("Error clearing active tenant cookie:", err);
    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
