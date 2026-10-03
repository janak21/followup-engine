import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("middleware does not mark journey admin APIs public", () => {
  const source = read("src/middleware.js");

  assert.equal(
    source.includes('"/api/journeys/"'),
    false,
    "the broad /api/journeys/ public prefix exposes admin routes"
  );
});

test("healthcheck does not expose detailed operational data", () => {
  const source = read("src/app/api/healthcheck/route.js");

  assert.equal(source.includes("NEXT_PUBLIC_SUPABASE_URL_value"), false);
  assert.equal(source.includes("rows:"), false);
});

test("credential reads require operator access and do not return raw config", () => {
  const source = read("src/app/api/credentials/route.js");
  const getBlock = source.slice(source.indexOf("export async function GET"), source.indexOf("// POST"));

  assert.match(getBlock, /requireOperator/);
  assert.equal(getBlock.includes(".select('*')"), false);
  assert.equal(getBlock.includes("config"), false);
});

test("sender reads redact OAuth token and secret fields", () => {
  const source = read("src/app/api/senders/route.js");
  const getBlock = source.slice(source.indexOf("export async function GET"), source.indexOf("const VALID_WARMUP"));

  assert.equal(getBlock.includes(".select('*')"), false);
  assert.equal(getBlock.includes("google_refresh_token"), false);
  assert.equal(getBlock.includes("google_access_token"), false);
  assert.equal(getBlock.includes("google_client_secret"), false);
});

test("service-role writes are scoped to the current tenant", () => {
  const cases = [
    ["src/app/api/leads/route.js", "leads"],
    ["src/app/api/journeys/route.js", "journeys"],
    ["src/app/api/templates/route.js", "templates"],
    ["src/app/api/senders/route.js", "senders"],
    ["src/app/api/credentials/route.js", "credentials"],
    ["src/app/api/ai-agents/route.js", "ai-agents"],
    ["src/app/api/actions/[id]/route.js", "actions"],
    ["src/app/api/actions/[id]/run-now/route.js", "actions run-now"],
  ];

  for (const [path, label] of cases) {
    const source = read(path);
    assert.match(source, /getTenantId\(request\)/, `${label} must resolve the caller tenant`);
    assert.match(source, /\.eq\(['"]tenant_id['"],\s*tenantId\)/, `${label} writes must include tenant_id`);
  }
});

test("workflow HTTP test route blocks internal URL targets", () => {
  const source = read("src/app/api/workflows/test-http/route.js");

  assert.match(source, /assertPublicHttpUrl/);
  assert.match(source, /lookup\(host, \{ all: true/);
  assert.match(source, /isBlockedIpv4/);
  assert.match(source, /localhost/);
  assert.match(source, /metadata\.google\.internal/);
  assert.match(source, /redirect: "manual"/);
  // Timeout is operator-configurable but must stay server-clamped to <=30s.
  assert.match(source, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(source, /Math\.max\(1000, Math\.min\(30000/);
});
