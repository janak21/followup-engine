import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getComplianceStatusDisplay,
  getConversationStatusDisplay,
  getDeliveryStatusDisplay,
  getJourneyStatusDisplay,
  getLeadStatusDisplay,
  getSuppressionReasonDisplay,
  getSuppressionSourceDisplay,
} from "../src/lib/statusDisplay.ts";

test("lead and journey display split active/responded/completed semantics", () => {
  assert.deepEqual(
    pick(getLeadStatusDisplay("responded", { responded: true })),
    { label: "Engaged", variant: "info" }
  );
  assert.deepEqual(
    pick(getJourneyStatusDisplay("responded")),
    { label: "Exited", variant: "neutral" }
  );
  assert.deepEqual(
    pick(getJourneyStatusDisplay("active")),
    { label: "Running", variant: "success" }
  );
});

test("conversation and compliance displays use customer-facing labels", () => {
  assert.deepEqual(
    pick(getConversationStatusDisplay({ opt_out: true, responded: true })),
    { label: "Replied", variant: "info" }
  );
  assert.deepEqual(
    pick(getConversationStatusDisplay({ callback_requested: true })),
    { label: "Callback requested", variant: "warning" }
  );
  assert.deepEqual(
    pick(getComplianceStatusDisplay({ opt_out: true })),
    { label: "Unsubscribed", variant: "danger" }
  );
});

test("delivery and suppression displays avoid raw enum labels", () => {
  assert.deepEqual(
    pick(getDeliveryStatusDisplay("failed_permanent")),
    { label: "Failed", variant: "danger" }
  );
  assert.deepEqual(
    pick(getDeliveryStatusDisplay("completed", { action_type: "sms" })),
    { label: "Accepted", variant: "success" }
  );
  assert.deepEqual(
    pick(getSuppressionReasonDisplay("bounce_hard")),
    { label: "Hard bounced", variant: "danger" }
  );
  assert.deepEqual(
    pick(getSuppressionSourceDisplay("inbound_email_bounce")),
    { label: "Email bounce", variant: "danger" }
  );
});

function pick(display) {
  return {
    label: display.label,
    variant: display.variant,
  };
}
