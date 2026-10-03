#!/usr/bin/env node

// Advisory Phase 7 drift check. Dev migrations were applied by MCP, so their
// database versions can differ from repo file timestamps; compare by the repo
// filename suffix after the timestamp (for example, functions_base_url).
//
// A small set of pre-Phase-7 dev migration-history mismatches is known and
// superseded by later migrations. Do not apply those older local files to dev
// now: several replace functions with older bodies. The runbook records that
// prod is replayed fresh from repo files, while this advisory check focuses on
// current launch blockers after excluding those historical repairs.

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const EXPECTED_CRON = [
  "dispatch-pending-actions",
  "poll-gmail-inbox",
  "ops-alert-scan",
  "prune-engine-history",
];

const KNOWN_DEV_MISSING_FILENAMES = new Set([
  "20260705093000_port_event_handlers_to_actions.sql",
  "20260705094000_dispatcher_routes_event_types.sql",
  "20260705095000_event_webhook_intake_unified.sql",
  "20260707090000_inline_step_content.sql",
]);

const KNOWN_DEV_UNKNOWN_NAMES = new Set([
  "get_call_payload_strict_agent",
  "team_alert_send_and_advance",
  "team_alert_use_tenant_column",
  "render_template_phone_alias",
  "ab_split_hash_overflow_hardening",
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");

function migrationParts(filename) {
  const match = filename.match(/^(\d{14})_(.+)\.sql$/);
  if (!match) return null;
  return { version: match[1], name: match[2], filename };
}

function formatList(values) {
  return values.length ? `[${values.join(", ")}]` : "[]";
}

function printCheck(ok, label, detail) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}: ${detail}`);
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const localFiles = (await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .map(migrationParts)
  .filter(Boolean)
  .sort((a, b) => a.filename.localeCompare(b.filename));

const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/drift_check_report`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  },
  body: "{}",
});

if (!response.ok) {
  const text = await response.text();
  console.error(`drift_check_report failed: HTTP ${response.status} ${text}`);
  process.exit(1);
}

const report = await response.json();
const appliedMigrations = Array.isArray(report.applied_migrations) ? report.applied_migrations : [];
const appliedKeys = new Set();
for (const migration of appliedMigrations) {
  if (migration?.name) appliedKeys.add(String(migration.name));
  if (migration?.version) appliedKeys.add(String(migration.version));
}

const localKeys = new Set();
for (const migration of localFiles) {
  localKeys.add(migration.name);
  localKeys.add(migration.version);
}

const missingInDb = localFiles
  .filter((migration) => !appliedKeys.has(migration.name) && !appliedKeys.has(migration.version))
  .filter((migration) => !KNOWN_DEV_MISSING_FILENAMES.has(migration.filename))
  .map((migration) => migration.filename);

const unknownInDb = appliedMigrations
  .filter((migration) => {
    const version = migration?.version ? String(migration.version) : "";
    const name = migration?.name ? String(migration.name) : "";
    return !localKeys.has(version) && !localKeys.has(name);
  })
  .map((migration) => migration.name || migration.version)
  .filter((key) => !KNOWN_DEV_UNKNOWN_NAMES.has(key))
  .filter(Boolean);

const migrationOk = missingInDb.length === 0 && unknownInDb.length === 0;
printCheck(
  migrationOk,
  "migrations",
  `repo ${localFiles.length} / applied ${appliedMigrations.length} / missing-in-db ${formatList(missingInDb)} / unknown-in-db ${formatList(unknownInDb)}`
);

const urlLeakFunctions = Array.isArray(report.url_leak_functions) ? report.url_leak_functions : [];
const urlLeakOk = urlLeakFunctions.length === 0;
printCheck(
  urlLeakOk,
  "url-leak",
  `functions embedding the dev URL: ${formatList(urlLeakFunctions)}`
);

const publicExecutableCount = Number(report.public_executable_function_count || 0);
const grantsOk = publicExecutableCount === 0;
printCheck(
  grantsOk,
  "grants",
  `${publicExecutableCount} functions executable by anon/authenticated (expect 0)`
);

const cronJobnames = new Set(Array.isArray(report.cron_jobnames) ? report.cron_jobnames : []);
const missingCron = EXPECTED_CRON.filter((jobname) => !cronJobnames.has(jobname));
const cronOk = missingCron.length === 0;
printCheck(
  cronOk,
  "cron",
  `expected {${EXPECTED_CRON.join(", ")}} present; missing ${formatList(missingCron)}`
);

if (!migrationOk || !urlLeakOk || !grantsOk || !cronOk) {
  process.exit(1);
}
