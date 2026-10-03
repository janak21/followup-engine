// Static-analysis regression tests for the per-sender secret migration.
//
// The Vault helpers (set_sender_secret / get_sender_secret /
// get_sender_ids_with_secret) live in SQL and cannot be imported by node:test
// directly. These tests read the migration files as plain text and assert the
// SECURITY-DEFINER + grant properties that protect the decrypted-secret
// surface, mirroring tenant-secrets.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const REPO = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, REPO), "utf8");

// ---- Vault helpers migration ----

const HELPERS = "supabase/migrations/20260714090000_sender_secret_vault_helpers.sql";

test("helpers migration declares set_sender_secret and get_sender_secret", () => {
  const src = read(HELPERS);
  assert.match(src, /create or replace function public\.set_sender_secret\(/);
  assert.match(src, /create or replace function public\.get_sender_secret\(/);
});

test("helpers are SECURITY DEFINER so service role can read/write encrypted secrets", () => {
  const src = read(HELPERS);
  const setMatch = src.match(/public\.set_sender_secret[\s\S]*?language plpgsql\s+security definer/i);
  const getMatch = src.match(/public\.get_sender_secret[\s\S]*?language plpgsql\s+security definer/i);
  assert.ok(setMatch, "set_sender_secret must be SECURITY DEFINER");
  assert.ok(getMatch, "get_sender_secret must be SECURITY DEFINER");
});

test("helpers revoke EXECUTE from anon and authenticated, and grant only to service_role", () => {
  const src = read(HELPERS);
  const setRevoke = (src.match(/revoke execute on function public\.set_sender_secret\([^)]+\) from (anon|authenticated|public)/g) || []);
  assert.equal(setRevoke.length, 3, `set_sender_secret must revoke from anon, authenticated, AND public (saw ${setRevoke.length})`);
  const getRevoke = (src.match(/revoke execute on function public\.get_sender_secret\([^)]+\) from (anon|authenticated|public)/g) || []);
  assert.equal(getRevoke.length, 3, `get_sender_secret must revoke from anon, authenticated, AND public (saw ${getRevoke.length})`);
  assert.match(src, /grant execute on function public\.set_sender_secret\(uuid, text, text\) to service_role/);
  assert.match(src, /grant execute on function public\.get_sender_secret\(uuid, text\) to service_role/);
  assert.equal(/grant execute on function public\.(set|get)_sender_secret to (anon|authenticated)/.test(src), false);
});

test("get_sender_secret reads from vault.decrypted_secrets (not from senders)", () => {
  const src = read(HELPERS);
  assert.match(src, /from vault\.decrypted_secrets/);
  assert.equal(/public\.senders/.test(src.split("get_sender_secret")[1] || ""), false,
    "get_sender_secret body must not reference public.senders");
});

test("helpers include bulk get_sender_ids_with_secret RPC and harden its grants", () => {
  const src = read(HELPERS);
  assert.match(src, /create or replace function public\.get_sender_ids_with_secret\(/);
  const fnMatch = src.match(/public\.get_sender_ids_with_secret[\s\S]*?language sql\s+security definer/i);
  assert.ok(fnMatch, "get_sender_ids_with_secret must be SECURITY DEFINER");
  const revoke = (src.match(/revoke execute on function public\.get_sender_ids_with_secret\([^)]+\) from (anon|authenticated|public)/g) || []);
  assert.equal(revoke.length, 3, "get_sender_ids_with_secret must revoke from anon, authenticated, AND public");
  assert.match(src, /grant execute on function public\.get_sender_ids_with_secret\(uuid, text\) to service_role/);
});

// ---- Data migration ----

const DATA = "supabase/migrations/20260714091000_migrate_sender_secrets_to_vault.sql";

