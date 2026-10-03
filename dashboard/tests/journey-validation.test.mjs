import assert from "node:assert/strict";
import { test } from "node:test";

import { validateJourneySpec } from "../src/lib/journeyValidation.ts";

test("validateJourneySpec reports invalid when start is missing", () => {
  const result = validateJourneySpec({
    steps: [{ index: 0, type: "email", template_key: "intro_email", on_outcome: { sent: { exit: "completed" } } }],
    triggerNextStep: null,
  }, {
    templates: [{ template_key: "intro_email", channel: "email" }],
    suppressionSafetyKnown: true,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.level === "error" && check.title === "Journey has no starting step."));
});

test("validateJourneySpec catches missing required step configuration", () => {
  const result = validateJourneySpec({
    steps: [
      { index: 0, type: "email", on_outcome: { sent: { next_step: 1 } } },
      { index: 1, type: "http_request", http_url: "", on_outcome: { default: { exit: "completed" } } },
    ],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Send Email has no message content."));
  assert.ok(result.checks.some((check) => check.title === "Webhook step is missing a URL."));
});

test("validateJourneySpec warns on disconnected branches and all-ending outcomes", () => {
  const disconnected = validateJourneySpec({
    steps: [{
      index: 0,
      type: "sms",
      template_key: "sms_1",
      on_outcome: { sent: { next_step: 1 } },
    }],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "sms_1", channel: "sms" }],
  });

  assert.equal(disconnected.status, "invalid");
  assert.ok(disconnected.checks.some((check) => check.title === "Sent successfully branch points to a missing step."));

  const allEnding = validateJourneySpec({
    steps: [{
      index: 0,
      type: "email",
      template_key: "email_1",
      on_outcome: {
        sent: { exit: "completed" },
        bounced: { exit: "completed" },
      },
    }],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "email_1", channel: "email" }],
    suppressionSafetyKnown: true,
  });

  assert.equal(allEnding.status, "warning");
  assert.ok(allEnding.checks.some((check) => check.title === "All outcomes end the journey immediately."));
});

test("validateJourneySpec returns ready when required checks pass", () => {
  const result = validateJourneySpec({
    steps: [
      { index: 0, type: "email", template_key: "email_1", on_outcome: { sent: { next_step: 1 }, bounced: { exit: "completed" } } },
      { index: 1, type: "wait", duration: { amount: 1, unit: "days" }, on_outcome: { default: { next_step: 2 } } },
      { index: 2, type: "exit_flow", on_outcome: {} },
    ],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "email_1", channel: "email" }],
    suppressionSafetyKnown: true,
  });

  assert.notEqual(result.status, "invalid");
  assert.equal(result.summary.error, 0);
  assert.ok(result.summary.pass >= 2);
  assert.equal(result.summary.error, 0);
  assert.equal(result.summary.warning, 0);
});

