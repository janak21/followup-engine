// Static-analysis regression tests for the tenant-credential secret migration.
//
// The Vault helpers (set_tenant_secret / get_tenant_secret) live in SQL and
// cannot be imported by node:test directly. These tests read the migration
// files as plain text and assert the SECURITY-DEFINER + grant properties that
// protect the decrypted-secret surface — the same approach as
// security-regressions.test.mjs. They also verify the dashboard write path
// never persists a recognized secret into tenant_credentials.config.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Migrations live at the repo root under supabase/migrations/, one level up
// from dashboard/. The dashboard source paths are relative to dashboard/.
const REPO = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, REPO), "utf8");

// ---- Vault helpers migration ----

const HELPERS = "supabase/migrations/20260713090000_tenant_secret_vault_helpers.sql";

test("helpers migration declares both set_tenant_secret and get_tenant_secret", () => {
  const src = read(HELPERS);
  assert.match(src, /create or replace function public\.set_tenant_secret\(/);
  assert.match(src, /create or replace function public\.get_tenant_secret\(/);
});

test("helpers are SECURITY DEFINER so service role can read/write encrypted secrets", () => {
  const src = read(HELPERS);
  const setMatch = src.match(/public\.set_tenant_secret[\s\S]*?language plpgsql\s+security definer/i);
  const getMatch = src.match(/public\.get_tenant_secret[\s\S]*?language plpgsql\s+security definer/i);
  assert.ok(setMatch, "set_tenant_secret must be SECURITY DEFINER");
  assert.ok(getMatch, "get_tenant_secret must be SECURITY DEFINER");
});

test("helpers revoke EXECUTE from anon and authenticated, and grant only to service_role", () => {
  const src = read(HELPERS);
  // Both functions must explicitly revoke anon + authenticated + public.
  // (Function-syntax revokes include the argument list, e.g.
  //  revoke execute on function public.set_tenant_secret(uuid, text, text, text) from anon;)
  const setRevoke = (src.match(/revoke execute on function public\.set_tenant_secret\([^)]+\) from (anon|authenticated|public)/g) || []);
  assert.equal(setRevoke.length, 3, `set_tenant_secret must revoke from anon, authenticated, AND public (saw ${setRevoke.length})`);
  const getRevoke = (src.match(/revoke execute on function public\.get_tenant_secret\([^)]+\) from (anon|authenticated|public)/g) || []);
  assert.equal(getRevoke.length, 3, `get_tenant_secret must revoke from anon, authenticated, AND public (saw ${getRevoke.length})`);
  // Positive grant only to service_role.
  assert.match(src, /grant execute on function public\.set_tenant_secret\(uuid, text, text, text\) to service_role/);
  assert.match(src, /grant execute on function public\.get_tenant_secret\(uuid, text, text\) to service_role/);
  // No grant to anon or authenticated anywhere.
  assert.equal(/grant execute on function public\.(set|get)_tenant_secret to (anon|authenticated)/.test(src), false);
});

test("get_tenant_secret reads from vault.decrypted_secrets (not from tenant_credentials.config)", () => {
  const src = read(HELPERS);
  assert.match(src, /from vault\.decrypted_secrets/);
  assert.equal(/tenant_credentials/.test(src.split("get_tenant_secret")[1] || ""), false,
    "get_tenant_secret body must not reference tenant_credentials");
});

// ---- Data-migration + RPC-route migrations ----

const DATA = "supabase/migrations/20260713092000_migrate_tenant_credentials_secrets_to_vault.sql";
const ROUTE = "supabase/migrations/20260713091000_route_rpc_secret_reads_to_vault.sql";

test("data migration copies secrets to Vault AND strips them from config in the same transaction", () => {
  const src = read(DATA);
  // Uses set_tenant_secret to push each secret to Vault.
  assert.match(src, /public\.set_tenant_secret\(/);
  // Round-trips inside the same DO block before stripping.
  assert.match(src, /public\.get_tenant_secret\(/);
  assert.match(src, /if v_roundtrip is distinct from v_val then/i);
  // Strips recognized secret keys from config JSONB (preserving non-secret).
  assert.match(src, /set config = c\.config - secret_keys/i);
  // Lists the exact recognized secret keys.
  for (const k of [
    'auth_token', 'api_key', 'client_secret',
    'google_refresh_token', 'google_access_token', 'google_client_secret',
  ]) {
    assert.ok(src.includes(`'${k}'`), `data migration must recognize '${k}' as a secret`);
  }
});

test("route-rpcs migration makes the 4 RPCs read secrets via get_tenant_secret (not from config)", () => {
  const src = read(ROUTE);
  const fns = [
    'resolve_twilio_credentials',
    'resolve_twilio_creds_for_sid',
    'resolve_retell_credentials',
    'get_sms_send_payload',
  ];
  for (const fn of fns) {
    assert.match(src, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} must be redefined`);
  }
  // Each must call public.get_tenant_secret at least once.
  const calls = (src.match(/public\.get_tenant_secret\(/g) || []).length;
  assert.ok(calls >= 4, `expected at least 4 get_tenant_secret calls (one per RPC), saw ${calls}`);
  // Must NOT read auth_token directly from config anywhere in this migration.
  assert.equal(/config->>['"]auth_token['"]/.test(src), false,
    "route-rpcs migration must not read auth_token from tenant_credentials.config");
  // Must NOT read api_key directly from config.
  assert.equal(/config->>['"]api_key['"]/.test(src), false,
    "route-rpcs migration must not read api_key from tenant_credentials.config");
});

// ---- Dashboard write path ----

const CRED_ROUTE = "dashboard/src/app/api/credentials/route.js";

test("credentials POST/PUT route splits secrets from safeConfig and writes secrets via set_tenant_secret", () => {
  const src = read(CRED_ROUTE);
  // Recognizes the six secret keys.
  assert.match(src, /const SECRET_KEYS = new Set\(/);
  for (const k of [
    'auth_token', 'api_key', 'client_secret',
    'google_refresh_token', 'google_access_token', 'google_client_secret',
  ]) {
    assert.ok(src.includes(`'${k}'`), `credentials route must treat '${k}' as secret`);
  }
  // Splits the incoming config so secrets never land in the stored config JSONB.
  assert.match(src, /function splitSecrets\(/);
  assert.match(src, /config:\s*safeConfig/);
  // Both POST and PUT call set_tenant_secret for each secret.
  assert.match(src, /supabase\.rpc\('set_tenant_secret'/);
  // POST must not insert into config more than the safe (non-secret) blob.
  const postBlock = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function PUT"));
  assert.equal(postBlock.includes("config: config"), false,
    "POST must not store the raw body `config` (would re-introduce plaintext secrets)");
});

test("credentials GET route never selects secret columns or config (it only returns metadata)", () => {
  const src = read(CRED_ROUTE);
  // Bound the GET handler strictly: from its export line to the next export.
  const start = src.indexOf("export async function GET");
  const end = src.indexOf("export async function POST");
  const getBlock = src.slice(start, end);
  // The safe select list — no `config` and none of the secret keys.
  assert.match(getBlock, /\.select\('id, tenant_id, provider, n8n_credential_name, active, created_at'\)/);
  assert.equal(getBlock.includes("config"), false,
    "GET /api/credentials must not select the config blob (would leak secrets)");
  assert.equal(getBlock.includes("auth_token"), false);
  assert.equal(getBlock.includes("api_key"), false);
  assert.equal(getBlock.includes("client_secret"), false);
});