import {
  getJourneyNodeDisplay,
  getJourneyOutcomeDisplay,
  outcomesForStep,
  STEP_TYPES,
  templateChannelFor,
} from "./journeyStepTypes.js";

export type CheckLevel = "pass" | "warning" | "error" | "info";

export interface ValidationCheck {
  level: CheckLevel;
  title: string;
  message: string;
  stepId: number | null;
  stepLabel: string | null;
}

export interface ValidationResult {
  status: "invalid" | "warning" | "ready";
  checks: ValidationCheck[];
  summary: Record<CheckLevel, number>;
}

interface OutcomeRoute {
  next_step?: number;
  next_sid?: string;
  exit?: boolean;
}

export interface JourneyStep {
  index: number;
  type: string;
  sid?: string;
  label?: string | null;
  template_key?: string | null;
  content_mode?: string | null;
  inline_body?: string | null;
  inline_subject?: string | null;
  sender_id?: string | null;
  retell_agent_id?: string | null;
  mode?: string | null;
  until?: { datetime?: string | null } | null;
  duration?: { amount?: number | string | null } | null;
  delay?: { amount?: number | string | null; unit?: string | null } | null;
  http_method?: string | null;
  http_url?: string | null;
  http_timeout_ms?: number | string | null;
  search?: Array<{ field?: string | null }> | null;
  field_mappings?: Array<{ destination?: string | null }> | null;
  fields?: Array<{ key?: string | null; destination?: string | null; value?: unknown }> | null;
  update_field?: string | null;
  update_value?: unknown;
  branches?: Array<{ id?: string | null; label?: string | null; condition?: { rules?: unknown[] } | null }> | null;
  on_outcome?: Record<string, OutcomeRoute | undefined> | null;
  [key: string]: unknown;
}

export interface JourneySpec {
  steps?: JourneyStep[];
  triggerNextStep?: number | null;
  trigger_next_step?: number | null;
  trigger_type?: string | null;
  triggerType?: string | null;
  mode?: string | null;
  stop_on_reply?: string;
  goals?: Array<{ event?: string; action?: string; goto_step?: number | string } | null>;
  [key: string]: unknown;
}

export interface ValidationContext {
  templates?: Array<{ template_key?: string | null; channel?: string | null }>;
  retellAgents?: Array<{ agent_id?: string | null }>;
  suppressionSafetyKnown?: boolean;
  [key: string]: unknown;
}

const TEMPLATE_STEP_TYPES = new Set(["email", "sms", "team_alert"]);
const INLINE_CONTENT_STEP_TYPES = new Set(["email", "sms"]);
const SUPPORTED_TRIGGER_TYPES = new Set(["lead_enrolled", "webhook", "tag_added", "incoming_sms", "email_replied", "lead_created"]);
const SUPPORTED_HTTP_METHODS = new Set(["GET", "POST", "DELETE"]);
const EVENT_WORKFLOW_STEP_TYPES = new Set([
  "find_lead_from_payload",
  "create_lead_from_payload",
  "conditional_split",
  "ab_split",
  "wait",
  "http_request",
  "exit_flow",
  "sms",
  "email",
  "call",
  "wait_reply",
  "add_tag",
  "remove_tag",
  "update_lead",
  "team_alert",
]);
const EVENT_WORKFLOW_LEAD_ESTABLISHING_STEP_TYPES = new Set([
  "find_lead_from_payload",
  "create_lead_from_payload",
]);
const EVENT_WORKFLOW_LEAD_REQUIRED_STEP_TYPES = new Set(["sms", "email", "call", "wait_reply", "add_tag", "remove_tag", "update_lead"]);
const CREATE_LEAD_REQUIRED_DESTINATIONS = new Set(["email", "phone"]);
const CREATE_LEAD_PROTECTED_DESTINATIONS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "journey_status",
  "current_step",
  "assigned_sender_id",
  "email_thread_id",
  "last_email_message_id",
  "opt_out",
  "responded",
  "callback_requested",
]);
const UPDATE_LEAD_PROTECTED_DESTINATIONS = new Set([
  ...CREATE_LEAD_PROTECTED_DESTINATIONS,
  "opt_out_channel",
  "callback_at",
  "source_batch_id",
  "sms_conversation_count",
  "email_conversation_count",
  "last_action_at",
  "next_action_at",
  "raw_payload",
  "run_id",
  "retry_count",
  "max_retries",
  "next_retry_at",
  "locked_until",
  "locked_by",
  "status",
  "result",
  "payload",
  "failed_at",
  "completed_at",
  "attempt_number",
  "provider",
  "provider_id",
  "idempotency_key",
  "error_message",
  "last_error",
  "tags",
  "custom.tags",
]);