test("validateJourneySpec blocks unsupported trigger types", () => {
  const result = validateJourneySpec({
    trigger_type: "missed_call",
    steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Trigger is not available yet."));
});

test("validateJourneySpec blocks unsupported webhook methods", () => {
  const result = validateJourneySpec({
    steps: [{ index: 0, type: "http_request", http_method: "PATCH", http_url: "https://example.test/hook", on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "PATCH webhook method is not supported."));
});

test("validateJourneySpec blocks send-step outcomes that the runtime does not emit", () => {
  const result = validateJourneySpec({
    steps: [{
      index: 0,
      type: "email",
      template_key: "email_1",
      on_outcome: { sent: { exit: "completed" }, replied: { exit: "responded" }, bounced: { exit: "failed" } },
    }],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "email_1", channel: "email" }],
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Lead replied is not emitted by this step."));
  // bounced IS a legitimate send-time outcome since dispatch-gmail-email v8
  // classification — it must not be flagged.
  assert.ok(!result.checks.some((check) => check.title.includes("ounced is not emitted")));
});

test("sms and email steps accept inline content without a template", () => {
  const sms = validateJourneySpec({
    steps: [{
      index: 0,
      type: "sms",
      content_mode: "inline",
      inline_body: "Hey {{first_name}} - quick question",
      on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "opted_out" } },
    }],
    triggerNextStep: 0,
  }, { templates: [] });

  const email = validateJourneySpec({
    steps: [{
      index: 0,
      type: "email",
      content_mode: "inline",
      inline_subject: "Quick question",
      inline_body: "Hey {{first_name}} - quick question",
      on_outcome: { sent: { exit: "completed" }, bounced: { exit: "completed" }, failed: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  }, { templates: [] });

  assert.ok(!sms.checks.some((check) => check.title.includes("missing a template")));
  assert.ok(!email.checks.some((check) => check.title.includes("missing a template")));
});

test("sms steps with neither template nor inline body are invalid", () => {
  const result = validateJourneySpec({
    steps: [{
      index: 0,
      type: "sms",
      content_mode: "inline",
      inline_body: "",
      on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "opted_out" } },
    }],
    triggerNextStep: 0,
  }, { templates: [] });

  assert.equal(result.status, "invalid");
});

test("validateJourneySpec warns when legacy create_lead steps are present", () => {
  const result = validateJourneySpec({
    steps: [{ index: 0, type: "create_lead", fields: [{ key: "first_name", value: "{{first_name}}" }], on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
  }, {
    suppressionSafetyKnown: true,
  });

  assert.equal(result.status, "warning");
  assert.ok(result.checks.some((check) => check.title === "Create/update lead updates the current lead."));
});

test("webhook-triggered automations require webhook trigger and create lead mapping", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "lead_enrolled",
    steps: [{
      index: 0,
      type: "create_lead_from_payload",
      field_mappings: [{ destination: "first_name", source: { source: "payload.first_name" } }],
      on_outcome: { created: { next_step: 1 }, updated: { next_step: 1 }, skipped: { next_step: 1 }, failed: { exit: "failed" } },
    }, {
      index: 1,
      type: "exit_flow",
      on_outcome: {},
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Webhook-triggered automations must start from a webhook."));
  assert.ok(result.checks.some((check) => check.title === "Create Lead must map email or phone."));
});

test("webhook-triggered automations block unsupported steps and protected mappings", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "create_lead_from_payload",
      field_mappings: [
        { destination: "email", source: { source: "payload.email" } },
        { destination: "tenant_id", source: { source: "payload.tenant_id" } },
      ],
      on_outcome: { created: { next_step: 1 }, updated: { next_step: 1 }, skipped: { next_step: 1 }, failed: { exit: "failed" } },
    }, {
      index: 1,
      type: "email",
      template_key: "email_1",
      on_outcome: { sent: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "email_1", channel: "email" }],
  });

  assert.equal(result.status, "invalid");
  assert.ok(!result.checks.some((check) => check.title === "Email needs a lead first."));
  assert.ok(result.checks.some((check) => check.title === "Create Lead maps a protected field."));
});

test("webhook-triggered automations call out lead-required actions before lead context", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "email",
      template_key: "email_1",
      on_outcome: { sent: { exit: "completed" } },
    }, {
      index: 1,
      type: "add_tag",
      tag_name: "webhook",
      on_outcome: { default: { exit: "completed" } },
    }, {
      index: 2,
      type: "remove_tag",
      tag_name: "old",
      on_outcome: { default: { exit: "completed" } },
    }, {
      index: 3,
      type: "update_lead",
      fields: [{ key: "first_name", value: "payload.first_name" }],
      on_outcome: { default: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "email_1", channel: "email" }],
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Email needs a lead first."));
  assert.ok(result.checks.some((check) => check.title === "Add Tag needs a lead first."));
  assert.ok(result.checks.some((check) => check.title === "Remove Tag needs a lead first."));
  assert.ok(result.checks.some((check) => check.title === "Update Lead needs a lead first."));
  assert.ok(result.checks.some((check) => check.message === "Add Create Lead or Find Lead before this step."));
});

