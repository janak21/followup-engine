import assert from "node:assert/strict";
import { test, mock } from "node:test";

import { apiFetch, ApiError } from "../src/utils/apiFetch.ts";

function fakeResponse({ ok = true, status = 200, statusText = "", jsonBody, jsonThrows = false } = {}) {
  return {
    ok,
    status,
    statusText,
    json: async () => {
      if (jsonThrows) throw new SyntaxError("Unexpected end of JSON input");
      return jsonBody;
    },
  };
}

test("apiFetch returns parsed body on success", async () => {
  globalThis.fetch = mock.fn(async () => fakeResponse({ jsonBody: { data: [1, 2] } }));
  const body = await apiFetch("/api/x");
  assert.deepEqual(body, { data: [1, 2] });
});

test("apiFetch resolves {} for empty/malformed JSON on OK responses", async () => {
  globalThis.fetch = mock.fn(async () => fakeResponse({ jsonThrows: true }));
  assert.deepEqual(await apiFetch("/api/x"), {});
});

test("apiFetch throws ApiError with server message on !ok", async () => {
  globalThis.fetch = mock.fn(async () =>
    fakeResponse({ ok: false, status: 403, jsonBody: { error: "Forbidden for this role" } })
  );
  await assert.rejects(apiFetch("/api/x"), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "Forbidden for this role");
    assert.equal(err.status, 403);
    assert.deepEqual(err.body, { error: "Forbidden for this role" });
    return true;
  });
});

test("apiFetch falls back to status text when the error body is unusable", async () => {
  globalThis.fetch = mock.fn(async () =>
    fakeResponse({ ok: false, status: 502, statusText: "Bad Gateway", jsonThrows: true })
  );
  await assert.rejects(apiFetch("/api/x"), /Request failed \(502 Bad Gateway\)/);
});

test("apiFetch json shorthand sets method, header, and body", async () => {
  const calls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    calls.push([url, opts]);
    return fakeResponse({ jsonBody: { ok: true } });
  });
  await apiFetch("/api/leads", { json: { name: "A" } });
  const [, opts] = calls[0];
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers["Content-Type"], "application/json");
  assert.equal(opts.body, JSON.stringify({ name: "A" }));
});

test("apiFetch json shorthand respects an explicit method", async () => {
  const calls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    calls.push([url, opts]);
    return fakeResponse({ jsonBody: {} });
  });
  await apiFetch("/api/leads", { method: "PUT", json: { a: 1 } });
  assert.equal(calls[0][1].method, "PUT");
});