export function validateJourneySpec(spec: JourneySpec = {}, context: ValidationContext = {}): ValidationResult {
  const steps = Array.isArray(spec.steps) ? spec.steps : [];
  const triggerNextStep = spec.triggerNextStep ?? spec.trigger_next_step ?? null;
  const triggerType = spec.trigger_type || spec.triggerType || "lead_enrolled";
  const mode = spec.mode || "lead_journey";
  const checks: ValidationCheck[] = [];

  if (!SUPPORTED_TRIGGER_TYPES.has(triggerType)) {
    add(checks, "error", "Trigger is not available yet.", "Use manual/bulk enrollment or an inbound webhook for active journeys.");
  }

  // PHASE6: per-journey stop-on-reply policy. 'stop' (default) = current
  // behavior; 'continue' = this journey keeps sending after a reply. Unknown
  // values block save so operators don't typo into a silent no-op.
  if (spec.stop_on_reply !== undefined && !["stop", "continue"].includes(spec.stop_on_reply)) {
    add(checks, "error", "stop_on_reply must be 'stop' or 'continue'.", "Use 'stop' (default) to halt this journey on a reply, or 'continue' to keep sending.");
  }

  if (steps.length === 0) {
    add(checks, "error", "Journey has no steps.", mode === "event_workflow" ? "Add Create Lead before using this event workflow." : "Add at least one step before using this journey with leads.");
  }

  if (triggerNextStep === null || triggerNextStep === undefined) {
    add(checks, "error", "Journey has no starting step.", "Connect the start trigger to the first step.");
  } else if (!steps.some((step) => step.index === triggerNextStep)) {
    add(checks, "error", "Starting step is missing.", "The start trigger points to a step that is not on the canvas.");
  } else {
    add(checks, "pass", "Start trigger is connected.", "Leads have a clear first step.");
  }

  if (mode === "event_workflow") {
    validateEventWorkflow(steps, triggerType, checks);
  }

  validateGoals(spec, steps, mode, checks);
  validateStepConfiguration(steps, context, checks);
  validateBranches(steps, checks);
  if (mode !== "event_workflow") {
    validateSafety(context, checks);
  }

  const summary = checks.reduce<Record<CheckLevel, number>>((acc, check) => {
    acc[check.level] = (acc[check.level] || 0) + 1;
    return acc;
  }, { pass: 0, warning: 0, error: 0, info: 0 });

  return {
    status: summary.error > 0 ? "invalid" : summary.warning > 0 ? "warning" : "ready",
    checks,
    summary,
  };
}

function validateGoals(spec: JourneySpec, steps: JourneyStep[], mode: string, checks: ValidationCheck[]) {
  const goals = Array.isArray(spec.goals) ? spec.goals : [];
  if (goals.length === 0) return;

  if (mode === "event_workflow") {
    add(checks, "error", "Goals are only available for lead journeys.", "Remove replied goals from webhook-triggered automations.");
  }

  const repliedGoals = goals.filter((goal) => goal?.event === "replied");
  if (repliedGoals.length > 1) {
    add(checks, "error", "Journey has more than one replied goal.", "Keep a single replied goal for this phase.");
  }

  const stepIndexes = new Set(steps.map((step) => step.index));
  for (const goal of repliedGoals) {
    const action = goal?.action || "exit";
    if (!["exit", "goto"].includes(action)) {
      add(checks, "error", "Replied goal action is not supported.", "Use End journey or Go to step.");
      continue;
    }

    if (action === "goto") {
      const gotoStep = Number(goal?.goto_step);
      if (!Number.isInteger(gotoStep) || !stepIndexes.has(gotoStep)) {
        add(checks, "error", "Replied goal target step is missing.", "Choose an existing step for the replied goal.");
      }
    }
  }
}