test("webhook-triggered automations allow bridged lead actions after Create Lead", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "create_lead_from_payload",
      field_mappings: [{ destination: "email", source: { source: "payload.email" } }],
      on_outcome: { created: { next_step: 1 }, updated: { next_step: 1 }, skipped: { next_step: 1 }, failed: { exit: "failed" } },
    }, {
      index: 1,
      type: "add_tag",
      tag_name: "webhook",
      on_outcome: { default: { next_step: 2 } },
    }, {
      index: 2,
      type: "remove_tag",
      tag_name: "old",
      on_outcome: { default: { next_step: 3 } },
    }, {
      index: 3,
      type: "update_lead",
      fields: [
        { key: "first_name", value: "payload.first_name" },
        { key: "custom.policy_type", value: "payload.policy_type" },
      ],
      on_outcome: { default: { next_step: 4 } },
    }, {
      index: 4,
      type: "email",
      template_key: "email_1",
      on_outcome: { sent: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "email_1", channel: "email" }],
  });

  assert.notEqual(result.status, "invalid");
  assert.equal(result.summary.error, 0);
  assert.ok(!result.checks.some((check) => check.title === "Email needs a lead first."));
  assert.ok(!result.checks.some((check) => check.title === "Add Tag needs a lead first."));
  assert.ok(!result.checks.some((check) => check.title === "Remove Tag needs a lead first."));
  assert.ok(!result.checks.some((check) => check.title === "Update Lead needs a lead first."));
  assert.ok(!result.checks.some((check) => check.title === "Email needs webhook runtime bridge."));
});

test("event workflows treat provider steps as native after queue unification", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [
      {
        index: 0,
        type: "create_lead_from_payload",
        field_mappings: [{ destination: "email", source: { source: "payload.email" } }],
        on_outcome: {
          created: { next_step: 1 },
          updated: { next_step: 1 },
          skipped: { exit: "completed" },
          failed: { exit: "failed" },
        },
      },
      {
        index: 1,
        type: "sms",
        template_key: "sms_1",
        on_outcome: {
          sent: { exit: "completed" },
          failed: { exit: "completed" },
          opt_out: { exit: "opted_out" },
        },
      },
    ],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "sms_1", channel: "sms" }],
  });

  assert.equal(result.summary.error, 0);
});

test("webhook-triggered automations allow Wait before lead context", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "wait",
      duration: { amount: 1, unit: "minutes" },
      on_outcome: { default: { next_step: 1 } },
    }, {
      index: 1,
      type: "exit_flow",
      on_outcome: {},
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.summary.error, 0);
  assert.ok(!result.checks.some((check) => check.title === "Wait needs a lead first."));
});

test("validateJourneySpec blocks protected Update Lead mappings", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "create_lead_from_payload",
      field_mappings: [{ destination: "email", source: { source: "payload.email" } }],
      on_outcome: { created: { next_step: 1 }, updated: { next_step: 1 }, skipped: { next_step: 1 }, failed: { exit: "failed" } },
    }, {
      index: 1,
      type: "update_lead",
      fields: [
        { key: "first_name", value: "payload.first_name" },
        { key: "opt_out", value: "true" },
        { key: "responded", value: "true" },
        { key: "callback_requested", value: "true" },
        { key: "custom.tags", value: "webhook" },
      ],
      on_outcome: { default: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Update Lead maps a protected field."));
  assert.ok(result.checks.some((check) => check.message.includes("opt_out, responded, callback_requested, journey_status, or tags")));
});

