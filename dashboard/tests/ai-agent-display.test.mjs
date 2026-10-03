import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_AGENT_ESCALATION_EXAMPLES,
  AI_AGENT_INTENT_OPTIONS,
  getAiAgentIntentDisplay,
} from "../src/lib/aiAgentDisplay.js";

test("AI agent intent labels are readable while preserving raw values", () => {
  assert.deepEqual(getAiAgentIntentDisplay("complex"), {
    label: "Complex or multi-part question",
    description: "Lead asks something nuanced, unclear, or multi-step.",
    rawValue: "complex",
  });
  assert.deepEqual(getAiAgentIntentDisplay("unsubscribe"), {
    label: "Opt-out request",
    description: "Lead asks to stop, unsubscribe, or not be contacted.",
    rawValue: "unsubscribe",
  });
  assert.deepEqual(getAiAgentIntentDisplay("pricing_question"), {
    label: "Pricing question",
    description: "Lead asks about price, coverage, plans, or costs.",
    rawValue: "pricing_question",
  });
});

test("AI agent escalation options expose all persisted intent keys", () => {
  assert.deepEqual(
    AI_AGENT_INTENT_OPTIONS.map((option) => option.value),
    [
      "positive",
      "negative",
      "question",
      "objection",
      "out_of_office",
      "complex",
      "unsubscribe",
      "auto_reply",
      "meeting_request",
      "pricing_question",
      "other",
    ]
  );
});

test("AI agent escalation examples use customer-facing labels", () => {
  assert.ok(AI_AGENT_ESCALATION_EXAMPLES.length >= 4);
  assert.ok(AI_AGENT_ESCALATION_EXAMPLES.some((example) => example.label === "Opt-out request"));
  assert.ok(AI_AGENT_ESCALATION_EXAMPLES.every((example) => !example.label.includes("_")));
});