function validateEventWorkflow(steps: JourneyStep[], triggerType: string, checks: ValidationCheck[]) {
  if (triggerType !== "webhook") {
    add(checks, "error", "Webhook-triggered automations must start from a webhook.", "Set the trigger to Webhook received before publishing this automation.");
  }

  const leadEstablishingSteps = steps.filter((step) =>
    EVENT_WORKFLOW_LEAD_ESTABLISHING_STEP_TYPES.has(step.type)
  );
  const hasLeadRequiredSteps = steps.some((step) =>
    EVENT_WORKFLOW_LEAD_REQUIRED_STEP_TYPES.has(step.type)
  );
  if (leadEstablishingSteps.length === 0 && hasLeadRequiredSteps) {
    add(checks, "error", "Webhook-triggered automation needs a Create Lead or Find Lead step.", "Add Create Lead or Find Lead before using lead-required actions.");
  }

  for (const step of steps) {
    const display = getJourneyNodeDisplay(step.type);
    const stepLabel = step.label || display.label;
    if (!EVENT_WORKFLOW_STEP_TYPES.has(step.type)) {
      const eventLabel = display.label.replace(/^Send\s+/i, "");
      add(checks, "error", `${eventLabel} is not supported in webhook-triggered automations yet.`, "Use an action supported by the event workflow runtime.", step.index, stepLabel);
      continue;
    }

    if (EVENT_WORKFLOW_LEAD_REQUIRED_STEP_TYPES.has(step.type) && !hasWebhookLeadContextBefore(steps, step.index)) {
      const eventLabel = display.label.replace(/^Send\s+/i, "");
      add(checks, "error", `${eventLabel} needs a lead first.`, "Add Create Lead or Find Lead before this step.", step.index, stepLabel);
    }

    if (step.type === "create_lead_from_payload") {
      validateEventCreateLeadStep(step, checks, stepLabel);
    }

    if (step.type === "find_lead_from_payload") {
      validateEventFindLeadStep(step, checks, stepLabel);
      if (hasLeadRequiredStepAfter(steps, step.index)) {
        add(checks, "warning", "Find Lead lead context is conditional.", "Lead-required steps after Find Lead should be connected to the Found outcome branch.", step.index, stepLabel);
      }
    }

    if (step.type === "http_request") {
      validateEventHttpRequestStep(step, checks, stepLabel);
    }
  }
}

function hasWebhookLeadContextBefore(steps: JourneyStep[], stepIndex: number): boolean {
  return steps.some((candidate) =>
    candidate.index < stepIndex && EVENT_WORKFLOW_LEAD_ESTABLISHING_STEP_TYPES.has(candidate.type)
  );
}

function hasLeadRequiredStepAfter(steps: JourneyStep[], stepIndex: number): boolean {
  return steps.some((candidate) =>
    candidate.index > stepIndex && EVENT_WORKFLOW_LEAD_REQUIRED_STEP_TYPES.has(candidate.type)
  );
}

function validateEventFindLeadStep(step: JourneyStep, checks: ValidationCheck[], stepLabel: string) {
  const search = Array.isArray(step.search) ? step.search : [];
  const supportedFields = new Set(["email", "phone", "phone_raw", "phone_e164"]);
  const identityFields = new Set(["email", "phone", "phone_raw", "phone_e164"]);
  let hasIdentitySearch = false;
  let hasUnsupportedField = false;

  for (const entry of search) {
    const field = String(entry?.field || "").trim().toLowerCase();
    if (!field) {
      add(checks, "warning", "Find Lead has a search entry with no field.", "Choose the field to match against.", step.index, stepLabel);
      continue;
    }
    if (field.startsWith("custom.")) {
      // Custom-field searches are allowed but optional; runtime checks for value.
      continue;
    }
    if (!supportedFields.has(field)) {
      hasUnsupportedField = true;
      continue;
    }
    if (identityFields.has(field)) {
      hasIdentitySearch = true;
    }
  }

  if (hasUnsupportedField) {
    add(checks, "error", "Find Lead uses an unsupported search field.", "Use email, phone, phone_raw, phone_e164, or custom.<key>.", step.index, stepLabel);
  }

  if (search.length > 0 && !hasIdentitySearch) {
    add(checks, "warning", "Find Lead has no email or phone search.", "Add an email or phone search for reliable matching.", step.index, stepLabel);
  }
}

