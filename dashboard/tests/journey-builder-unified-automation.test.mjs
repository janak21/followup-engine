import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The builder was split from a single page.jsx into a composition root plus
// ./components/* and ./lib/*. Read the whole builder as one unit so these
// content guards remain valid regardless of which file a given string now
// lives in.
const pagePath = fileURLToPath(new URL("../src/app/journeys/builder/page.jsx", import.meta.url));
const componentsDir = fileURLToPath(new URL("../src/app/journeys/builder/components/", import.meta.url));
const libDir = fileURLToPath(new URL("../src/app/journeys/builder/lib/", import.meta.url));
const builderSource = [
  readFileSync(pagePath, "utf8"),
  ...readdirSync(componentsDir)
    .filter((f) => f.endsWith(".jsx"))
    .map((f) => readFileSync(componentsDir + f, "utf8")),
  ...readdirSync(libDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(libDir + f, "utf8")),
].join("\n");

test("journey builder presents one automation model with a start trigger", () => {
  assert.match(builderSource, /Start Trigger/);
  assert.match(builderSource, /Lead is enrolled/);
  assert.match(builderSource, /Webhook received/);
  assert.match(builderSource, /Lead added\/imported/);
  assert.doesNotMatch(builderSource, /Workflow Mode/);
});

test("start trigger maps to backend runtime mode internally", () => {
  assert.match(builderSource, /setJourneyMode\(trigger === "webhook" \? "event_workflow" : "lead_journey"\)/);
  assert.match(builderSource, /mode: triggerType === "webhook" \? "event_workflow" : "lead_journey"/);
  assert.match(builderSource, /editSpec\.mode === "event_workflow" \? "event_workflow" : "lead_journey"/);
});

test("webhook trigger copy distinguishes inbound trigger from outbound webhook action", () => {
  assert.match(builderSource, /Start this automation when an external form, ad, or tool sends JSON data to this webhook\./);
  // The old payload-syntax intro paragraph was replaced by the guided
  // listen-for-data flow + inline field mapper; assert those instead.
  assert.match(builderSource, /Listen for data/);
  assert.match(builderSource, /Waiting for a request/);
  assert.match(builderSource, /DetectedPayloadFieldsMapper/);
  // Lead-context guidance now lives in the collapsible reference.
  assert.match(builderSource, /Other webhook automations can use payload values without creating a lead\./);
  assert.match(builderSource, /Send webhook \/ HTTP request/);
});

