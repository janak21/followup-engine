import test from "node:test";
import assert from "node:assert/strict";

import {
  getCustomFieldMergeTag,
  getCustomFieldTypeDisplay,
  getCustomFieldUsageSummary,
  textReferencesCustomField,
} from "../src/lib/customFieldDisplay.js";

test("custom field display maps type and merge tag labels", () => {
  assert.equal(getCustomFieldTypeDisplay("multi_select").label, "Multi-select");
  assert.equal(getCustomFieldTypeDisplay("unknown_type").label, "unknown type");
  assert.equal(getCustomFieldMergeTag({ key: "coverage_type" }), "{{coverage_type}}");
});

test("custom field reference detection only counts explicit references", () => {
  assert.equal(textReferencesCustomField("Hi {{coverage_type}}", "coverage_type"), true);
  assert.equal(textReferencesCustomField("Hi {{ custom.coverage_type }}", "coverage_type"), true);
  assert.equal(textReferencesCustomField("condition uses custom.coverage_type", "coverage_type"), true);
  assert.equal(textReferencesCustomField("coverage_type appears as plain text", "coverage_type"), false);
  assert.equal(textReferencesCustomField("custom.coverage_type_extra", "coverage_type"), false);
});

test("custom field usage summary counts templates and journeys", () => {
  const field = { key: "coverage_type" };
  const summary = getCustomFieldUsageSummary(field, {
    checked: true,
    templates: [
      { subject: "Policy", body: "Your {{coverage_type}} is ready." },
      { subject: "Other", body: "No field here." },
    ],
    journeys: [
      { spec: { branches: [{ field: "custom.coverage_type", value: "home" }] } },
      { spec: { branches: [{ field: "custom.quote_amount", value: "100" }] } },
    ],
  });

  assert.equal(summary.checked, true);
  assert.equal(summary.templateCount, 1);
  assert.equal(summary.journeyCount, 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.label, "Used in 1 template, 1 journey");
});

test("custom field usage summary is honest when sources were not checked", () => {
  const summary = getCustomFieldUsageSummary({ key: "coverage_type" }, {});

  assert.equal(summary.checked, false);
  assert.equal(summary.label, "Usage not checked");
  assert.equal(summary.detail, "Usage has not been fully checked.");
});
