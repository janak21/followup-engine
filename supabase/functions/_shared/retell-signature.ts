// Retell webhook signature verification using Web Crypto (no SDK dependency).
//
// Retell signs every webhook with HMAC-SHA256 (keyed by the account's Retell
// API Key) over the concatenation of the RAW request body + the timestamp
// string carried in the same header. The header format is:
//
//     X-Retell-Signature: v=<unix-millis>,d=<hex-sha256-digest>
//
// where digest = HMAC-SHA256(apiKey, rawBody + timestampString).
//
// Replay protection: Retell requires rejecting requests whose timestamp is
// more than 5 minutes from the server's clock.
//
// Spec reference: https://docs.retellai.com/features/secure-webhook
// ("Verify Without SDK").
//
// NOTE: this is per-ACCOUNT signing (Retell does NOT sign per-agent); the same
// API key validates every webhook from the account. Per-tenant signing is
// therefore not applicable — a single deployment uses one Retell account.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

export interface RetellSignatureParts {
  timestamp: string;
  digest: string;
}

const HEADER_RE = /^v=(\d+),d=(.+)$/;

/** Parse the `X-Retell-Signature` header. Returns null if malformed. */
export function parseRetellSignature(header: string | null): RetellSignatureParts | null {
  if (!header) return null;
  const m = header.trim().match(HEADER_RE);
  if (!m) return null;
  const [, timestamp, digest] = m;
  if (!/^\d+$/.test(timestamp)) return null;
  if (!/^[0-9a-fA-F]+$/.test(digest)) return null;
  return { timestamp, digest: digest.toLowerCase() };
}

/** Constant-time string comparison (mitigates timing-attack on the digest). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface RetellVerifyOptions {
  apiKey: string;
  rawBody: string;
  signatureHeader: string | null;
  /** Allowed skew between header timestamp and now, in ms. Default 5 min. */
  toleranceMs?: number;
  /** Injectable now() for tests; defaults to Date.now(). */
  nowMs?: () => number;
}

export interface RetellVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a Retell webhook request end-to-end:
 *   1. Parse the `X-Retell-Signature` header.
 *   2. Reject if the timestamp is older than `toleranceMs` (replay guard).
 *   3. Compute HMAC-SHA256(apiKey, rawBody + timestampString) as hex.
 *   4. Constant-time compare to the header digest.
 *
 * CRITICAL: `rawBody` MUST be the original request body bytes decoded as UTF-8.
 * Re-serializing parsed JSON changes whitespace / key ordering and breaks the
 * signature (Retell explicitly warns about this in their docs).
 */
export async function verifyRetellWebhook(
  opts: RetellVerifyOptions,
): Promise<RetellVerifyResult> {
  const { apiKey, rawBody, signatureHeader } = opts;
  const toleranceMs = opts.toleranceMs ?? 5 * 60 * 1000;
  const nowMs = opts.nowMs ?? (() => Date.now());

  const parts = parseRetellSignature(signatureHeader);
  if (!parts) {
    return { ok: false, reason: "missing or malformed X-Retell-Signature header" };
  }

  const ts = Number(parts.timestamp);
  const skew = Math.abs(nowMs() - ts);
  if (skew > toleranceMs) {
    return { ok: false, reason: `timestamp out of tolerance (skew=${skew}ms)` };
  }

  const keyBytes = new TextEncoder().encode(apiKey);
  const dataBytes = new TextEncoder().encode(rawBody + parts.timestamp);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBuf = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, dataBytes));
  const computedHex = Array.from(sigBuf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (constantTimeEqual(computedHex, parts.digest)) {
    return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}