import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BULK_ENROLL_STATUSES,
  buildBulkEnrollIdempotencyKey,
  buildSuppressionLookup,
  getBulkEnrollEligibility,
  planBulkEnroll,
} from "../src/lib/bulkEnroll.js";

const journey = {
  id: "journey-1",
  journey_key: "renewal_followup",
  spec: {
    steps: [
      { index: 0, type: "email", template_key: "renewal_intro" },
      { index: 1, type: "sms", template_key: "renewal_sms" },
    ],
  },
};

test("bulk enroll plans only eligible tenant-returned leads as ready", () => {
  const leads = [
    { id: "ready", email: "ready@example.com", journey_status: "new", opt_out: false },
    { id: "active", email: "active@example.com", journey_status: "active", opt_out: false },
    { id: "optout", email: "optout@example.com", journey_status: "new", opt_out: true },
    { id: "suppressed", email: "blocked@example.com", journey_status: "new", opt_out: false },
    { id: "missing-email", phone_e164: "+15550100", journey_status: "new", opt_out: false },
  ];

  const plan = planBulkEnroll({
    requestedLeadIds: ["ready", "active", "optout", "suppressed", "missing-email", "other-tenant"],
    leads,
    journey,
    suppressions: [{ email: "blocked@example.com" }],
    activeRunsByLeadId: new Map([["active", new Set(["renewal_followup"])]]),
  });

  assert.equal(plan.summary.ready, 1);
  assert.equal(plan.summary.skipped_already_active, 1);
  assert.equal(plan.summary.skipped_opted_out, 1);
  assert.equal(plan.summary.skipped_suppressed, 1);
  assert.equal(plan.summary.skipped_missing_contact, 1);
  assert.equal(plan.summary.failed, 1);
});

test("bulk enroll supports phone-required first steps", () => {
  const smsJourney = {
    journey_key: "sms_first",
    spec: { steps: [{ index: 0, type: "sms" }] },
  };

  const plan = planBulkEnroll({
    requestedLeadIds: ["has-phone", "no-phone"],
    leads: [
      { id: "has-phone", phone_e164: "+15550100", journey_status: "new", opt_out: false },
      { id: "no-phone", email: "lead@example.com", journey_status: "new", opt_out: false },
    ],
    journey: smsJourney,
  });

  assert.equal(plan.summary.ready, 1);
  assert.equal(plan.summary.skipped_missing_contact, 1);
});

test("bulk enroll idempotency key is stable for repeated submissions", () => {
  assert.equal(
    buildBulkEnrollIdempotencyKey("lead-1", "renewal_followup"),
    buildBulkEnrollIdempotencyKey("lead-1", "renewal_followup")
  );
  assert.equal(
    buildBulkEnrollIdempotencyKey("lead-1", "renewal_followup"),
    "lead-1:renewal_followup:0:bulk_enroll"
  );
});

test("bulk enroll API queues actions without dispatching providers", () => {
  const route = readFileSync(new URL("../src/app/api/leads/bulk-enroll/route.js", import.meta.url), "utf8");

  assert.equal(route.includes("dispatch_pending_actions"), false);
  assert.equal(route.includes("dispatch-gmail-email"), false);
  assert.equal(route.includes("dispatch-twilio-sms"), false);
  assert.equal(route.includes("enroll_lead_in_journey"), true);
  assert.equal(route.includes(".from(\"actions\")"), false);
  assert.equal(route.includes(".eq(\"tenant_id\", tenantId)"), true);
  assert.equal(route.includes("buildBulkEnrollIdempotencyKey"), false);
});

test("bulk enroll API accepts import_id and scopes leads to that import", () => {
  const route = readFileSync(new URL("../src/app/api/leads/bulk-enroll/route.js", import.meta.url), "utf8");

  assert.equal(route.includes("import_id"), true);
  assert.equal(route.includes(".from(\"import_batches\")"), true);
  assert.equal(route.includes(".eq(\"source_batch_id\", importId)"), true);
  assert.equal(route.includes("Send lead_ids or import_id, not both"), true);
  assert.equal(route.includes("Import not found for this workspace."), true);
});

test("bulk enroll import scope excludes old imports through source batch filtering", () => {
  const plan = planBulkEnroll({
    requestedLeadIds: ["new-import-lead"],
    leads: [
      { id: "new-import-lead", email: "new@example.com", source_batch_id: "import-new", journey_status: "new", opt_out: false },
      { id: "old-import-lead", email: "old@example.com", source_batch_id: "import-old", journey_status: "new", opt_out: false },
    ],
    journey,
  });

  assert.equal(plan.summary.ready, 1);
  assert.equal(plan.results.some((row) => row.lead_id === "old-import-lead"), false);
});

test("CSV import remains lead-only after bulk enroll addition", () => {
  const commit = readFileSync(new URL("../src/app/api/leads/import/commit/route.js", import.meta.url), "utf8");
  const importPage = readFileSync(new URL("../src/app/leads/import/page.jsx", import.meta.url), "utf8");

  assert.equal(commit.includes(".from('actions')"), false);
  assert.equal(commit.includes(".from(\"actions\")"), false);
  assert.equal(importPage.includes("/api/leads/import/commit"), true);
  assert.equal(importPage.includes("/api/leads/bulk-enroll"), true);
});

test("lead active in a DIFFERENT journey is still eligible (multi-enrollment)", () => {
  const lead = { id: "l1", email: "a@b.co", journey_status: "active", journey_template: "other_journey" };
  const nextJourney = { journey_key: "reactivation", spec: { steps: [{ index: 0, type: "email" }] } };
  const result = getBulkEnrollEligibility(lead, nextJourney, buildSuppressionLookup(), new Set(["other_journey"]));
  assert.equal(result.status, BULK_ENROLL_STATUSES.READY);
});

test("lead with a running run in the SAME journey is skipped", () => {
  const lead = { id: "l1", email: "a@b.co", journey_status: "active", journey_template: "reactivation" };
  const nextJourney = { journey_key: "reactivation", spec: { steps: [{ index: 0, type: "email" }] } };
  const result = getBulkEnrollEligibility(lead, nextJourney, buildSuppressionLookup(), new Set(["reactivation"]));
  assert.equal(result.status, BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE);
});

test("legacy journey_status alone no longer blocks other journeys", () => {
  const lead = { id: "l1", email: "a@b.co", journey_status: "active", journey_template: "old_one" };
  const nextJourney = { journey_key: "new_one", spec: { steps: [{ index: 0, type: "email" }] } };
  const result = getBulkEnrollEligibility(lead, nextJourney, buildSuppressionLookup(), new Set());
  assert.equal(result.status, BULK_ENROLL_STATUSES.READY);
});
