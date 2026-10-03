import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getSuppressionChannelDisplay,
  getSuppressionReasonDisplay,
  getSuppressionSourceDisplay,
  groupSuppressions,
} from "../src/lib/suppressionDisplay.js";

test("suppression reason labels are readable while preserving raw values", () => {
  assert.deepEqual(pick(getSuppressionReasonDisplay("bounce_hard")), {
    label: "Hard bounce",
    variant: "danger",
    rawValue: "bounce_hard",
  });
  assert.deepEqual(pick(getSuppressionReasonDisplay("invalid_phone")), {
    label: "Invalid phone",
    variant: "danger",
    rawValue: "invalid_phone",
  });
  assert.deepEqual(pick(getSuppressionReasonDisplay("unknown")), {
    label: "Unknown reason",
    variant: "neutral",
    rawValue: "unknown",
  });
});

test("suppression source labels are readable while preserving raw values", () => {
  assert.deepEqual(pick(getSuppressionSourceDisplay("inbound_email_bounce")), {
    label: "Automatic email bounce",
    variant: "danger",
    rawValue: "inbound_email_bounce",
  });
  assert.deepEqual(pick(getSuppressionSourceDisplay("journey")), {
    label: "Journey automation",
    variant: "info",
    rawValue: "journey",
  });
});

test("suppression channels are readable", () => {
  assert.equal(getSuppressionChannelDisplay("sms").label, "SMS / phone");
  assert.equal(getSuppressionChannelDisplay("").label, "All channels");
});

test("groupSuppressions groups duplicate channel and identifier without dropping events", () => {
  const groups = groupSuppressions([
    { id: "1", channel: "email", email: "a@example.com", reason: "manual", created_at: "2026-01-01T00:00:00Z" },
    { id: "2", channel: "email", email: "a@example.com", reason: "bounce_hard", created_at: "2026-01-02T00:00:00Z" },
    { id: "3", channel: "sms", phone_e164: "+15550123456", reason: "manual", created_at: "2026-01-03T00:00:00Z" },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].latest.id, "2");
  assert.deepEqual(groups[0].events.map((event) => event.id), ["2", "1"]);
});

function pick(display) {
  return {
    label: display.label,
    variant: display.variant,
    rawValue: display.rawValue,
  };
}
