// Channel-aware merge-field vocabulary tests.
//
// Guards the exact token syntax each server resolver accepts (transcribed from
// the live DEV function bodies of render_template and resolve_workflow_expr):
//   • template channels → BARE lead tokens + BARE custom keys, no payload tokens.
//   • expr channels     → {{lead.<col>}} / {{custom.<key>}} / {{payload.<path>}}.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMergeFieldGroups,
  resolverForChannel,
  renderTemplatePreview,
} from "../src/lib/mergeFieldTokens.ts";

const CUSTOM = [
  { key: "policy_number", label: "Policy #" },
  { key: "deductible", label: "Deductible" },
];
const SAMPLES = [{ payload: { first_name: "Sam", nested: { plan: "gold" }, amount: 42 } }];

const tokensOf = (groups) => groups.flatMap((g) => g.tokens.map((t) => t.token));
const groupLabels = (groups) => groups.map((g) => g.label);

// ---- resolverForChannel ----

test("template channels map to the template resolver", () => {
  for (const ch of ["email", "sms", "call", "team_alert"]) {
    assert.equal(resolverForChannel(ch), "template", `${ch} should be template`);
  }
});

test("expression-resolved channels map to the expr resolver", () => {
  for (const ch of ["http_request", "conditional_split", "anything_else"]) {
    assert.equal(resolverForChannel(ch), "expr", `${ch} should be expr`);
  }
});

// ---- template channel vocabulary (render_template) ----

test("template channel emits only bare tokens render_template resolves", () => {
  const groups = buildMergeFieldGroups(CUSTOM, SAMPLES, "email");
  const tokens = tokensOf(groups);

  // Bare lead tokens, matching render_template's replace() list exactly.
  for (const t of [
    "{{first_name}}", "{{last_name}}", "{{email}}", "{{phone}}",
    "{{phone_e164}}", "{{phone_raw}}", "{{source}}", "{{campaign_type}}",
    "{{zip_code}}", "{{address}}", "{{lead_id}}",
  ]) {
    assert.ok(tokens.includes(t), `expected bare lead token ${t}`);
  }

  // Custom fields are bare {{<key>}}, NOT {{custom.<key>}}.
  assert.ok(tokens.includes("{{policy_number}}"));
  assert.ok(tokens.includes("{{deductible}}"));

  // No namespaced tokens and no webhook-payload group — render_template resolves neither.
  assert.ok(!tokens.some((t) => t.startsWith("{{lead.")), "no {{lead.*}} in template mode");
  assert.ok(!tokens.some((t) => t.startsWith("{{custom.")), "no {{custom.*}} in template mode");
  assert.ok(!tokens.some((t) => t.startsWith("{{payload.")), "no {{payload.*}} in template mode");
  assert.ok(!tokens.some((t) => t.startsWith("{{raw_payload.")), "no {{raw_payload.*}} anywhere");
  assert.ok(!groupLabels(groups).includes("Webhook payload"));
});

// ---- expr channel vocabulary (resolve_workflow_expr) ----

test("expr channel emits only namespaced tokens resolve_workflow_expr resolves", () => {
  const groups = buildMergeFieldGroups(CUSTOM, SAMPLES, "http_request");
  const tokens = tokensOf(groups);

  // Lead fields are {{lead.<real column>}} — note phone_e164/address_line1/id, not
  // the render_template aliases phone/address/lead_id (no such lead columns exist).
  for (const t of [
    "{{lead.first_name}}", "{{lead.last_name}}", "{{lead.email}}",
    "{{lead.phone_e164}}", "{{lead.phone_raw}}", "{{lead.source}}",
    "{{lead.campaign_type}}", "{{lead.zip_code}}", "{{lead.address_line1}}",
    "{{lead.id}}",
  ]) {
    assert.ok(tokens.includes(t), `expected ${t}`);
  }

  // Custom fields are {{custom.<key>}}.
  assert.ok(tokens.includes("{{custom.policy_number}}"));
  assert.ok(tokens.includes("{{custom.deductible}}"));

  // Webhook payload paths are {{payload.<path>}} (NOT raw_payload — that namespace
  // returns null from resolve_workflow_expr).
  assert.ok(tokens.includes("{{payload.first_name}}"));
  assert.ok(tokens.includes("{{payload.nested.plan}}"));
  assert.ok(!tokens.some((t) => t.startsWith("{{raw_payload.")), "no {{raw_payload.*}}");
  assert.ok(groupLabels(groups).includes("Webhook payload"));

  // No bare lead tokens or bare custom keys — resolve_workflow_expr returns bare tokens literally.
  assert.ok(!tokens.includes("{{first_name}}"), "no bare {{first_name}} in expr mode");
  assert.ok(!tokens.includes("{{policy_number}}"), "no bare custom key in expr mode");
});

