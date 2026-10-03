import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const API_ROOT = fileURLToPath(new URL("../src/app/api/", import.meta.url));
const HARDcoded_TENANT_UUID = "00000000-0000-0000-0000-000000000001";
const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

function listRouteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listRouteFiles(full));
    } else if (entry === "route.js") {
      out.push(full);
    }
  }
  return out;
}

const routeFiles = listRouteFiles(API_ROOT);
const rel = (abs) => abs.split(sep).join("/").replace(/.*\/api\//, "api/");

test("every api route file is discovered", () => {
  assert.ok(routeFiles.length > 20, `expected many routes, found ${routeFiles.length}`);
});

test("no api route hardcodes the seed tenant UUID", () => {
  for (const file of routeFiles) {
    const source = readFileSync(file, "utf8");
    assert.equal(
      source.includes(HARDcoded_TENANT_UUID),
      false,
      `${rel(file)} must not hardcode the seed tenant UUID; resolve tenant via getTenantId(request) instead`
    );
  }
});

// Session-preference routes that mutate cookies (not tenant data) and perform
// their own auth/membership checks are exempt from the requireOperator guard.
const MUTATION_GUARD_EXEMPTIONS = new Set(["api/tenant/active/route.js"]);

test("every mutation handler is guarded by requireOperator", () => {
  for (const file of routeFiles) {
    const route = rel(file);
    if (MUTATION_GUARD_EXEMPTIONS.has(route)) continue;
    const source = readFileSync(file, "utf8");
    for (const method of MUTATION_METHODS) {
      if (new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(source)) {
        assert.match(
          source,
          /requireOperator/,
          `${route} exports ${method} but never calls requireOperator — mutations must be guarded`
        );
        break;
      }
    }
  }
});

test("mutation handlers invoke requireOperator before any database write", () => {
  for (const file of routeFiles) {
    const route = rel(file);
    if (MUTATION_GUARD_EXEMPTIONS.has(route)) continue;
    const source = readFileSync(file, "utf8");
    for (const method of MUTATION_METHODS) {
      const m = source.match(new RegExp(`export\\s+async\\s+function\\s+${method}\\b`));
      if (!m) continue;
      const start = m.index;
      const nextExport = source.indexOf("export async function", start + 1);
      const block = source.slice(start, nextExport === -1 ? undefined : nextExport);
      const guardIdx = block.indexOf("requireOperator");
      const supabaseIdx = block.indexOf("supabase");
      assert.ok(guardIdx !== -1, `${route} ${method}: requireOperator not found`);
      assert.ok(
        supabaseIdx === -1 || guardIdx < supabaseIdx,
        `${route} ${method}: requireOperator must appear before the first supabase call`
      );
    }
  }
});