function validateEventCreateLeadStep(step: JourneyStep, checks: ValidationCheck[], stepLabel: string) {
  const mappings = Array.isArray(step.field_mappings) ? step.field_mappings : [];
  const destinations = mappings
    .map((mapping) => String(mapping?.destination || "").trim())
    .filter(Boolean);

  const hasEmailOrPhone = destinations.some((destination) =>
    CREATE_LEAD_REQUIRED_DESTINATIONS.has(destination.toLowerCase())
  );
  if (!hasEmailOrPhone) {
    add(checks, "error", "Create Lead must map email or phone.", "Map at least one identity field from the webhook payload.", step.index, stepLabel);
  }

  const protectedDestinations = destinations.filter((destination) =>
    CREATE_LEAD_PROTECTED_DESTINATIONS.has(destination.toLowerCase())
  );
  if (protectedDestinations.length > 0) {
    add(checks, "error", "Create Lead maps a protected field.", "Remove protected/system destinations such as tenant_id, id, created_at, or journey status fields.", step.index, stepLabel);
  }
}

function validateEventHttpRequestStep(step: JourneyStep, checks: ValidationCheck[], stepLabel: string) {
  const rawUrl = String(step.http_url || "").trim();
  if (!rawUrl) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    add(checks, "error", "HTTP request URL is invalid.", "Use a full public URL such as https://example.com/webhook.", step.index, stepLabel);
    return;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    add(checks, "error", "HTTP request URL scheme is not supported.", "Use http or https for outbound webhook requests.", step.index, stepLabel);
  }

  const host = url.hostname.toLowerCase();
  const privateIp =
    /^(0|10|127)\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(host) ||
    /^198\.(18|19)\./.test(host);

  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "metadata.google.internal" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":") ||
    privateIp
  ) {
    add(checks, "error", "HTTP request URL points to a blocked internal host.", "Use a public endpoint. Localhost, private IPs, and internal hosts are blocked.", step.index, stepLabel);
  }

  if (url.username || url.password) {
    add(checks, "error", "HTTP request URL cannot include credentials.", "Put credentials in headers instead of embedding them in the URL.", step.index, stepLabel);
  }
}

