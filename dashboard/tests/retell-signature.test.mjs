// Unit tests for the standalone Retell-signature verifier under scripts/.
//
// This is a 1:1 Node port of the authoritative Deno implementation at
//   supabase/functions/_shared/retell-signature.ts
// Both must agree on the canonical Retell algorithm:
//   header = `v=<unix-millis>,d=<hex-sha256-digest>`
//   digest = HMAC-SHA256(apiKey, rawBody + timestampString)
//   reject if |now - timestamp| > 5 minutes  (replay guard)
//
// We exercise header parsing, sign-then-verify round-trip, replay-window
// rejection, tampered-body rejection, tampered-route (wrong key) rejection,
// and malformed-header rejection.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRetellDigest,
  parseRetellSignature,
  signRetellWebhook,
  verifyRetellWebhook,
} from "../../scripts/retell-signature.mjs";

const API_KEY = "test-retell-api-key-abcdef";
const NOW = 1_700_000_000_000;

function sampleBody(extras = {}) {
  return JSON.stringify({
    event: "call_analyzed",
    call: {
      call_id: "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      from_number: "+12137771234",
      to_number: "+12137771235",
      ...extras,
    },
  });
}

test("parseRetellSignature: valid header parses to {timestamp, digest}", () => {
  const parsed = parseRetellSignature("v=1700000000000,d=deadbeef");
  assert.deepEqual(parsed, { timestamp: "1700000000000", digest: "deadbeef" });
});

test("parseRetellSignature: lowercases uppercase hex digest", () => {
  const parsed = parseRetellSignature("v=1700000000000,d=DEADBEEF");
  assert.equal(parsed.digest, "deadbeef");
});

test("parseRetellSignature: rejects null / malformed / non-numeric timestamp / non-hex digest", () => {
  assert.equal(parseRetellSignature(null), null);
  assert.equal(parseRetellSignature(""), null);
  assert.equal(parseRetellSignature("garbage"), null);
  assert.equal(parseRetellSignature("v=abc,d=deadbeef"), null); // non-numeric ts
  assert.equal(parseRetellSignature("v=1700000000000,d=not-hex"), null);
  assert.equal(parseRetellSignature("v=1700000000000"), null); // missing d=
});

test("round-trip: a freshly signed request validates ok", () => {
  const raw = sampleBody();
  const header = signRetellWebhook(API_KEY, raw, String(NOW));
  const result = verifyRetellWebhook({
    apiKey: API_KEY,
    rawBody: raw,
    signatureHeader: header,
    nowMs: () => NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test("known-answer: digest is a stable deterministic hex string", () => {
  const raw = sampleBody();
  const digest = computeRetellDigest(API_KEY, raw, String(NOW));
  // HMAC-SHA256 hex is always 64 lowercase hex chars.
  assert.equal(digest.length, 64);
  assert.ok(/^[0-9a-f]+$/.test(digest), "digest must be lowercase hex");
  // Deterministic.
  assert.equal(digest, computeRetellDigest(API_KEY, raw, String(NOW)));
});

test("replay: timestamp older than 5 min is rejected even if digest is correct", () => {
  const raw = sampleBody();
  const staleTs = NOW - 6 * 60 * 1000; // 6 minutes ago
  const header = signRetellWebhook(API_KEY, raw, String(staleTs));
  const result = verifyRetellWebhook({
    apiKey: API_KEY,
    rawBody: raw,
    signatureHeader: header,
    nowMs: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /out of tolerance/);
});

test("replay: timestamp exactly at 5-min boundary is allowed; 5min+1ms rejected", () => {
  const raw = sampleBody();
  const boundaryTs = NOW - 5 * 60 * 1000;
  const headerOk = signRetellWebhook(API_KEY, raw, String(boundaryTs));
  assert.equal(
    verifyRetellWebhook({ apiKey: API_KEY, rawBody: raw, signatureHeader: headerOk, nowMs: () => NOW }).ok,
    true,
  );
  const overTs = NOW - 5 * 60 * 1000 - 1;
  const headerBad = signRetellWebhook(API_KEY, raw, String(overTs));
  assert.equal(
    verifyRetellWebhook({ apiKey: API_KEY, rawBody: raw, signatureHeader: headerBad, nowMs: () => NOW }).ok,
    false,
  );
});

test("tampered body: re-signing over different content fails against the original", () => {
  const raw = sampleBody();
  const tampered = sampleBody({ call_id: "DIFFERENT_CALL_ID" });
  const header = signRetellWebhook(API_KEY, raw, String(NOW));
  const result = verifyRetellWebhook({
    apiKey: API_KEY,
    rawBody: tampered,
    signatureHeader: header,
    nowMs: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /signature mismatch/);
});

test("wrong api key: signature produced with key A fails verify with key B", () => {
  const raw = sampleBody();
  const header = signRetellWebhook("key-A", raw, String(NOW));
  const result = verifyRetellWebhook({
    apiKey: "key-B",
    rawBody: raw,
    signatureHeader: header,
    nowMs: () => NOW,
  });
  assert.equal(result.ok, false);
});

test("missing signature header is rejected with a clear reason", () => {
  const result = verifyRetellWebhook({
    apiKey: API_KEY,
    rawBody: sampleBody(),
    signatureHeader: null,
    nowMs: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing or malformed/);
});

test("malformed signature header is rejected (not thrown)", () => {
  const result = verifyRetellWebhook({
    apiKey: API_KEY,
    rawBody: sampleBody(),
    signatureHeader: "not-a-retell-signature",
    nowMs: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing or malformed/);
});

test("raw-body integrity: re-serialized JSON with different whitespace fails", () => {
  // Simulate the upstream bug Retell warns about: parsing then re-stringing
  // the body changes whitespace and breaks the signature.
  const raw = sampleBody();
  const header = signRetellWebhook(API_KEY, raw, String(NOW));
  const reSerialized = JSON.stringify(JSON.parse(raw)); // may differ in spacing
  // Force a spacing difference to make the test deterministic.
  const reSerializedIndented = JSON.stringify(JSON.parse(raw), null, 2);
  const result = verifyRetellWebhook({
    apiKey: API_KEY,
    rawBody: reSerializedIndented,
    signatureHeader: header,
    nowMs: () => NOW,
  });
  // If re-serialization happened to be byte-identical, the test would pass;
  // the indented form is guaranteed different from compact, so it must fail.
  assert.equal(result.ok, reSerializedIndented === raw);
});