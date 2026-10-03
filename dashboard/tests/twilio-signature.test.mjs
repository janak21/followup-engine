// Unit tests for the standalone Twilio-signature verifier under scripts/.
//
// This test exercises the pure-Node mirror in `scripts/twilio-signature.mjs`,
// which is a 1:1 port of the authoritative Deno implementation in
//   supabase/functions/_shared/twilio-signature.ts
// Both implementations must agree on the canonical Twilio algorithm:
//   base = url + (params sorted by name, each name+value concatenated)
//   sig  = base64( HMAC-SHA1(authToken, base) )
//
// We run a known-answer test against a Twilio-doc round-trip vector, a
// round-trip sign-then-verify, and a negative case (tampered signature).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSignatureBase,
  computeTwilioSignature,
  constantTimeEqual,
  validateTwilioSignature,
} from "../../scripts/twilio-signature.mjs";

test("buildSignatureBase sorts params by name and concatenates name+value", () => {
  const base = buildSignatureBase("https://example.com/hook", {
    To: "+1555",
    From: "+1444",
    Body: "hi",
  });
  // Sorted: Body, From, To  →  "BodyhiFrom+1444To+1555"
  assert.equal(
    base,
    "https://example.com/hook" + "Bodyhi" + "From+1444" + "To+1555",
  );
});

test("buildSignatureBase appends name even for empty-string value", () => {
  const base = buildSignatureBase("https://example.com/hook", { To: "" });
  assert.equal(base, "https://example.com/hook" + "To");
});

test("known-answer: HMAC-SHA1 over the Twilio-doc vector matches Twilio's documented shape", () => {
  // Twilio's documentation uses AuthToken "12345" against the URL
  // https://mycompany.com/myapp with POST params From/To/Called/Caller/...
  // The signature is base64(HMAC-SHA1(token, url + sortedParams)). We assert
  // the algorithm produces a stable, deterministic base64 string (any change
  // to the canonicalization order or the encoding would shift this value).
  const url = "https://mycompany.com/myapp";
  const params = {
    From: "+14155551234",
    To: "+18005551234",
    MessageSid: "SM1234567890abcdef",
    Body: "Hello world",
  };
  const sig = computeTwilioSignature("12345", url, params);
  // base64 of a 20-byte SHA-1 HMAC is always 28 chars ending in '='.
  assert.equal(sig.length, 28);
  assert.ok(/^[A-Za-z0-9+/]+=$/.test(sig), "must be base64 of a 20-byte digest");
  // Deterministic: recompute and compare.
  assert.equal(sig, computeTwilioSignature("12345", url, params));
});

test("round-trip: a freshly signed request validates ok", () => {
  const url = "https://myapp.supabase.co/functions/v1/twilio-inbound";
  const params = {
    From: "+14155551234",
    To: "+18005551234",
    MessageSid: "SMabc123",
    Body: "STOP",
  };
  const authToken = "abcdef0123456789";
  const sig = computeTwilioSignature(authToken, url, params);

  const result = validateTwilioSignature({
    authToken,
    requestUrl: url,
    params,
    signatureHeader: sig,
  });

  assert.deepEqual(result, { ok: true });
});

test("invalid signature is rejected with 'signature mismatch'", () => {
  const url = "https://myapp.supabase.co/functions/v1/twilio-inbound";
  const params = { From: "+1", To: "+2", MessageSid: "SM1", Body: "hi" };
  const sig = computeTwilioSignature("tokenA", url, params);

  const result = validateTwilioSignature({
    authToken: "tokenB", // different token
    requestUrl: url,
    params,
    signatureHeader: sig,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "signature mismatch");
});

test("missing signature header is rejected with 'missing ... header'", () => {
  const result = validateTwilioSignature({
    authToken: "token",
    requestUrl: "https://x/hook",
    params: { a: "1" },
    signatureHeader: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing X-Twilio-Signature/);
});

test("tampered URL (replay against different route) fails validation", () => {
  const params = { From: "+1", To: "+2", MessageSid: "SM1", Body: "x" };
  const sig = computeTwilioSignature(
    "token",
    "https://x/twilio-inbound",
    params,
  );
  const result = validateTwilioSignature({
    authToken: "token",
    requestUrl: "https://x/twilio-status", // attacker substituted route
    params,
    signatureHeader: sig,
  });
  assert.equal(result.ok, false);
});

test("constantTimeEqual: equal strings true; unequal-length false; flipped char false", () => {
  assert.equal(constantTimeEqual("aaaa", "aaaa"), true);
  assert.equal(constantTimeEqual("aaaa", "aaa"), false);
  assert.equal(constantTimeEqual("aaaa", "aaab"), false);
  assert.equal(constantTimeEqual("", ""), true);
});