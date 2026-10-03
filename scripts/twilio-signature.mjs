// Standalone Node verifier for Twilio X-Twilio-Signature.
//
// Pure JS (uses node:crypto) so the dashboard test suite (node --test) can
// exercise the algorithm without importing the Deno-only edge-function helper.
// The Deno implementation in
//   supabase/functions/_shared/twilio-signature.ts
// is authoritative; this script mirrors it 1:1 so a shared test vector pins
// both implementations to the same expected output.
//
// Twilio algorithm (see https://www.twilio.com/docs/usage/webhooks/webhooks-security):
//   base = url + k1v1k2v2...knvn   (params sorted by name; append name then value)
//   sig  = base64( HMAC-SHA1(authToken, base) )

import { createHmac } from "node:crypto";

export function buildSignatureBase(url, params) {
  const sortedKeys = Object.keys(params).sort();
  const paramsPart = sortedKeys.map((k) => `${k}${params[k] ?? ""}`).join("");
  return `${url}${paramsPart}`;
}

export function computeTwilioSignature(authToken, url, params) {
  const base = buildSignatureBase(url, params);
  return createHmac("sha1", authToken).update(base).digest("base64");
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function validateTwilioSignature({ authToken, requestUrl, params, signatureHeader }) {
  if (!signatureHeader) return { ok: false, reason: "missing X-Twilio-Signature header" };
  const computed = computeTwilioSignature(authToken, requestUrl, params);
  return constantTimeEqual(computed, signatureHeader)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}