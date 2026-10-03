import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseUrlQuery,
  setUrlQuery,
  encodeQueryPart,
  getAuthFromHeaders,
  applyAuthToHeaders,
  lintJsonBody,
  clampTimeoutMs,
} from "../src/app/journeys/builder/lib/httpRequestNode.ts";

test("parseUrlQuery splits base and params, tolerating merge tokens", () => {
  const { base, params } = parseUrlQuery("https://api.x.com/v1/leads?email={{lead.email}}&limit=10");
  assert.equal(base, "https://api.x.com/v1/leads");
  assert.deepEqual(params, [
    { key: "email", value: "{{lead.email}}" },
    { key: "limit", value: "10" },
  ]);
});

test("parseUrlQuery handles no query, empty pairs, and fragments", () => {
  assert.deepEqual(parseUrlQuery("https://a.com/path"), { base: "https://a.com/path", params: [] });
  assert.deepEqual(parseUrlQuery("https://a.com/?a=1&&b=2#frag").params, [
    { key: "a", value: "1" },
    { key: "b", value: "2" },
  ]);
  assert.equal(parseUrlQuery("https://a.com/?a=1#frag").base, "https://a.com/#frag");
});

test("setUrlQuery rebuilds URLs and round-trips with parseUrlQuery", () => {
  const url = setUrlQuery("https://a.com/x", [
    { key: "email", value: "{{payload.email}}" },
    { key: "note", value: "a b&c" },
    { key: "", value: "dropped" },
  ]);
  assert.equal(url, "https://a.com/x?email={{payload.email}}&note=a%20b%26c");
  const { params } = parseUrlQuery(url);
  assert.deepEqual(params, [
    { key: "email", value: "{{payload.email}}" },
    { key: "note", value: "a b&c" },
  ]);
});

test("encodeQueryPart preserves tokens but encodes structural characters", () => {
  assert.equal(encodeQueryPart("{{lead.email}}"), "{{lead.email}}");
  assert.equal(encodeQueryPart("a=b&c"), "a%3Db%26c");
  assert.equal(encodeQueryPart("x {{p.q}} y"), "x%20{{p.q}}%20y");
});

test("auth round-trips through the Authorization header", () => {
  let headers = applyAuthToHeaders({}, { type: "bearer", token: "tok-123" });
  assert.equal(headers.Authorization, "Bearer tok-123");
  assert.deepEqual(getAuthFromHeaders(headers), { type: "bearer", token: "tok-123" });

  headers = applyAuthToHeaders({ "X-Other": "keep" }, { type: "basic", username: "u", password: "p:w" });
  assert.equal(headers["X-Other"], "keep");
  const auth = getAuthFromHeaders(headers);
  assert.equal(auth.type, "basic");
  assert.equal(auth.username, "u");
  assert.equal(auth.password, "p:w");

  headers = applyAuthToHeaders(headers, { type: "none" });
  assert.equal(getAuthFromHeaders(headers).type, "none");
  assert.equal(headers["X-Other"], "keep");
});

test("auth replaces a differently-cased authorization header", () => {
  const headers = applyAuthToHeaders({ authorization: "Bearer old" }, { type: "bearer", token: "new" });
  assert.deepEqual(Object.keys(headers), ["Authorization"]);
  assert.equal(headers.Authorization, "Bearer new");
});

test("custom Authorization values survive as type custom", () => {
  const auth = getAuthFromHeaders({ Authorization: "Token abc" });
  assert.deepEqual(auth, { type: "custom", raw: "Token abc" });
  assert.equal(applyAuthToHeaders({}, auth).Authorization, "Token abc");
});

test("lintJsonBody accepts valid JSON with tokens, rejects broken JSON", () => {
  assert.equal(lintJsonBody("").valid, true);
  assert.equal(lintJsonBody('{"email": "{{lead.email}}"}').valid, true);
  assert.equal(lintJsonBody('{"n": {{payload.count}}}').valid, true);
  assert.equal(lintJsonBody("{{steps.api_response}}").valid, true);
  assert.equal(lintJsonBody('{"email": }').valid, false);
  assert.equal(lintJsonBody("not json at all").valid, false);
});

test("clampTimeoutMs enforces the runtime's 1s..30s window", () => {
  assert.equal(clampTimeoutMs(undefined), 10000);
  assert.equal(clampTimeoutMs("nope"), 10000);
  assert.equal(clampTimeoutMs(500), 1000);
  assert.equal(clampTimeoutMs(45000), 30000);
  assert.equal(clampTimeoutMs(15000), 15000);
});