test("webhook action palette shows runnable and disabled actions with clear reasons", () => {
  assert.match(builderSource, /WEBHOOK_ACTION_PALETTE_ORDER/);
  assert.match(builderSource, /"find_lead_from_payload"/);
  assert.match(builderSource, /"create_lead_from_payload"/);
  assert.match(builderSource, /"exit_flow"/);
  assert.match(builderSource, /"email"/);
  assert.match(builderSource, /"sms"/);
  assert.match(builderSource, /"call"/);
  assert.match(builderSource, /"add_tag"/);
  assert.match(builderSource, /"remove_tag"/);
  assert.match(builderSource, /"update_lead"/);
  assert.match(builderSource, /Requires a lead\. Add Create Lead or Find Lead earlier in this automation\./);
  assert.match(builderSource, /Needs event-aware runtime before this can run in webhook-triggered automations\./);
  assert.match(builderSource, /Add Create Lead earlier in this automation so this action can run\./);
  assert.match(builderSource, /disabled=\{disabled\}/);
  assert.doesNotMatch(builderSource, /Coming soon for webhook-triggered automations\./);
  assert.doesNotMatch(builderSource, /runtime bridge before this can run/);
  assert.doesNotMatch(builderSource, /outbound webhooks are coming soon/);
  assert.doesNotMatch(builderSource, /WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS = new Set\(\[[^\]]*"add_tag"/s);
  assert.doesNotMatch(builderSource, /WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS = new Set\(\[[^\]]*"remove_tag"/s);
  assert.doesNotMatch(builderSource, /WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS = new Set\(\[[^\]]*"update_lead"/s);
  assert.doesNotMatch(builderSource, /WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS = new Set\(\[[^\]]*"find_lead"/s);
});

test("create lead action copy references webhook payload mappings", () => {
  assert.match(builderSource, /Create or match a lead using data from the webhook payload\./);
  assert.match(builderSource, /Choose which webhook values become lead fields\./);
  assert.match(builderSource, /payload\.email/);
  assert.match(builderSource, /payload\.data\.fields\[2\]\.value/);
  assert.match(builderSource, /Detected payload fields/);
  assert.match(builderSource, /Use webhook values as automation inputs/);
  assert.match(builderSource, /Apply to Create Lead/);
  assert.match(builderSource, /Copy/);
  assert.match(builderSource, /Variable/);
  assert.match(builderSource, /Save before re-run/);
  assert.match(builderSource, /Re-run uses the saved workflow, not unsaved draft changes/);
  assert.match(builderSource, /stepsRef\.current/);
  assert.match(builderSource, /mergeWorkflowFieldMapping/);
  assert.match(builderSource, /The webhook trigger does not require Create Lead/);
  // Mapped fields are advertised as insertable webhook data in message steps.
  assert.match(builderSource, /Insert field → Webhook data/);
  assert.match(builderSource, /Webhook/);
  assert.match(builderSource, /Facebook Lead Ad|static/i);
});

test("builder saves latest Create Lead mappings instead of a stale step snapshot", () => {
  assert.match(builderSource, /const getCurrentSteps = \(\) =>/);
  assert.match(builderSource, /Array\.isArray\(stepsRef\.current\) && stepsRef\.current\.length > 0/);
  assert.match(builderSource, /const replaceStepsState = \(nextSteps, dirty = true\) =>/);
  assert.match(builderSource, /const sourceSteps = getCurrentSteps\(\);/);
  assert.match(builderSource, /replaceStepsState\(updateStepList\(getCurrentSteps\(\)\)\)/);
  assert.match(builderSource, /const nextSteps = getCurrentSteps\(\)\.map\(step =>/);
  assert.doesNotMatch(builderSource, /stepsRef\.current \|\| steps/);
});

test("builder saves canvas edge edits through the same current step snapshot", () => {
  assert.match(builderSource, /const onConnect = \(connection\) =>/);
  assert.match(builderSource, /replaceStepsState\(getCurrentSteps\(\)\.map\(s => \{/);
  assert.match(builderSource, /on_outcome\[sourceHandle\] = \{ next_step: targetIdx, \.\.\.\(targetStepSid \? \{ next_sid: targetStepSid \} : \{\}\) \}/);
  assert.match(builderSource, /replaceStepsState\(\[\.\.\.currentSteps, newStep\]\)/);
});

test("builder preserves visual End connections that also carry runtime exit metadata", () => {
  assert.match(builderSource, /resolved\.isExitFlow \|\| outcome\.exit !== undefined/);
  assert.match(builderSource, /next_step: compiledIdx, \.\.\.\(targetSid \? \{ next_sid: targetSid \} : \{\}\), exit: outcome\.exit \|\| resolved\.exit \|\| "completed"/);
  assert.match(builderSource, /Exit_flow target: save BOTH so visual edge persists AND runtime exits\./);
});

test("sample replay refreshes the open modal with the replayed sample result", () => {
  assert.match(builderSource, /const nextSamples = json\.data\?\.samples \|\| \[\]/);
  assert.match(builderSource, /return nextSamples/);
  assert.match(builderSource, /const replayedSampleId = json\?\.data\?\.sample_id/);
  assert.match(builderSource, /setInspectedSample\(nextSample\)/);
});

test("builder persists pinned webhook sample and reusable workflow variables", () => {
  assert.match(builderSource, /const \[pinnedSampleId, setPinnedSampleId\] = useState\(null\)/);
  assert.match(builderSource, /const pinnedSample = samples\.find\(\(sample\) => sample\.id === pinnedSampleId\) \|\| samples\[0\] \|\| null/);
  assert.match(builderSource, /pinned_webhook_sample_id: pinnedSampleId \|\| null/);
  assert.match(builderSource, /workflow_variables: \(variables \|\| \[\]\)/);
  assert.match(builderSource, /setPinnedSampleId\(editSpec\.pinned_webhook_sample_id \|\| null\)/);
  assert.match(builderSource, /sample=\{pinnedSample\}/);
  assert.match(builderSource, /Pin sample/);
});

test("webhook If/Else can use pinned payload fields before a lead exists", () => {
  assert.match(builderSource, /payloadConditionOptions/);
  assert.match(builderSource, /flattenPayloadScalars\(pinnedSample\.payload\)/);
  assert.match(builderSource, /Webhook payload · \$\{row\.source\}/);
  assert.match(builderSource, /Webhook payload fields can be used before a lead exists\./);
  assert.match(builderSource, /WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS = new Set\(\[\]\)/);
  assert.doesNotMatch(builderSource, /WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS = new Set\(\[[^\]]*"conditional_split"/s);
});