test("webhook-triggered automations allow event-aware HTTP but still defer unsupported legacy handlers", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "create_lead_from_payload",
      field_mappings: [{ destination: "email", source: { source: "payload.email" } }],
      on_outcome: { created: { next_step: 1 }, updated: { next_step: 1 }, skipped: { next_step: 1 }, failed: { exit: "failed" } },
    }, {
      index: 1,
      type: "http_request",
      http_method: "POST",
      http_url: "https://example.test/webhook",
      on_outcome: { default: { exit: "completed" } },
    }, {
      index: 2,
      type: "conditional_split",
      condition: { combinator: "and", rules: [{ field: "payload.lead_type", op: "equals", value: "hot" }] },
      on_outcome: { yes: { exit: "completed" }, no: { exit: "completed" } },
    }, {
      index: 3,
      type: "find_lead",
      filters: [{ key: "email", value: "{{email}}" }],
      on_outcome: { found: { exit: "completed" }, not_found: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(!result.checks.some((check) => check.title === "webhook is not supported in webhook-triggered automations yet."));
  assert.ok(!result.checks.some((check) => check.title === "Condition Split is not supported in webhook-triggered automations yet."));
  assert.ok(result.checks.some((check) => check.title === "Find Lead is not supported in webhook-triggered automations yet."));
});

test("webhook-triggered HTTP requests block internal URLs", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "http_request",
      http_method: "POST",
      http_url: "http://127.0.0.1:54321/webhook",
      on_outcome: { default: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "HTTP request URL points to a blocked internal host."));
});

test("webhook-triggered automations allow payload If/Else before lead context", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "conditional_split",
      condition: { combinator: "and", rules: [{ field: "{{ $json.lead_type }}", op: "equals", value: "hot" }] },
      on_outcome: { yes: { next_step: 1 }, no: { exit: "completed" } },
    }, {
      index: 1,
      type: "create_lead_from_payload",
      field_mappings: [{ destination: "email", source: { source: "{{ $json.email }}" } }],
      on_outcome: { created: { exit: "completed" }, updated: { exit: "completed" }, skipped: { exit: "completed" }, failed: { exit: "failed" } },
    }],
    triggerNextStep: 0,
  });

  assert.notEqual(result.status, "invalid");
  assert.ok(!result.checks.some((check) => check.title === "Condition Split is not supported in webhook-triggered automations yet."));
  assert.ok(!result.checks.some((check) => check.message === "Add Create Lead or Find Lead before this step."));
});

test("conditional split supports named branch routing", () => {
  const result = validateJourneySpec({
    steps: [{
      index: 0,
      type: "conditional_split",
      branches: [
        { id: "branch_1", label: "Hot lead", condition: { combinator: "and", rules: [{ field: "payload.lead_type", op: "equals", value: "hot" }] } },
        { id: "branch_2", label: "Renewal", condition: { combinator: "and", rules: [{ field: "payload.intent", op: "equals", value: "renewal" }] } },
      ],
      on_outcome: {
        branch_1: { next_step: 1 },
        branch_2: { exit: "completed" },
        else: { exit: "completed" },
      },
    }, {
      index: 1,
      type: "exit_flow",
      on_outcome: {},
    }],
    triggerNextStep: 0,
  });

  assert.notEqual(result.status, "invalid");
  assert.equal(result.summary.error, 0);
});