function validateStepConfiguration(steps: JourneyStep[], context: ValidationContext, checks: ValidationCheck[]) {
  const templates = Array.isArray(context.templates) ? context.templates : [];
  const retellAgents = Array.isArray(context.retellAgents) ? context.retellAgents : [];

  for (const step of steps) {
    const display = getJourneyNodeDisplay(step.type);
    const stepLabel = step.label || display.label;
    const stepId = step.index;

    if (TEMPLATE_STEP_TYPES.has(step.type)) {
      const channel = templateChannelFor(step.type);
      const supportsInline = INLINE_CONTENT_STEP_TYPES.has(step.type);
      // Inline mode when the step explicitly selected it, or (legacy) when it
      // has inline content and no template — matches the builder + RPC.
      const isInline = supportsInline &&
        (step.content_mode === "inline" ||
          (!step.template_key && String(step.inline_body || "").trim().length > 0));

      if (isInline) {
        if (String(step.inline_body || "").trim().length === 0) {
          add(checks, "error", `${stepLabel} has no message content.`, "Write the message body, or switch to a template.", stepId, stepLabel);
        }
        if (step.type === "email") {
          if (String(step.inline_subject || "").trim().length === 0) {
            add(checks, "error", `${stepLabel} is missing a subject.`, "Add an email subject in the inline composer.", stepId, stepLabel);
          }
          if (!step.sender_id) {
            add(checks, "error", `${stepLabel} has no sender selected.`, "Pick a connected sender in the inline composer's From field.", stepId, stepLabel);
          }
        }
      } else {
        const matchingTemplate = step.template_key
          ? templates.some((template) => template.template_key === step.template_key && (!channel || template.channel === channel))
          : false;

        if (!step.template_key) {
          add(checks, "error", `${stepLabel} has no message content.`, "Choose a template or write the message in the step.", stepId, stepLabel);
        } else if (templates.length > 0 && !matchingTemplate) {
          add(checks, "warning", `${stepLabel} uses a template that was not found.`, "Confirm the selected template still exists.", stepId, stepLabel);
        }
      }
    }

    if (step.type === "call") {
      const selectedAgentExists = step.retell_agent_id
        ? retellAgents.some((agent) => agent.agent_id === step.retell_agent_id)
        : true;
      if (step.retell_agent_id && retellAgents.length > 0 && !selectedAgentExists) {
        add(checks, "warning", "Call lead uses a voice agent that was not found.", "Choose an active voice agent or use the tenant default.", stepId, stepLabel);
      } else if (!step.retell_agent_id && retellAgents.length === 0) {
        add(checks, "info", "Voice agent setup was not verified.", "Calls may rely on tenant-level voice configuration.", stepId, stepLabel);
      }
    }

    if (step.type === "wait") {
      const hasUntil = step.mode === "until" && !!step.until?.datetime;
      const amount = Number(step.duration?.amount ?? step.delay?.amount);
      if (!hasUntil && (!Number.isFinite(amount) || amount <= 0)) {
        add(checks, "warning", "Wait step has no duration.", "Set how long the journey should wait before continuing.", stepId, stepLabel);
      }
    }

    if (step.type === "wait_reply") {
      const amount = Number(step.delay?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        add(checks, "warning", "Wait for reply has no timeout.", "Set how long to wait before using the timeout branch.", stepId, stepLabel);
      }
    }

    if (step.type === "http_request") {
      const method = String(step.http_method || "POST").toUpperCase();
      if (!SUPPORTED_HTTP_METHODS.has(method)) {
        add(checks, "error", `${method} webhook method is not supported.`, "Use GET, POST, or DELETE. Existing PUT/PATCH journeys should be reviewed before activation.", stepId, stepLabel);
      }
      if (!String(step.http_url || "").trim()) {
        add(checks, "error", "Webhook step is missing a URL.", "Add the endpoint URL this webhook should call.", stepId, stepLabel);
      }
      if (step.http_timeout_ms !== undefined) {
        const timeout = Number(step.http_timeout_ms);
        if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 30000) {
          add(checks, "warning", "Webhook timeout is outside 1\u201330 seconds.", "The runtime clamps the timeout to between 1 and 30 seconds.", stepId, stepLabel);
        }
      }
    }

    if (step.type === "create_lead") {
      add(checks, "warning", "Create/update lead updates the current lead.", "This step does not create a separate lead record; review the field mappings before activation.", stepId, stepLabel);
    }

    if (step.type === "update_lead") {
      validateUpdateLeadStep(step, checks, stepLabel);
    }

    if (step.type === "email" || step.type === "sms") {
      const emittedOutcomes = new Set(outcomesForStep(step).map((outcome: { id: string }) => outcome.id));
      for (const outcomeKey of Object.keys(step.on_outcome || {})) {
        if (!emittedOutcomes.has(outcomeKey)) {
          const outcomeDisplay = getJourneyOutcomeDisplay(step, outcomeKey);
          add(checks, "error", `${outcomeDisplay.label} is not emitted by this step.`, "Use the Sent branch, then add a Wait for reply step if you need reply/no-reply branching.", stepId, stepLabel);
        }
      }
    }

    if (step.type === "conditional_split") {
      validateConditionalSplitStep(step, checks, stepLabel);
    }
  }
}

