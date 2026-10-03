import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getAiDecisionDisplay,
  getAiIntentLabel,
  getOperationActionDisplay,
  getOperationStatusDisplay,
} from "../src/lib/operationDisplay.js";

test("operation action and status displays avoid raw internal labels", () => {
  assert.equal(getOperationActionDisplay("team_alert").label, "Team alert");
  assert.equal(getOperationActionDisplay("http_request").label, "Webhook");
  assert.equal(getOperationStatusDisplay("in_progress").label, "Processing");
  assert.equal(getOperationStatusDisplay("pending").label, "Queued");
});

test("AI decisions use customer-readable labels", () => {
  assert.deepEqual(pick(getAiDecisionDisplay({ escalation_reason: null })), {
    label: "AI replied",
    variant: "success",
  });
  assert.deepEqual(pick(getAiDecisionDisplay({ escalation_reason: "confidence_below_threshold" })), {
    label: "Needs human review",
    variant: "warning",
  });
  assert.deepEqual(pick(getAiDecisionDisplay({ escalation_reason: "llm_error_timeout" })), {
    label: "AI reply failed",
    variant: "danger",
  });
});

test("AI intent labels reuse readable agent intent mapping", () => {
  assert.equal(getAiIntentLabel("pricing_question"), "Pricing question");
});

function pick(display) {
  return {
    label: display.label,
    variant: display.variant,
  };
}

