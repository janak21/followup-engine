// Signed cookie helpers for the active-tenant switcher.
//
// The browser is never trusted for tenant membership. The cookie value is only
// a hint; `getTenantId()` re-verifies the decoded tenant_id against the user's
// server-side `tenant_members` rows on every request.

import crypto from "crypto";

export const ACTIVE_TENANT_COOKIE_NAME = "active_tenant_id";
export const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function getActiveTenantCookieSecret() {
  const secret = process.env.ACTIVE_TENANT_COOKIE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error(
      "ACTIVE_TENANT_COOKIE_SECRET (or SUPABASE_SERVICE_ROLE_KEY as a dev fallback) is required"
    );
  }
  return secret;
}

/**
 * Sign a tenant id as `<tenantId>.<hmac>`. Returns null for null/empty input.
 */
export function signActiveTenantId(tenantId, secret) {
  if (!tenantId || !secret) return null;
  const payload = String(tenantId);
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/**
 * Parse a signed tenant id cookie. Returns the tenant id if the signature is
 * valid, otherwise null. Rejects malformed or empty values.
 */
export function parseActiveTenantId(signedValue, secret) {
  if (!signedValue || !secret || typeof signedValue !== "string") return null;
  const parts = signedValue.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
      return null;
    }
  } catch {
    // signature lengths differ or not hex
    return null;
  }
  return payload;
}

function isSecureContext() {
  return process.env.NODE_ENV === "production";
}

/**
 * Build the Set-Cookie options for the active tenant cookie.
 * The value must already be signed with signActiveTenantId().
 */
export function buildActiveTenantCookie(value, options = {}) {
  return {
    name: ACTIVE_TENANT_COOKIE_NAME,
    value: value || "",
    httpOnly: true,
    secure: isSecureContext(),
    sameSite: "lax",
    path: "/",
    maxAge: value ? ONE_YEAR_SECONDS : 0,
    ...options,
  };
}

/**
 * Build the options for a Set-Cookie that clears the old/legacy tenant_id
 * cookie (and the active tenant cookie if needed).
 */
export function buildClearCookie(name) {
  return {
    name,
    value: "",
    httpOnly: true,
    secure: isSecureContext(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}
