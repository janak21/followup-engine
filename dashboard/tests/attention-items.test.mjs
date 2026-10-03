import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAttentionItems } from "../src/lib/attentionItems.js";

test("buildAttentionItems prioritizes human replies, callbacks, failures, suppressions, and system issues", () => {
  const items = buildAttentionItems({
    aiEscalations: [{
      id: "ai-1",
      lead_id: "lead-ai",
      leadName: "Maya Chen",
      intent: "objection",
      escalation_reason: "complex_question",
      created_at: "2026-06-27T09:00:00.000Z",
    }],
    callbacks: [{
      id: "lead-cb",
      first_name: "Sam",
      last_name: "Rivera",
      callback_requested: true,
      callback_at: "2026-06-27T10:30:00.000Z",
    }],
    failedActions: [{
      id: "act-1",
      lead_id: "lead-fail",
      leadName: "Jordan Lee",
      action_type: "email",
      status: "failed_permanent",
      error_message: "Provider rejected send",
      completed_at: "2026-06-27T08:45:00.000Z",
    }],
    suppressions: [{
      id: "sup-1",
      lead_id: "lead-sup",
      email: "bounce@example.com",
      reason: "bounce_hard",
      source: "inbound_email_bounce",
      created_at: "2026-06-27T08:30:00.000Z",
    }],
    stuckActions: [{
      id: "stuck-1",
      lead_id: "lead-stuck",
      action_type: "sms",
      locked_until: "2026-06-27T08:00:00.000Z",
    }],
    errors: [{
      id: "err-1",
      severity: "error",
      message: "Dispatch worker failed",
      created_at: "2026-06-27T07:00:00.000Z",
    }],
  }, { limit: 6 });

  assert.deepEqual(items.map((item) => item.type), [
    "Needs human reply",
    "Callback due",
    "Failed action",
    "Email bounced",
    "Stuck action",
    "System issue",
  ]);
  assert.equal(items[0].title, "Maya Chen");
  assert.equal(items[0].reason, "AI escalated this reply as objection.");
  assert.equal(items[0].href, "/leads?leadId=lead-ai");
  assert.equal(items[2].reason, "Email follow-up failed: Provider rejected send");
  assert.equal(items[3].reason, "Email hard bounced from Email bounce.");
  assert.ok(!JSON.stringify(items).includes("failed_permanent"));
  assert.ok(!JSON.stringify(items).includes("bounce_hard"));
  assert.ok(!JSON.stringify(items).includes("inbound_email_bounce"));
});

test("buildAttentionItems returns clear empty state when no source rows exist", () => {
  const items = buildAttentionItems({}, { limit: 8 });
  assert.deepEqual(items, []);
});
