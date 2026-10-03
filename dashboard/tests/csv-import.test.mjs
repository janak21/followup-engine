import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  autoMapColumns,
  buildLeadDraft,
  DO_NOT_IMPORT,
  parseCsvDocument,
  planImportRows,
} from "../src/lib/csvImport.js";

test("auto-map first/last/email/phone and custom fields", () => {
  const parsed = parseCsvDocument("First Name,Last Name,Email Address,Mobile Phone,Policy Type\nAda,Lovelace,ada@example.com,5551234567,Home\n");
  const mappings = autoMapColumns(parsed.headers, [{ key: "policy_type", label: "Policy Type", type: "single_line" }]);

  assert.equal(mappings.first_name, "first_name");
  assert.equal(mappings.last_name, "last_name");
  assert.equal(mappings.email_address, "email");
  assert.equal(mappings.mobile_phone, "phone");
  assert.equal(mappings.policy_type, "custom.policy_type");
});

test("quoted commas parse correctly and blank rows are skipped", () => {
  const parsed = parseCsvDocument('Name,Email,Notes\n"Lovelace, Ada",ada@example.com,"hello, world"\n,,\n');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].cells.name, "Lovelace, Ada");
  assert.equal(parsed.rows[0].cells.notes, "hello, world");
});

test("row missing email and phone returns row error", () => {
  const parsed = parseCsvDocument("First Name,Last Name\nAda,Lovelace\n");
  const mappings = autoMapColumns(parsed.headers);
  const plan = planImportRows(parsed.rows, mappings);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].row, 2);
});

test("protected system field headers are not importable", () => {
  const parsed = parseCsvDocument("id,tenant_id,created_at,email\n1,t1,2026-01-01,a@example.com\n");
  const mappings = autoMapColumns(parsed.headers);
  assert.equal(mappings.id, DO_NOT_IMPORT);
  assert.equal(mappings.tenant_id, DO_NOT_IMPORT);
  assert.equal(mappings.created_at, DO_NOT_IMPORT);
  assert.equal(mappings.email, "email");
});

test("duplicate email in tenant is skipped by default", () => {
  const parsed = parseCsvDocument("Email,First Name\nada@example.com,Ada\n");
  const mappings = autoMapColumns(parsed.headers);
  const plan = planImportRows(parsed.rows, mappings, [{ id: "lead-1", email: "ada@example.com" }]);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.skipped.length, 1);
});

test("update missing fields only does not overwrite existing values", () => {
  const parsed = parseCsvDocument("Email,First Name,Last Name\nada@example.com,Augusta,Lovelace\n");
  const mappings = autoMapColumns(parsed.headers);
  const plan = planImportRows(parsed.rows, mappings, [{
    id: "lead-1",
    email: "ada@example.com",
    first_name: "Ada",
    last_name: "",
    custom_fields: {},
    raw_payload: {},
  }], { duplicateMode: "update_missing" });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].draft.first_name, undefined);
  assert.equal(plan.updates[0].draft.last_name, "Lovelace");
});

test("overwrite mapped fields overwrites allowed mapped fields", () => {
  const parsed = parseCsvDocument("Email,First Name\nada@example.com,Augusta\n");
  const mappings = autoMapColumns(parsed.headers);
  const plan = planImportRows(parsed.rows, mappings, [{
    id: "lead-1",
    email: "ada@example.com",
    first_name: "Ada",
    custom_fields: {},
    raw_payload: {},
  }], { duplicateMode: "overwrite" });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].draft.first_name, "Augusta");
});

test("custom field mapping stores value in custom fields", () => {
  const parsed = parseCsvDocument("Email,Policy Type\nada@example.com,Home\n");
  const mappings = autoMapColumns(parsed.headers, [{ key: "policy_type", label: "Policy Type", type: "single_line" }]);
  const draft = buildLeadDraft(parsed.rows[0], mappings);
  assert.equal(draft.custom_fields.policy_type, "Home");
});

test("CSV import routes do not queue action rows", () => {
  const preview = readFileSync(new URL("../src/app/api/leads/import/preview/route.js", import.meta.url), "utf8");
  const commit = readFileSync(new URL("../src/app/api/leads/import/commit/route.js", import.meta.url), "utf8");
  assert.equal(preview.includes(".from('actions')"), false);
  assert.equal(commit.includes(".from('actions')"), false);
  assert.equal(commit.includes("journey_status"), false);
});

test("CSV import uses a full-page wizard and import-scoped review", () => {
  const leadsPage = readFileSync(new URL("../src/app/leads/page.jsx", import.meta.url), "utf8");
  const importPage = readFileSync(new URL("../src/app/leads/import/page.jsx", import.meta.url), "utf8");
  const leadsRoute = readFileSync(new URL("../src/app/api/leads/route.js", import.meta.url), "utf8");

  assert.equal(leadsPage.includes('router.push("/leads/import")'), true);
  assert.equal(importPage.includes("/api/leads/import/preview"), true);
  assert.equal(importPage.includes("/api/leads/import/commit"), true);
  assert.equal(importPage.includes("/api/leads/bulk-enroll"), true);
  assert.equal(importPage.includes("No journeys will start"), true);
  assert.equal(importPage.includes("Importing leads will not start a journey"), true);
  assert.equal(importPage.includes("Enroll leads from this import"), true);
  assert.equal(importPage.includes("Enroll eligible leads"), true);
  assert.equal(importPage.includes("import_batch_id"), false);
  assert.equal(importPage.includes("Storage Path"), false);
  assert.equal(importPage.includes("Batch ID"), false);
  assert.equal(leadsRoute.includes("source_batch_id"), true);
});

test("Leads import filter is visible and supports import-scoped enrollment", () => {
  const leadsPage = readFileSync(new URL("../src/app/leads/page.jsx", import.meta.url), "utf8");

  assert.equal(leadsPage.includes("Showing leads from this import"), true);
  assert.equal(leadsPage.includes("Enroll this import in a journey"), true);
  assert.equal(leadsPage.includes('setBulkEnrollScope("import")'), true);
  assert.equal(leadsPage.includes("body.import_id = importBatchId"), true);
  assert.equal(leadsPage.includes("body.lead_ids = Array.from(selectedIds)"), true);
});
