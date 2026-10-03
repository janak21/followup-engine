import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getTemplateChannelDisplay,
  getTemplateTitle,
  normalizeTemplateText,
  validateMergeTags,
} from "../src/lib/templateDisplay.js";

test("template channel display is readable while preserving raw values", () => {
  assert.deepEqual(getTemplateChannelDisplay("team_alert"), {
    label: "Team alert",
    variant: "neutral",
    rawValue: "team_alert",
  });
  assert.deepEqual(getTemplateChannelDisplay("email"), {
    label: "Email",
    variant: "info",
    rawValue: "email",
  });
});

test("template title prioritizes subject and falls back to readable key", () => {
  assert.equal(getTemplateTitle({ subject: "Quick follow-up", template_key: "email_day_1" }), "Quick follow-up");
  assert.equal(getTemplateTitle({ template_key: "email_day_1" }), "Email Day 1");
});

test("template preview normalizes escaped line breaks", () => {
  assert.equal(normalizeTemplateText("Hi {{first_name}},\\n\\nChecking in."), "Hi {{first_name}},\n\nChecking in.");
});

test("merge tag validation catches malformed braces without blocking valid tags", () => {
  assert.deepEqual(validateMergeTags("Hi {{first_name}}"), []);
  assert.deepEqual(validateMergeTags("Hi {{first_name"), [
    "A merge tag is missing closing braces: }}",
    "A merge tag appears unfinished.",
  ]);
  assert.deepEqual(validateMergeTags("Hi first_name}}"), [
    "A merge tag has closing braces without matching opening braces: {{",
  ]);
  assert.deepEqual(validateMergeTags("Hi {{ }}"), ["A merge tag is empty."]);
});