test("conditional split validates duplicate branch ids and empty rules", () => {
  const result = validateJourneySpec({
    steps: [{
      index: 0,
      type: "conditional_split",
      branches: [
        { id: "branch_1", label: "Hot lead", condition: { combinator: "and", rules: [] } },
        { id: "branch_1", label: "Duplicate", condition: { combinator: "and", rules: [{ field: "payload.intent", op: "equals", value: "renewal" }] } },
      ],
      on_outcome: {
        branch_1: { exit: "completed" },
        else: { exit: "completed" },
      },
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Condition Split has duplicate branch ids."));
  assert.ok(result.checks.some((check) => check.title === "Hot lead has no rules."));
});

test("conditional split blocks stale branch outcome keys", () => {
  const result = validateJourneySpec({
    steps: [{
      index: 0,
      type: "conditional_split",
      branches: [
        { id: "branch_1", label: "Hot lead", condition: { combinator: "and", rules: [{ field: "payload.lead_type", op: "equals", value: "hot" }] } },
      ],
      on_outcome: {
        branch_1: { exit: "completed" },
        yes: { exit: "completed" },
        else: { exit: "completed" },
      },
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Yes is not emitted by this step."));
});

test("event workflows allow leadless A/B split routing", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "ab_split",
      split_percent_a: 40,
      on_outcome: { a: { next_step: 1 }, b: { exit: "completed" } },
    }, {
      index: 1,
      type: "exit_flow",
      on_outcome: {},
    }],
    triggerNextStep: 0,
  });

  assert.notEqual(result.status, "invalid");
  assert.equal(result.summary.error, 0);
});

test("lead journeys allow replied exit and goto goals", () => {
  const exitGoal = validateJourneySpec({
    steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "days" }, on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
    goals: [{ id: "goal_1", event: "replied", action: "exit" }],
  }, { suppressionSafetyKnown: true });

  const gotoGoal = validateJourneySpec({
    steps: [
      { index: 0, type: "wait", duration: { amount: 1, unit: "days" }, on_outcome: { default: { next_step: 1 } } },
      { index: 1, type: "ab_split", split_percent_a: 50, on_outcome: { a: { exit: "completed" }, b: { exit: "completed" } } },
    ],
    triggerNextStep: 0,
    goals: [{ id: "goal_1", event: "replied", action: "goto", goto_step: 1 }],
  }, { suppressionSafetyKnown: true });

  assert.notEqual(exitGoal.status, "invalid");
  assert.notEqual(gotoGoal.status, "invalid");
});

test("replied goals validate target, duplicates, and workflow mode", () => {
  const missingTarget = validateJourneySpec({
    steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "days" }, on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
    goals: [{ id: "goal_1", event: "replied", action: "goto", goto_step: 99 }],
  }, { suppressionSafetyKnown: true });

  const duplicate = validateJourneySpec({
    steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "days" }, on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
    goals: [
      { id: "goal_1", event: "replied", action: "exit" },
      { id: "goal_2", event: "replied", action: "goto", goto_step: 0 },
    ],
  }, { suppressionSafetyKnown: true });

  const eventWorkflow = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{ index: 0, type: "ab_split", split_percent_a: 50, on_outcome: { a: { exit: "completed" }, b: { exit: "completed" } } }],
    triggerNextStep: 0,
    goals: [{ id: "goal_1", event: "replied", action: "exit" }],
  });

  assert.equal(missingTarget.status, "invalid");
  assert.ok(missingTarget.checks.some((check) => check.title === "Replied goal target step is missing."));
  assert.equal(duplicate.status, "invalid");
  assert.ok(duplicate.checks.some((check) => check.title === "Journey has more than one replied goal."));
  assert.equal(eventWorkflow.status, "invalid");
  assert.ok(eventWorkflow.checks.some((check) => check.title === "Goals are only available for lead journeys."));
});

test("event workflow create lead with email mapping is ready", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "create_lead_from_payload",
      field_mappings: [
        { destination: "email", source: { source: "payload.email" } },
        { destination: "first_name", source: { source: "payload.first_name" } },
      ],
      on_outcome: { created: { next_step: 1 }, updated: { next_step: 1 }, skipped: { next_step: 1 }, failed: { exit: "failed" } },
    }, {
      index: 1,
      type: "exit_flow",
      on_outcome: {},
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.summary.error, 0);
});

test("event workflow find lead from payload is enabled before create lead", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "find_lead_from_payload",
      search: [
        { field: "email", source: { source: "payload.email" } },
      ],
      on_outcome: { found: { next_step: 1 }, not_found: { next_step: 2 } },
    }, {
      index: 1,
      type: "update_lead",
      fields: [{ key: "first_name", value: "payload.first_name" }],
      on_outcome: { default: { exit: "completed" } },
    }, {
      index: 2,
      type: "create_lead_from_payload",
      field_mappings: [{ destination: "email", source: { source: "payload.email" } }],
      on_outcome: { created: { exit: "completed" }, updated: { exit: "completed" }, skipped: { exit: "completed" }, failed: { exit: "failed" } },
    }],
    triggerNextStep: 0,
  });

  assert.notEqual(result.status, "invalid");
  assert.equal(result.summary.error, 0);
  assert.ok(!result.checks.some((check) => check.title === "Update Lead needs a lead first."));
  assert.ok(result.checks.some((check) => check.title === "Find Lead lead context is conditional."));
});

