// Standalone Node verifier for Retell X-Retell-Signature.
//
// Pure JS (uses node:crypto) so the dashboard test suite (node --test) can
// exercise the algorithm without importing the Deno-only edge-function helper
// at supabase/functions/_shared/retell-signature.ts (which is authoritative
// and a 1:1 port of this file). Both must agree.
//
// Retell algorithm (see https://docs.retellai.com/features/secure-webhook):
//   header = `v=<unix-millis>,d=<hex-sha256-digest>`
//   digest = HMAC-SHA256(apiKey, rawBody + timestampString)
//   reject if |now - timestamp| > 5 minutes  (replay guard)

import { createHmac, timingSafeEqual } from "node:crypto";

export function parseRetellSignature(header) {
  if (typeof header !== "string") return null;
  const m = header.trim().match(/^v=(\d+),d=(.+)$/);
  if (!m) return null;
  const [, timestamp, digest] = m;
  if (!/^\d+$/.test(timestamp)) return null;
  if (!/^[0-9a-fA-F]+$/.test(digest)) return null;
  return { timestamp, digest: digest.toLowerCase() };
}

export function computeRetellDigest(apiKey, rawBody, timestampStr) {
  return createHmac("sha256", apiKey)
    .update(rawBody + timestampStr)
    .digest("hex");
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  // Use node's timingSafeEqual when lengths match.
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function verifyRetellWebhook({
  apiKey,
  rawBody,
  signatureHeader,
  toleranceMs = 5 * 60 * 1000,
  nowMs = () => Date.now(),
}) {
  const parts = parseRetellSignature(signatureHeader);
  if (!parts) {
    return { ok: false, reason: "missing or malformed X-Retell-Signature header" };
  }
  const ts = Number(parts.timestamp);
  const skew = Math.abs(nowMs() - ts);
  if (skew > toleranceMs) {
    return { ok: false, reason: `timestamp out of tolerance (skew=${skew}ms)` };
  }
  const computed = computeRetellDigest(apiKey, rawBody, parts.timestamp);
  return constantTimeEqual(computed, parts.digest)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/** Sign a payload — used by tests to produce a valid header. */
export function signRetellWebhook(apiKey, rawBody, timestampStr) {
  return `v=${timestampStr},d=${computeRetellDigest(apiKey, rawBody, timestampStr)}`;
}