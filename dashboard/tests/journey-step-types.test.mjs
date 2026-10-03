import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getJourneyExitDisplay,
  getJourneyNodeDisplay,
  getJourneyOutcomeDisplay,
  EVENT_WORKFLOW_PALETTE_ORDER,
  outcomesForStep,
  PALETTE_ORDER,
  STEP_TYPES,
} from "../src/lib/journeyStepTypes.js";

test("journey step type labels are business-readable while preserving raw ids", () => {
  assert.equal(STEP_TYPES.call.label, "Call lead");
  assert.equal(STEP_TYPES.team_alert.label, "Notify team");
  assert.equal(STEP_TYPES.http_request.label, "Send webhook");
  assert.deepEqual(getJourneyNodeDisplay("exit_flow"), {
    label: "End Journey",
    rawValue: "exit_flow",
  });
});

test("journey outcome and exit displays hide raw enum labels", () => {
  assert.deepEqual(getJourneyOutcomeDisplay("email", "sent"), {
    label: "Sent successfully",
    rawValue: "sent",
  });
  assert.deepEqual(getJourneyOutcomeDisplay("wait_reply", "replied"), {
    label: "Lead replied",
    rawValue: "replied",
  });
  assert.deepEqual(getJourneyExitDisplay("responded"), {
    label: "Lead replied",
    rawValue: "responded",
  });
});

test("email and sms expose only outcomes emitted by the send step runtime", () => {
  // First-advance outcomes only: 'sent' via record_send_event, plus the
  // permanent send-time failures classified by dispatch-twilio-sms v3
  // (failed / opt_out) and dispatch-gmail-email v8 (bounced). Delivery
  // confirmations and replies arrive after 'sent' consumed the advance,
  // so they are not step handles — replies branch via wait_reply.
  assert.deepEqual(STEP_TYPES.email.outcomes.map((outcome) => outcome.id), ["sent", "bounced"]);
  assert.deepEqual(STEP_TYPES.sms.outcomes.map((outcome) => outcome.id), ["sent", "failed", "opt_out"]);
  assert.match(STEP_TYPES.email.helperText, /Wait for reply/);
  assert.match(STEP_TYPES.sms.helperText, /Wait for reply/);
});

test("create_lead is not presented as a primary new-lead action", () => {
  assert.equal(STEP_TYPES.create_lead.label, "Create/update lead");
  assert.equal(STEP_TYPES.create_lead.defaultsExtra.action_name, "Create/update lead");
  assert.equal(PALETTE_ORDER.includes("create_lead"), false);
});

test("event workflow palette exposes only safe implemented nodes", () => {
  assert.equal(STEP_TYPES.create_lead_from_payload.label, "Create Lead");
  assert.deepEqual(
    STEP_TYPES.create_lead_from_payload.outcomes.map((outcome) => outcome.id),
    ["created", "updated", "skipped", "failed"]
  );
  assert.equal(STEP_TYPES.find_lead_from_payload.label, "Find Lead");
  assert.deepEqual(
    STEP_TYPES.find_lead_from_payload.outcomes.map((outcome) => outcome.id),
    ["found", "not_found"]
  );
  assert.deepEqual(EVENT_WORKFLOW_PALETTE_ORDER, ["find_lead_from_payload", "create_lead_from_payload", "conditional_split", "ab_split", "wait", "http_request", "exit_flow"]);
  assert.equal(EVENT_WORKFLOW_PALETTE_ORDER.includes("email"), false);
  assert.equal(EVENT_WORKFLOW_PALETTE_ORDER.includes("sms"), false);
  assert.equal(EVENT_WORKFLOW_PALETTE_ORDER.includes("call"), false);
  assert.equal(EVENT_WORKFLOW_PALETTE_ORDER.includes("http_request"), true);
});

test("ab split exposes A/B handles and appears after condition split", () => {
  assert.deepEqual(STEP_TYPES.ab_split.outcomes.map((outcome) => outcome.id), ["a", "b"]);
  const conditionIndex = PALETTE_ORDER.indexOf("conditional_split");
  const abIndex = PALETTE_ORDER.indexOf("ab_split");
  assert.ok(conditionIndex >= 0);
  assert.equal(abIndex, conditionIndex + 1);
});

test("conditional split outcomes support legacy and named branch modes", () => {
  assert.deepEqual(
    outcomesForStep("conditional_split").map((outcome) => outcome.id),
    ["yes", "no"]
  );

  const split = {
    type: "conditional_split",
    branches: [
      { id: "branch_1", label: "High value" },
      { id: "branch_2", label: "Renewal" },
    ],
  };

  assert.deepEqual(
    outcomesForStep(split).map((outcome) => outcome.id),
    ["branch_1", "branch_2", "else"]
  );
  assert.equal(getJourneyOutcomeDisplay(split, "branch_1").label, "High value");
});