test("data migration copies sender secrets to Vault AND nulls plaintext columns", () => {
  const src = read(DATA);
  assert.match(src, /public\.set_sender_secret\(/);
  assert.match(src, /public\.get_sender_secret\(/);
  assert.match(src, /if v_roundtrip is distinct from v_val then/i);
  assert.match(src, /google_refresh_token = null/i);
  assert.match(src, /google_access_token  = null/i);
  assert.match(src, /google_client_secret = null/i);
  for (const k of ['google_refresh_token', 'google_access_token', 'google_client_secret']) {
    assert.ok(src.includes(`'${k}'`), `data migration must recognize '${k}' as a secret`);
  }
});

// ---- RPC route migration ----

const ROUTE = "supabase/migrations/20260714092000_route_email_payload_to_vault.sql";

test("email-payload migration redefines get_email_payload and reads refresh token via getter", () => {
  const src = read(ROUTE);
  assert.match(src, /create or replace function public\.get_email_payload\(/);
  const calls = (src.match(/public\.get_sender_secret\(/g) || []).length;
  assert.ok(calls >= 2, `expected at least 2 get_sender_secret calls (assigned + pool), saw ${calls}`);
  assert.equal(/google_refresh_token is not null/.test(src), false,
    "get_email_payload must not filter on plaintext google_refresh_token column after migration");
});

// ---- Edge-function readers ----

const DISPATCH = "supabase/functions/dispatch-gmail-email/index.ts";
const POLL = "supabase/functions/poll-gmail-inbox/index.ts";

test("dispatch-gmail-email reads sender secrets via get_sender_secret", () => {
  const src = read(DISPATCH);
  // The sender select list must NOT include any of the secret columns.
  const selectMatch = src.match(/\.from\("senders"\)\s*\.select\(([^)]+)\)/s);
  const selectList = selectMatch ? selectMatch[1] : "";
  for (const col of ['google_refresh_token', 'google_access_token', 'google_client_secret']) {
    assert.equal(selectList.includes(col), false, `dispatch sender select must not include ${col}`);
  }
  assert.ok((src.match(/get_sender_secret['"(]/g) || []).length >= 3, "dispatch must call get_sender_secret for each secret");
  assert.match(src, /set_sender_secret['"(]/);
});

test("poll-gmail-inbox reads sender secrets via get_sender_secret", () => {
  const src = read(POLL);
  const selectMatch = src.match(/\.from\("senders"\)\s*\.select\(([^)]+)\)/s);
  const selectList = selectMatch ? selectMatch[1] : "";
  for (const col of ['google_refresh_token', 'google_access_token', 'google_client_secret']) {
    assert.equal(selectList.includes(col), false, `poll sender select must not include ${col}`);
  }
  assert.ok((src.match(/get_sender_secret['"(]/g) || []).length >= 3, "poll must call get_sender_secret for each secret");
  assert.match(src, /set_sender_secret['"(]/);
});

// ---- Dashboard readers/writers ----

const TEST_SEND = "dashboard/src/app/api/senders/[id]/test-send/route.js";
const CALLBACK = "dashboard/src/app/api/oauth/google/callback/route.js";
const START = "dashboard/src/app/api/oauth/google/start/route.js";
const SENDERS_ROUTE = "dashboard/src/app/api/senders/route.js";
const SENDER_COLUMNS = "dashboard/src/lib/senderColumns.js";

test("test-send reads sender secrets via get_sender_secret and writes access token via set_sender_secret", () => {
  const src = read(TEST_SEND);
  const selectMatch = src.match(/\.from\('senders'\)\s*\.select\(([^)]+)\)/s);
  const selectList = selectMatch ? selectMatch[1] : "";
  for (const col of ['google_refresh_token', 'google_access_token', 'google_client_secret']) {
    assert.equal(selectList.includes(col), false, `test-send sender select must not include ${col}`);
  }
  assert.ok((src.match(/get_sender_secret['"(]/g) || []).length >= 3);
  assert.match(src, /set_sender_secret['"(]/);
});

test("oauth callback writes all new sender secrets via set_sender_secret", () => {
  const src = read(CALLBACK);
  assert.ok((src.match(/set_sender_secret['"(]/g) || []).length >= 3);
  // The sender update block must NOT include any secret columns.
  const updateMatch = src.match(/\.from\('senders'\)\s*\.update\(\{([^}]+)\}/s);
  const updateBlock = updateMatch ? updateMatch[1] : "";
  for (const col of ['google_client_secret', 'google_refresh_token', 'google_access_token']) {
    assert.equal(updateBlock.includes(col), false, `callback sender update must not include ${col}`);
  }
});

test("oauth start only reads non-secret google_client_id and never selects secret columns", () => {
  const src = read(START);
  const selectMatch = src.match(/\.from\('senders'\)\s*\.select\(([^)]+)\)/s);
  const selectList = selectMatch ? selectMatch[1] : "";
  for (const col of ['google_client_secret', 'google_refresh_token', 'google_access_token']) {
    assert.equal(selectList.includes(col), false, `start route sender select must not include ${col}`);
  }
});

test("senders CRUD route writes client_secret via set_sender_secret, not the column", () => {
  const src = read(SENDERS_ROUTE);
  assert.match(src, /set_sender_secret['"(]/);
  // The buildSenderPayload must NOT include google_client_secret in the row payload.
  const payloadBlock = src.slice(src.indexOf("function buildSenderPayload"), src.indexOf("function getSenderClientSecret"));
  assert.equal(payloadBlock.includes("'google_client_secret'"), false,
    "buildSenderPayload must not put google_client_secret into the senders row payload");
});

test("senderColumns helper queries Vault for client_secret_set, not the plaintext column", () => {
  const src = read(SENDER_COLUMNS);
  assert.match(src, /get_sender_ids_with_secret['"(]/);
  assert.equal(/\.not\('google_client_secret', 'is', null\)/.test(src), false,
    "senderColumns must not filter on plaintext google_client_secret column");
});