test("expr channel de-duplicates the phone alias (no duplicate {{lead.phone_e164}})", () => {
  const tokens = tokensOf(buildMergeFieldGroups([], [], "http_request"));
  const dupes = tokens.filter((t) => t === "{{lead.phone_e164}}");
  assert.equal(dupes.length, 1, "phone + Phone (E.164) must collapse to a single token");
});

test("no custom-field group when the tenant has none", () => {
  assert.ok(!groupLabels(buildMergeFieldGroups([], SAMPLES, "email")).includes("Custom fields"));
  assert.ok(!groupLabels(buildMergeFieldGroups([], SAMPLES, "http_request")).includes("Custom fields"));
});

// ---- template preview parity ----

test("renderTemplatePreview resolves bare lead + bare custom tokens", () => {
  const out = renderTemplatePreview(
    "Hi {{first_name}}, policy {{policy_number}} phone {{phone}}",
    { first_name: "Dana", phone_e164: "+15551230000", custom_fields: { policy_number: "P-99" } },
  );
  assert.equal(out, "Hi Dana, policy P-99 phone +15551230000");
});

test("renderTemplatePreview does NOT resolve {{custom.*}} or {{payload.*}} (matches render_template)", () => {
  const out = renderTemplatePreview(
    "{{custom.policy_number}} {{raw_payload.first_name}} {{payload.x}}",
    { first_name: "Dana", custom_fields: { policy_number: "P-99" } },
  );
  // Left literal — the real send leaves these untouched too.
  assert.equal(out, "{{custom.policy_number}} {{raw_payload.first_name}} {{payload.x}}");
});

test("renderTemplatePreview only replaces exact tokens (no whitespace tolerance, matching Postgres replace)", () => {
  // render_template does replace(text, '{{first_name}}', …) — a spaced token is not matched.
  const out = renderTemplatePreview("{{ first_name }}", { first_name: "Dana" });
  assert.equal(out, "{{ first_name }}");
});

test("template channels expose Create Lead-mapped payload fields as Webhook data", () => {
  const mappings = [
    { destination: "email", source: { source: "payload.email" } },
    { destination: "custom.score", source: { source: "payload.meta.score" } },
    { destination: "custom.score", source: { source: "payload.meta.score" } }, // dup collapses
    { destination: "tags", source: { source: "payload.tags" } },               // not template-resolvable → skipped
  ];
  const groups = buildMergeFieldGroups([], [], "sms", mappings);
  const webhook = groups.find((g) => g.label === "Webhook data");
  assert.ok(webhook, "Webhook data group present");
  assert.deepEqual(webhook.tokens.map((t) => t.token), ["{{email}}", "{{score}}"]);
  assert.match(webhook.tokens[1].label, /meta\.score/);
});

test("expression channels do not add the mapped Webhook data group (raw payload group exists instead)", () => {
  const mappings = [{ destination: "email", source: { source: "payload.email" } }];
  const groups = buildMergeFieldGroups([], [{ payload: { email: "a@b.com" } }], "http_request", mappings);
  assert.ok(!groups.some((g) => g.label === "Webhook data"));
  assert.ok(groups.some((g) => g.label === "Webhook payload"));
});

test("no Webhook data group when nothing is mapped", () => {
  const groups = buildMergeFieldGroups([], [], "sms", []);
  assert.ok(!groups.some((g) => g.label === "Webhook data"));
});