function validateConditionalSplitStep(step: JourneyStep, checks: ValidationCheck[], stepLabel: string) {
  const branches = Array.isArray(step.branches) ? step.branches : [];
  if (branches.length === 0) return;

  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const branch of branches) {
    const id = String(branch?.id || "").trim();
    if (!id) continue;
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);

    const rules = Array.isArray(branch?.condition?.rules) ? branch.condition.rules : [];
    if (rules.length === 0) {
      add(checks, "warning", `${branch?.label || id || "Branch"} has no rules.`, "Add at least one rule or remove this branch.", step.index, stepLabel);
    }
  }

  if (duplicateIds.size > 0) {
    add(checks, "error", "Condition Split has duplicate branch ids.", "Each branch needs a unique route id so the runtime can choose the correct output.", step.index, stepLabel);
  }

  const emittedOutcomes = new Set(outcomesForStep(step).map((outcome: { id: string }) => outcome.id));
  for (const outcomeKey of Object.keys(step.on_outcome || {})) {
    if (!emittedOutcomes.has(outcomeKey)) {
      const outcomeDisplay = getJourneyOutcomeDisplay(step, outcomeKey);
      add(checks, "error", `${outcomeDisplay.label} is not emitted by this step.`, "Reconnect this route to one of the named branches or Else.", step.index, stepLabel);
    }
  }
}

function validateUpdateLeadStep(step: JourneyStep, checks: ValidationCheck[], stepLabel: string) {
  const fields = Array.isArray(step.fields) ? [...step.fields] : [];
  if (fields.length === 0 && step.update_field) {
    fields.push({ key: step.update_field, value: step.update_value });
  }

  const protectedFields = fields
    .map((field) => String(field?.key || field?.destination || "").trim().toLowerCase())
    .filter((key) => UPDATE_LEAD_PROTECTED_DESTINATIONS.has(key));

  if (protectedFields.length > 0) {
    add(checks, "error", "Update Lead maps a protected field.", "Remove protected/system fields such as opt_out, responded, callback_requested, journey_status, or tags.", step.index, stepLabel);
  }
}

function validateBranches(steps: JourneyStep[], checks: ValidationCheck[]) {
  const stepByIndex = new Map(steps.map((step) => [step.index, step]));

  for (const step of steps) {
    const outcomes = outcomesForStep(step);
    if (step.type === "exit_flow" || outcomes.length === 0) continue;

    const routes = step.on_outcome || {};
    const routedOutcomes = outcomes.map((outcome: { id: string }) => ({ outcome, route: routes[outcome.id] }));
    const allEndImmediately = routedOutcomes.length > 0 && routedOutcomes.every(({ route }: { route?: OutcomeRoute }) => route?.exit && route.next_step === undefined);

    for (const { outcome, route } of routedOutcomes) {
      const outcomeDisplay = getJourneyOutcomeDisplay(step, outcome.id);
      const stepLabel = step.label || getJourneyNodeDisplay(step.type).label;
      if (!route || (route.next_step === undefined && !route.exit)) {
        add(checks, "warning", `${outcomeDisplay.label} branch has no next step.`, "Connect this outcome to another step or end the journey.", step.index, stepLabel);
        continue;
      }
      if (route.next_step !== undefined && !stepByIndex.has(route.next_step)) {
        add(checks, "error", `${outcomeDisplay.label} branch points to a missing step.`, "Reconnect this branch to a visible step.", step.index, stepLabel);
      }
    }

    if (allEndImmediately) {
      const stepLabel = step.label || getJourneyNodeDisplay(step.type).label;
      add(checks, "warning", "All outcomes end the journey immediately.", `${stepLabel} has no continuing branch. Review this before using it with leads.`, step.index, stepLabel);
    }
  }
}

function validateSafety(context: ValidationContext, checks: ValidationCheck[]) {
  if (context.suppressionSafetyKnown === true) {
    add(checks, "pass", "Suppression list will be respected.", "The engine checks contactability before sending follow-ups.");
  } else {
    add(checks, "info", "Suppression safety was not verified here.", "Review engine settings if you need confirmation before activating.");
  }
}

function add(checks: ValidationCheck[], level: CheckLevel, title: string, message: string, stepId: number | null = null, stepLabel: string | null = null) {
  checks.push({ level, title, message, stepId, stepLabel });
}
