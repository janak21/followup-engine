import assert from "node:assert/strict";
import { test } from "node:test";

import {
  flattenPayloadScalars,
  getDetectedPayloadFieldRows,
  mergeWorkflowFieldMapping,
  suggestLeadDestination,
  toWorkflowPayloadSource,
} from "../src/lib/webhookPayloadMapping.js";

test("payload path generation supports nested objects and arrays", () => {
  const payload = {
    data: {
      formId: "form_123",
      fields: [
        { label: "Name", value: "Jane" },
        { label: "Email Address", value: "jane@example.com" },
      ],
    },
  };

  const paths = flattenPayloadScalars(payload).map((row) => row.source);

  assert.ok(paths.includes("payload.data.formId"));
  assert.ok(paths.includes("payload.data.fields[0].value"));
  assert.ok(paths.includes("payload.data.fields[1].value"));
});

test("field-like payload arrays expose generated paths and destination suggestions", () => {
  const rows = getDetectedPayloadFieldRows({
    data: {
      fields: [
        { label: "Full Name", value: "Jane Doe" },
        { label: "Email Address", value: "jane@example.com" },
        { label: "Phone Number", value: "+15551234567" },
        { label: "What type of policy?", value: "Home" },
      ],
    },
  });

  assert.equal(rows[0].source, "payload.data.fields[0].value");
  assert.equal(rows[0].suggestedDestination, "first_name");
  assert.equal(rows[1].suggestedDestination, "email");
  assert.equal(rows[2].suggestedDestination, "phone");
  assert.equal(rows[3].suggestedDestination, "custom.what_type_of_policy");
});

test("detected fields are not tied to Tally's data.fields location", () => {
  const rows = getDetectedPayloadFieldRows({
    submission: {
      answers: [
        { title: "Email", value: "ada@example.com" },
        { question: "Mobile", value: "+15550001111" },
      ],
    },
  });

  assert.equal(rows[0].source, "payload.submission.answers[0].value");
  assert.equal(rows[0].suggestedDestination, "email");
  assert.equal(rows[1].source, "payload.submission.answers[1].value");
  assert.equal(rows[1].suggestedDestination, "phone");
});

test("consent checkbox labels are treated as custom fields, not phone fields", () => {
  assert.equal(
    suggestLeadDestination("By checking this box, I consent to receive phone calls"),
    "custom.by_checking_this_box_i_consent_to_receive_phone_calls"
  );
});

test("workflow payload source normalizes bare paths without changing payload-prefixed paths", () => {
  assert.equal(toWorkflowPayloadSource("data.fields[3].value"), "payload.data.fields[3].value");
  assert.equal(toWorkflowPayloadSource("payload.data.formId"), "payload.data.formId");
  assert.equal(toWorkflowPayloadSource("$json.leadRecordId"), "payload.leadRecordId");
  assert.equal(toWorkflowPayloadSource("{{ $json.data.fields[3].value }}"), "payload.data.fields[3].value");
});

test("destination suggestions cover common lead labels", () => {
  assert.equal(suggestLeadDestination("Email"), "email");
  assert.equal(suggestLeadDestination("Mobile phone"), "phone");
  assert.equal(suggestLeadDestination("First name"), "first_name");
  assert.equal(suggestLeadDestination("Last Name"), "last_name");
});

test("field mapping merge accumulates multiple detected mappings", () => {
  let mappings = [];
  mappings = mergeWorkflowFieldMapping(mappings, "email", "payload.data.fields[3].value");
  mappings = mergeWorkflowFieldMapping(mappings, "phone", "payload.data.fields[2].value");
  mappings = mergeWorkflowFieldMapping(mappings, "first_name", "payload.data.fields[0].value");

  assert.deepEqual(mappings, [
    { destination: "email", source: { source: "payload.data.fields[3].value" } },
    { destination: "phone", source: { source: "payload.data.fields[2].value" } },
    { destination: "first_name", source: { source: "payload.data.fields[0].value" } },
  ]);
});

test("field mapping merge updates an existing destination without dropping other mappings", () => {
  const mappings = mergeWorkflowFieldMapping(
    [
      { destination: "email", source: { source: "payload.old_email" } },
      { destination: "phone", source: { source: "payload.phone" } },
    ],
    "email",
    "payload.data.fields[3].value"
  );

  assert.deepEqual(mappings, [
    { destination: "email", source: { source: "payload.data.fields[3].value" } },
    { destination: "phone", source: { source: "payload.phone" } },
  ]);
});

test("getDetectedPayloadFieldRows falls back to scalar leaves for generic JSON", () => {
  const rows = getDetectedPayloadFieldRows({
    email: "a@b.com",
    first_name: "Ada",
    meta: { source: "fb-ads", score: 42 },
    tags: ["hot", "new"],
  });
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(byPath["email"].suggestedDestination, "email");
  assert.equal(byPath["first_name"].suggestedDestination, "first_name");
  assert.equal(byPath["meta.source"].suggestedDestination, "source");
  assert.ok(byPath["meta.score"]);
  assert.ok(byPath["tags[0]"]);
  // labels are humanized from the last path segment
  assert.equal(byPath["first_name"].label, "First name");
});

test("getDetectedPayloadFieldRows still prefers form-style field arrays when present", () => {
  const rows = getDetectedPayloadFieldRows({
    data: { fields: [{ label: "Email address", value: "x@y.com" }] },
    stray_scalar: "ignored-when-form-fields-exist",
  });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.path.includes("data.fields")));
});