test("event workflow find lead requires an email or phone search", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "find_lead_from_payload",
      search: [{ field: "custom.source", source: { source: "payload.source" } }],
      on_outcome: { found: { exit: "completed" }, not_found: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  });

  assert.notEqual(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Find Lead has no email or phone search."));
});

test("event workflow blocks unsupported find lead search fields", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "find_lead_from_payload",
      search: [{ field: "tenant_id", source: { source: "payload.tenant_id" } }],
      on_outcome: { found: { exit: "completed" }, not_found: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Find Lead uses an unsupported search field."));
});

test("event workflow lead-required actions remain blocked before find lead", () => {
  const result = validateJourneySpec({
    mode: "event_workflow",
    trigger_type: "webhook",
    steps: [{
      index: 0,
      type: "email",
      template_key: "email_1",
      on_outcome: { sent: { next_step: 1 } },
    }, {
      index: 1,
      type: "find_lead_from_payload",
      search: [{ field: "email", source: { source: "payload.email" } }],
      on_outcome: { found: { exit: "completed" }, not_found: { exit: "completed" } },
    }],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "email_1", channel: "email" }],
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((check) => check.title === "Email needs a lead first."));
});

test("stop_on_reply accepts stop/continue and rejects unknown values", () => {
  const ok = validateJourneySpec({ stop_on_reply: "continue", steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }], triggerNextStep: 0 });
  assert.ok(!ok.checks.some((c) => c.title.includes("stop_on_reply")));
  const bad = validateJourneySpec({ stop_on_reply: "sometimes", steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }], triggerNextStep: 0 });
  assert.equal(bad.status, "invalid");
});

test("event-driven trigger types are accepted", () => {
  for (const triggerType of ["tag_added", "incoming_sms", "email_replied", "lead_created"]) {
    const result = validateJourneySpec({
      trigger_type: triggerType,
      steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }],
      triggerNextStep: 0,
    });
    assert.ok(!result.checks.some((check) => check.title === "Trigger is not available yet."), `${triggerType} should be accepted`);
  }
});

test("unknown trigger types are still blocked", () => {
  const result = validateJourneySpec({
    trigger_type: "missed_call",
    steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
  });
  assert.equal(result.status, "invalid");
});

// Regression: the new-journey seed once gave the SMS step a `default` outcome,
// which SMS never emits ("Continue"), so every brand-new journey was invalid on
// save. An SMS step wired on its real registry outcomes must NOT trip that error.
test("SMS step wired on its registry outcomes is not flagged 'not emitted'", () => {
  const result = validateJourneySpec({
    trigger_type: "lead_enrolled",
    steps: [
      {
        index: 0,
        type: "sms",
        template_key: "demo_sms_1",
        on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "opted_out" } },
      },
    ],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "demo_sms_1", channel: "sms", body: "hi" }],
    suppressionSafetyKnown: true,
  });

  assert.ok(!result.checks.some((c) => c.title.includes("is not emitted by this step.")),
    "valid SMS outcomes must not raise a 'not emitted' error");
});

test("SMS step with a legacy `default` outcome IS flagged 'not emitted'", () => {
  const result = validateJourneySpec({
    trigger_type: "lead_enrolled",
    steps: [
      { index: 0, type: "sms", template_key: "demo_sms_1", on_outcome: { default: { exit: "completed" } } },
    ],
    triggerNextStep: 0,
  }, {
    templates: [{ template_key: "demo_sms_1", channel: "sms", body: "hi" }],
    suppressionSafetyKnown: true,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((c) => c.title === "Continue is not emitted by this step."));
});

// Inline email composer: inline mode requires subject + body + a selected
// sender; template mode is unchanged.
const inlineEmailStep = (over = {}) => ({
  index: 0,
  type: "email",
  content_mode: "inline",
  inline_subject: "Hi {{first_name}}",
  inline_body: "Thanks for reaching out.",
  sender_id: "11111111-1111-1111-1111-111111111111",
  on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "completed" } },
  ...over,
});

