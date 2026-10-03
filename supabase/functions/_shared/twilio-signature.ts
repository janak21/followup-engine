// Twilio request-signature validation using Web Crypto (no SDK dependency).
//
// Twilio signs every webhook request with HMAC-SHA1 (keyed by the Account Auth
// Token) over the concatenation of:
//     <full request URL> + <sorted POST params as key+value, concatenated>
// then base64-encodes the digest and sends it in the `X-Twilio-Signature` header.
//
// Spec reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// This file imports ONLY from `jsr:@supabase/functions-js/edge-runtime.d.ts` for
// typings, so it is safe to import from any edge function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

export interface TwilioCreds {
  auth_token: string;
  account_sid?: string;
}

/**
 * Build the canonical string Twilio signs for a webhook request.
 *
 *   canonical = url + k1v1k2v2...knvn   (params sorted by key, value as-is)
 *
 * Twilio sorts by *parameter name*, and for each pair appends the NAME then the
 * VALUE with no separators between pairs. Empty-string values ARE included
 * (Twilio appends "k" + "").
 */
export function buildSignatureBase(
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramsPart = sortedKeys.map((k) => `${k}${params[k] ?? ""}`).join("");
  return `${url}${paramsPart}`;
}

/** HMAC-SHA1, keyed by authToken, returns base64 string (Twilio's format). */
export async function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const keyBytes = new TextEncoder().encode(authToken);
  const dataBytes = new TextEncoder().encode(buildSignatureBase(url, params));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, dataBytes),
  );

  // base64 encode
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return btoa(bin);
}

/** Constant-time equality to mitigate timing-attack on the signature compare. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Reconstruct the public URL Twilio signed and validate the header.
 *
 * Twilio signs the EXACT URL it POSTed to. Edge functions sit behind the
 * Supabase gateway; the original host/scheme/path can be reconstructed from
 * the request URL. If a reverse proxy rewrites the path, override with
 * `xForwardedProto` / `xForwardedHost` / `xForwardedPath` (resolved by the
 * caller from `X-Forwarded-*` headers — left explicit so callers opt in).
 */
export async function validateTwilioSignature(opts: {
  authToken: string;
  requestUrl: string;
  params: Record<string, string>;
  signatureHeader: string | null;
}): Promise<ValidationResult> {
  const { authToken, requestUrl, params, signatureHeader } = opts;
  if (!signatureHeader) {
    return { ok: false, reason: "missing X-Twilio-Signature header" };
  }
  const computed = await computeTwilioSignature(authToken, requestUrl, params);
  if (constantTimeEqual(computed, signatureHeader)) {
    return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}