// Tests for the active-tenant membership resolution and signed cookie helpers.
// These helpers are pure and do not touch the database.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActiveTenantId } from "../src/utils/activeTenant.js";
import {
  signActiveTenantId,
  parseActiveTenantId,
} from "../src/utils/activeTenantCookie.js";

const SECRET = "test-secret-for-active-tenant-cookie";
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TENANT_C = "33333333-3333-3333-3333-333333333333";

// ---- resolveActiveTenantId ----

test("resolveActiveTenantId uses active tenant when user is a member", () => {
  const memberships = [
    { tenant_id: TENANT_A, role: "owner" },
    { tenant_id: TENANT_B, role: "member" },
  ];
  assert.equal(resolveActiveTenantId(TENANT_B, memberships), TENANT_B);
});

test("resolveActiveTenantId falls back to earliest membership when active is null", () => {
  const memberships = [
    { tenant_id: TENANT_A, role: "owner" },
    { tenant_id: TENANT_B, role: "member" },
  ];
  assert.equal(resolveActiveTenantId(null, memberships), TENANT_A);
});

test("resolveActiveTenantId falls back to earliest membership when active is not a member", () => {
  const memberships = [
    { tenant_id: TENANT_A, role: "owner" },
    { tenant_id: TENANT_B, role: "member" },
  ];
  assert.equal(resolveActiveTenantId(TENANT_C, memberships), TENANT_A);
});

test("resolveActiveTenantId returns null for empty memberships", () => {
  assert.equal(resolveActiveTenantId(TENANT_A, []), null);
  assert.equal(resolveActiveTenantId(TENANT_A, null), null);
  assert.equal(resolveActiveTenantId(TENANT_A, undefined), null);
});

test("resolveActiveTenantId ignores roles and only checks tenant_id membership", () => {
  const memberships = [
    { tenant_id: TENANT_A, role: "client_viewer" },
    { tenant_id: TENANT_B, role: "admin" },
  ];
  assert.equal(resolveActiveTenantId(TENANT_A, memberships), TENANT_A);
});

// ---- signed cookie helpers ----

test("signActiveTenantId and parseActiveTenantId round-trip", () => {
  const signed = signActiveTenantId(TENANT_A, SECRET);
  assert.ok(signed.includes("."));
  assert.equal(parseActiveTenantId(signed, SECRET), TENANT_A);
});

test("parseActiveTenantId rejects tampered payload", () => {
  const signed = signActiveTenantId(TENANT_A, SECRET);
  const tampered = signed.replace(TENANT_A, TENANT_B);
  assert.equal(parseActiveTenantId(tampered, SECRET), null);
});

test("parseActiveTenantId rejects tampered signature", () => {
  const signed = signActiveTenantId(TENANT_A, SECRET);
  const [payload] = signed.split(".");
  assert.equal(parseActiveTenantId(`${payload}.deadbeef`, SECRET), null);
});

test("parseActiveTenantId rejects wrong secret", () => {
  const signed = signActiveTenantId(TENANT_A, SECRET);
  assert.equal(parseActiveTenantId(signed, "wrong-secret"), null);
});

test("parseActiveTenantId rejects malformed values", () => {
  assert.equal(parseActiveTenantId("", SECRET), null);
  assert.equal(parseActiveTenantId("only-payload-no-signature", SECRET), null);
  assert.equal(parseActiveTenantId("payload.signature.extra", SECRET), null);
  assert.equal(parseActiveTenantId(null, SECRET), null);
});

test("signActiveTenantId returns null for missing inputs", () => {
  assert.equal(signActiveTenantId(null, SECRET), null);
  assert.equal(signActiveTenantId(TENANT_A, null), null);
  assert.equal(signActiveTenantId("", SECRET), null);
});