test("inline email with subject + body + sender passes content checks", () => {
  const result = validateJourneySpec(
    { trigger_type: "lead_enrolled", triggerNextStep: 0, steps: [inlineEmailStep()] },
    { templates: [], suppressionSafetyKnown: true },
  );
  assert.ok(!result.checks.some((c) => c.title.includes("is missing a subject")));
  assert.ok(!result.checks.some((c) => c.title.includes("has no sender selected")));
  assert.ok(!result.checks.some((c) => c.title.includes("has no message content")));
});

test("inline email missing subject is invalid", () => {
  const result = validateJourneySpec(
    { trigger_type: "lead_enrolled", triggerNextStep: 0, steps: [inlineEmailStep({ inline_subject: "" })] },
    { templates: [], suppressionSafetyKnown: true },
  );
  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((c) => c.title === "Send Email is missing a subject."));
});

test("inline email missing sender is invalid", () => {
  const result = validateJourneySpec(
    { trigger_type: "lead_enrolled", triggerNextStep: 0, steps: [inlineEmailStep({ sender_id: undefined })] },
    { templates: [], suppressionSafetyKnown: true },
  );
  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((c) => c.title === "Send Email has no sender selected."));
});

test("inline email missing body is invalid", () => {
  const result = validateJourneySpec(
    { trigger_type: "lead_enrolled", triggerNextStep: 0, steps: [inlineEmailStep({ inline_body: "" })] },
    { templates: [], suppressionSafetyKnown: true },
  );
  assert.equal(result.status, "invalid");
  assert.ok(result.checks.some((c) => c.title === "Send Email has no message content."));
});

test("template email is unchanged: template_key satisfies content, no sender needed", () => {
  const step = {
    index: 0,
    type: "email",
    content_mode: "template",
    template_key: "welcome_email",
    on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "completed" } },
  };
  const result = validateJourneySpec(
    { trigger_type: "lead_enrolled", triggerNextStep: 0, steps: [step] },
    { templates: [{ template_key: "welcome_email", channel: "email" }], suppressionSafetyKnown: true },
  );
  assert.ok(!result.checks.some((c) => c.title.includes("has no message content")));
  assert.ok(!result.checks.some((c) => c.title.includes("has no sender selected")));
  assert.ok(!result.checks.some((c) => c.title.includes("is missing a subject")));
});

test("inline SMS needs only a body (no subject/sender requirement)", () => {
  const step = {
    index: 0,
    type: "sms",
    content_mode: "inline",
    inline_body: "Hey {{first_name}}",
    on_outcome: { sent: { exit: "completed" }, failed: { exit: "completed" }, opt_out: { exit: "completed" } },
  };
  const result = validateJourneySpec(
    { trigger_type: "lead_enrolled", triggerNextStep: 0, steps: [step] },
    { templates: [], suppressionSafetyKnown: true },
  );
  assert.ok(!result.checks.some((c) => c.title.includes("has no message content")));
  assert.ok(!result.checks.some((c) => c.title.includes("is missing a subject")));
  assert.ok(!result.checks.some((c) => c.title.includes("has no sender selected")));
});

test("http_request timeout outside 1-30s warns about runtime clamping", async () => {
  const { validateJourneySpec } = await import("../src/lib/journeyValidation.ts");
  const base = {
    triggerNextStep: 0,
    steps: [{ index: 0, type: "http_request", http_url: "https://example.com/x", on_outcome: {} }],
  };
  const ok = validateJourneySpec({ ...base, steps: [{ ...base.steps[0], http_timeout_ms: 15000 }] });
  assert.ok(!ok.checks.some((c) => c.title.includes("timeout")));
  const bad = validateJourneySpec({ ...base, steps: [{ ...base.steps[0], http_timeout_ms: 90000 }] });
  assert.ok(bad.checks.some((c) => c.level === "warning" && c.title.includes("timeout")));
});
