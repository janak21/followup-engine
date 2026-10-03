// Static-analysis regression tests for the no-secret-egress ticket.
//
// Asserts:
//   1. No API route does `.select('*')` from `senders` or `tenant_credentials`.
//   2. settings/route.js source does NOT contain any of the three secret
//      column names inside any .select(...) call.
//   3. No API route uses no-args `.select()` immediately after a
//      `.from('senders'|'tenant_credentials')` chain (equivalent to *, except
//      it returns every column instead of just '*' — same leak shape).
//
// The file-format regexes are deliberately lenient across newlines so they
// survive pretty-printing; they specifically scope their matches to the
// `senders` and `tenant_credentials` tables.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const API_ROOT = fileURLToPath(new URL("../src/app/api/", import.meta.url));

const SECRET_COLUMNS = [
  "google_refresh_token",
  "google_access_token",
  "google_client_secret",
];

function listRouteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listRouteFiles(full));
    else if (entry === "route.js") out.push(full);
  }
  return out;
}

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

// Walk a route file and enumerate every `.from('table')` together with the
// .select(...) it ultimately calls. Each match is { table, selectArgs }.
// selectArgs is literally the contents of the first `.select(...)` call after
// the .from(...), so 'args'/'*'/'\"*\"'/etc. can be inspected.
function fromSelectPairs(src) {
  // .from('tbl') ... .select(<args>)      -- allow whitespace/newlines between
  const re = /\.from\(\s*['"]([a-z_]+)['"][\s\S]{0,200}?\.(select)\s*\(\s*((?:[^()]*|\([^()]*\))*)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ table: m[1], call: m[2], args: m[3].trim() });
  }
  return out;
}

const routeFiles = listRouteFiles(API_ROOT);

test("routes discovered", () => {
  assert.ok(routeFiles.length > 20, `expected many routes, found ${routeFiles.length}`);
});

const SECRET_BEARING_TABLES = ["senders", "tenant_credentials"];

for (const absPath of routeFiles) {
  const rel = absPath.split(sep).join("/").replace(/.*\/api\//, "api/");
  test(`${rel}: no .select('*') or empty .select() from senders / tenant_credentials`, () => {
    const src = readFileSync(absPath, "utf8");
    const leaks = fromSelectPairs(src)
      .filter((p) => SECRET_BEARING_TABLES.includes(p.table))
      .filter((p) => {
        // `.select('*')` or `.select("*")` or `.select()` (empty / whitespace only).
        const a = p.args.replace(/^['"]|['"]$/g, "").trim();
        return a === "*" || a === "";
      });
    assert.equal(
      leaks.length,
      0,
      `${rel}: found ${leaks.length} secret-bearing * / empty select() leak(s): ${JSON.stringify(leaks)}`,
    );
  });
}

test("settings/route.js: no .select(...) call mentions any of the three secret column names", () => {
  const src = read("../src/app/api/settings/route.js");
  // Parse every .select(...) (anywhere in the file) and assert no arg list
  // contains a secret column name.
  const re = /\.select\s*\(\s*((?:[^()]*|\([^()]*\))*)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const args = m[1];
    for (const sc of SECRET_COLUMNS) {
      assert.ok(
        !args.includes(sc),
        `settings/route.js has a .select(...) referencing secret column '${sc}' — should not be in any select query`,
      );
    }
  }
});

test("settings/route.js: uses the shared SENDER_SAFE_COLUMNS helper, never a literal senders select('*')", () => {
  const src = read("../src/app/api/settings/route.js");
  // Import the shared helper — the secret column names live in the lib only.
  assert.ok(
    src.includes("@") && src.includes("lib/senderColumns"),
    "settings/route.js must import the shared senderColumns lib",
  );
  assert.match(src, /SENDER_SAFE_COLUMNS/);
  assert.equal(src.includes(".from('senders').select('*')"), false);
  assert.equal(src.includes(`.from("senders").select("*")`), false);
  assert.equal(src.includes(".from('senders')\n      .select('*')"), false);
});

test("senderColumns lib: SENDER_SAFE_COLUMNS excludes the three secret columns", () => {
  const src = read("../src/lib/senderColumns.js");
  // Extract the value assigned to SENDER_SAFE_COLUMNS; it is a comma-separated
  // string, so we capture everything from the first assignment value to the
  // first semicolon (the constant is on one logical line, possibly split by
  // string concatenation).
  const m = src.match(/SENDER_SAFE_COLUMNS\s*=\s*([^;]+);/);
  assert.ok(m, "could not locate SENDER_SAFE_COLUMNS definition");
  const safeValue = m[1];
  for (const sc of SECRET_COLUMNS) {
    assert.ok(
      !safeValue.includes(sc),
      `SENDER_SAFE_COLUMNS value must not include secret column '${sc}'`,
    );
  }
  // The secret column names must still be listed in SENDER_SECRET_COLUMNS so
  // the audit surface is explicit.
  assert.match(src, /export const SENDER_SECRET_COLUMNS\s*=\s*\[[\s\S]*\]/);
  for (const sc of SECRET_COLUMNS) {
    assert.ok(src.includes(`'${sc}'`), `senderColumns.js must declare '${sc}' as a secret`);
  }
});

test("senderHealth: prefers the new derived boolean google_connected over raw columns", () => {
  const src = read("../src/lib/senderHealth.js");
  // The connected expression should reference sender.google_connected (the
  // new derived boolean the server now emits) but still fall back to
  // google_connected_at / google_refresh_token for back-compat with caches.
  const fnBlock = src.slice(
    src.indexOf("function getSenderHealthDisplay"),
    src.indexOf("return display"),
  );
  assert.match(fnBlock, /sender\.google_connected === true/);
  assert.match(fnBlock, /google_connected_at/); // back-compat
});