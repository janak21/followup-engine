// Single source of truth for journey step types.
// Adding a new step type? Add an entry below — no JSX changes needed in the builder.
//
// Each entry describes:
//   label           : display name in the palette + node title
//   icon            : lucide-react icon name (resolved via the ICON_REGISTRY in the builder)
//   borderClass     : tailwind border classes for the node card
//   iconClass       : tailwind background/text classes for the node icon
//   paletteClass    : tailwind classes for the "Add Step" palette button
//   outcomes        : ordered list of { id, label, color, hint }. Drives the output handles,
//                     the outcome legend in the side panel, and the default on_outcome map.
//                     Empty array means the step has no outputs (e.g. exit_flow).
//   defaultDelay    : { amount, unit } applied to new steps of this type
//   supportsTemplate: true => the side panel shows the standard template selector for this
//                     step (channel filter = step type, with team_alert as the exception)
//   templateChannel : if set, overrides which channel the template selector filters on
//   bodyHint        : short label rendered in the node body (e.g. "template: w1a_call_1")
//                     — if omitted the renderer falls back to step.type-specific defaults.
//   defaultsExtra   : any extra fields to merge into a newly-added step
//
// Engine note: the `id` of every outcome must match an outcome string that the engine's
// advance_journey RPC will receive (e.g. 'answered', 'sent', 'replied'). Adding a new
// outcome here without the engine emitting it = a handle that never fires.

export const STEP_TYPES = {
  call: {
    label: "Call lead",
    icon: "PhoneCall",
    borderClass: "border-blue-500/10 dark:border-blue-500/20",
    iconClass: "bg-blue-500/10 text-blue-500",
    paletteClass: "bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/20",
    supportsTemplate: true,
    defaultDelay: { amount: 0, unit: "minutes" },
    outcomes: [
      { id: "answered",       label: "Call answered", color: "#10b981", hint: "Lead picked up and talked",       exitOnDefault: "completed" },
      { id: "no_answer",      label: "No answer", color: "#ef4444", hint: "Phone rang out, no pickup" },
      { id: "voicemail",      label: "Voicemail", color: "#f59e0b", hint: "Call went to voicemail" },
      { id: "busy",           label: "Busy",      color: "#f97316", hint: "Line busy" },
      { id: "failed",         label: "Failed",    color: "#dc2626", hint: "Carrier error / network failure" },
      { id: "invalid_number", label: "Invalid number", color: "#94a3b8", hint: "Number not in service" },
      { id: "wrong_number",   label: "Wrong number",   color: "#94a3b8", hint: "Answered but wrong person" },
    ],
  },
  sms: {
    label: "Send SMS",
    icon: "MessageSquare",
    borderClass: "border-emerald-500/10 dark:border-emerald-500/20",
    iconClass: "bg-emerald-500/10 text-emerald-500",
    paletteClass: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20",
    supportsTemplate: true,
    defaultDelay: { amount: 0, unit: "minutes" },
    helperText: "Sent = Twilio accepted. Permanent send failures route Failed / Opted out. To branch on replies, add a Wait for reply step.",
    outcomes: [
      // Only outcomes the runtime can fire as this action's FIRST advance
      // belong here (advance_journey no-ops after the first outcome):
      //   sent    — record_send_event after Twilio accepts the API request
      //   failed  — dispatch-twilio-sms v3 permanent-error classification
      //             (invalid/unreachable number, carrier block, unknown 4xx)
      //   opt_out — dispatch-twilio-sms v3 when Twilio reports the lead
      //             unsubscribed (21610 / STOP keyword)
      // Delivery confirmations and replies arrive after 'sent' has already
      // advanced this action, so they are deliberately NOT handles: replies
      // branch via a Wait for reply step; delivery status lands on events.
      { id: "sent",    label: "Sent successfully", color: "#10b981", hint: "Twilio accepted the API request and assigned a SID" },
      { id: "failed",  label: "Failed",            color: "#dc2626", hint: "Permanent Twilio error: invalid number, carrier block, landline", exitOnDefault: "completed" },
      { id: "opt_out", label: "Opted out",         color: "#f59e0b", hint: "Twilio reports the lead unsubscribed (STOP)", exitOnDefault: "opted_out" },
    ],
  },
  email: {
    label: "Send Email",
    icon: "Mail",
    borderClass: "border-purple-500/10 dark:border-purple-500/20",
    iconClass: "bg-purple-500/10 text-purple-500",
    paletteClass: "bg-purple-500/10 text-purple-600 border-purple-500/20 hover:bg-purple-500/20",
    supportsTemplate: true,
    defaultDelay: { amount: 0, unit: "minutes" },
    helperText: "Sent = Gmail accepted. Send-time deliverability failures route Bounced. To branch on replies, add a Wait for reply step.",
    outcomes: [
      // Only outcomes the runtime can fire as this action's FIRST advance
      // belong here (advance_journey no-ops after the first outcome):
      //   sent    — record_send_event after Gmail accepts the send
      //   bounced — dispatch-gmail-email v8 permanent-error classification
      //             (invalid recipient, content rejected, unknown 4xx)
      // Mailer-daemon bounces, replies, and opt-outs from the inbox poller
      // arrive after 'sent' already advanced this action — replies branch
      // via a Wait for reply step; late bounces run the opt-out/suppression
      // pipeline directly.
      { id: "sent",    label: "Sent successfully", color: "#10b981", hint: "Gmail accepted the send request" },
      { id: "bounced", label: "Bounced",           color: "#dc2626", hint: "Send-time deliverability failure — bad address or content rejected", exitOnDefault: "completed" },
    ],
  },
  team_alert: {
    label: "Notify team",
    icon: "AlertTriangle",
    borderClass: "border-rose-500/10 dark:border-rose-500/20",
    iconClass: "bg-rose-500/10 text-rose-500",
    paletteClass: "bg-rose-500/10 text-rose-500 border-rose-500/20 hover:bg-rose-500/20",
    supportsTemplate: true,
    templateChannel: "team_alert",
    defaultDelay: { amount: 0, unit: "minutes" },
    outcomes: [
      { id: "sent", label: "Team notified", color: "#10b981", hint: "Alert email dispatched to your team" },
    ],
  },
  wait: {
    label: "Wait",
    icon: "Clock",
    borderClass: "border-amber-500/10 dark:border-amber-500/20",
    iconClass: "bg-amber-500/10 text-amber-500",
    paletteClass: "bg-amber-500/10 text-amber-500 border-amber-500/20 hover:bg-amber-500/20",
    supportsTemplate: false,
    // Backwards-compatible legacy fields kept on the step:
    //   delay: { amount, unit }            ← used for mode=duration
    //
    // New GHL-style fields (all optional, persisted on the step):
    //   action_name:  string               ← label rendered on canvas
    //   mode:         "duration" | "until"
    //   duration:     { amount, unit }     ← mode=duration (unit: seconds|minutes|hours|days)
    //   until:        { datetime: ISO, timezone: IANA }
    //   on_passed:    "continue" | "exit" | "goto" | "skip_outbound"
    //   on_passed_step: number             ← when on_passed=goto
    //   advance_window: {
    //     enabled: bool,
    //     days:    ["Sun"|"Mon"|...],
    //     window:  { start: "HH:MM", end: "HH:MM" },
    //     additional_filter: { type, op, value } | null
    //   }
    defaultDelay: { amount: 1, unit: "hours" },
    outcomes: [
      { id: "default", label: "Continue", color: "#6366f1", hint: "Continue after the wait" },
    ],
  },
  wait_reply: {
    label: "Wait for reply",
    icon: "MessageSquare",
    borderClass: "border-amber-500/10 dark:border-amber-500/20",
    iconClass: "bg-amber-500/10 text-amber-500",
    paletteClass: "bg-amber-500/10 text-amber-500 border-amber-500/20 hover:bg-amber-500/20",
    supportsTemplate: false,
    defaultDelay: { amount: 12, unit: "hours" },
    outcomes: [
      { id: "replied", label: "Lead replied", color: "#10b981", hint: "Lead responded before timeout" },
      { id: "timeout", label: "Timeout", color: "#f59e0b", hint: "Wait expired with no reply" },
    ],
  },
  conditional_split: {
    label: "Condition Split",
    icon: "GitMerge",
    borderClass: "border-cyan-500/10 dark:border-cyan-500/20",
    iconClass: "bg-cyan-500/10 text-cyan-500",
    paletteClass: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20 hover:bg-cyan-500/20",
    supportsTemplate: false,
    customSidePanel: "conditional_split",
    defaultDelay: { amount: 0, unit: "minutes" },
    outcomes: [
      { id: "yes", label: "Yes", color: "#10b981", hint: "Condition matched" },
      { id: "no",  label: "No",  color: "#ef4444", hint: "Condition did not match" },
    ],
  },
  ab_split: {
    label: "A/B Split",
    icon: "GitMerge",
    borderClass: "border-fuchsia-500/10 dark:border-fuchsia-500/20",
    iconClass: "bg-fuchsia-500/10 text-fuchsia-500",
    paletteClass: "bg-fuchsia-500/10 text-fuchsia-500 border-fuchsia-500/20 hover:bg-fuchsia-500/20",
    supportsTemplate: false,
    customSidePanel: "ab_split",
    defaultDelay: { amount: 0, unit: "minutes" },
    defaultsExtra: { split_percent_a: 50, action_name: "A/B split" },
    outcomes: [
      { id: "a", label: "Variant A", color: "#d946ef", hint: "split_percent_a % of leads" },
      { id: "b", label: "Variant B", color: "#8b5cf6", hint: "Remainder" },
    ],
  },
  http_request: {
    label: "Send webhook",
    icon: "Code",
    borderClass: "border-orange-500/10 dark:border-orange-500/20",
    iconClass: "bg-orange-500/10 text-orange-500",
    paletteClass: "bg-orange-500/10 text-orange-500 border-orange-500/20 hover:bg-orange-500/20",
    supportsTemplate: false,
    customSidePanel: "http_request",
    defaultDelay: { amount: 0, unit: "minutes" },
    outcomes: [
      { id: "default", label: "Continue", color: "#6366f1", hint: "Continue after the webhook" },
    ],
  },
  add_tag: {
    label: "Add Tag",
    icon: "Tag",
    borderClass: "border-teal-500/10 dark:border-teal-500/20",
    iconClass: "bg-teal-500/10 text-teal-500",
    paletteClass: "bg-teal-500/10 text-teal-500 border-teal-500/20 hover:bg-teal-500/20",
    supportsTemplate: false,
    customSidePanel: "tag",
    defaultDelay: { amount: 0, unit: "minutes" },
    outcomes: [
      { id: "default", label: "Continue", color: "#6366f1", hint: "Continue after tagging" },
    ],
  },
  remove_tag: {
    label: "Remove Tag",
    icon: "Tag",
    borderClass: "border-teal-500/10 dark:border-teal-500/20",
    iconClass: "bg-teal-500/10 text-teal-500",
    paletteClass: "bg-teal-500/10 text-teal-500 border-teal-500/20 hover:bg-teal-500/20",
    supportsTemplate: false,
    customSidePanel: "tag",
    defaultDelay: { amount: 0, unit: "minutes" },
    outcomes: [
      { id: "default", label: "Continue", color: "#6366f1", hint: "Continue after untagging" },
    ],
  },
  // Update Lead: same engine handler as Create Lead — apply field mappings to
  // the current journey lead. Use this AFTER an external event (e.g. a Retell
  // call returns transcripts/extracted data) to populate computed fields.
  // Backwards compat: legacy steps with update_field/update_value still execute;
  // the UI migrates them into the new fields array on first edit.
  update_lead: {
    label: "Update Lead",
    icon: "Database",
    borderClass: "border-indigo-500/10 dark:border-indigo-500/20",
    iconClass: "bg-indigo-500/10 text-indigo-500",
    paletteClass: "bg-indigo-500/10 text-indigo-500 border-indigo-500/20 hover:bg-indigo-500/20",
    supportsTemplate: false,
    customSidePanel: "set_lead_fields",
    defaultDelay: { amount: 0, unit: "minutes" },
    defaultsExtra: { fields: [], action_name: "Update lead" },
    outcomes: [
      { id: "default", label: "Continue", color: "#6366f1", hint: "Continue after the update" },
    ],
  },
  // Create/update Lead: populate fields on the CURRENT journey lead from merge tags
  // (typically the webhook payload). Idempotent — coalesces so empty values
  // never overwrite existing data. Engine semantically identical to update_lead;
  // kept only so existing specs continue to load.
  // Spec shape: step.fields = [{ key, value }], step.action_name = label
  create_lead: {
    label: "Create/update lead",
    icon: "UserPlus",
    borderClass: "border-violet-500/10 dark:border-violet-500/20",
    iconClass: "bg-violet-500/10 text-violet-500",
    paletteClass: "bg-violet-500/10 text-violet-500 border-violet-500/20 hover:bg-violet-500/20",
    supportsTemplate: false,
    customSidePanel: "set_lead_fields",
    defaultDelay: { amount: 0, unit: "minutes" },
    defaultsExtra: { fields: [], action_name: "Create/update lead" },
    outcomes: [
      { id: "default", label: "Continue", color: "#6366f1", hint: "Continue after fields are set" },
    ],
  },
  create_lead_from_payload: {
    label: "Create Lead",
    icon: "UserPlus",
    borderClass: "border-violet-500/10 dark:border-violet-500/20",
    iconClass: "bg-violet-500/10 text-violet-500",
    paletteClass: "bg-violet-500/10 text-violet-500 border-violet-500/20 hover:bg-violet-500/20",
    supportsTemplate: false,
    customSidePanel: "create_lead_from_payload",
    defaultDelay: { amount: 0, unit: "minutes" },
    defaultsExtra: {
      action_name: "Create Lead",
      duplicate_mode: "skip_existing",
      field_mappings: [
        { destination: "email", source: { source: "payload.email" } },
        { destination: "first_name", source: { source: "payload.first_name" } },
      ],
      tags: [],
    },
    outcomes: [
      { id: "created", label: "Created", color: "#10b981", hint: "A new lead was created" },
      { id: "updated", label: "Updated", color: "#3b82f6", hint: "An existing lead was updated" },
      { id: "skipped", label: "Skipped", color: "#f59e0b", hint: "An existing lead was found and left unchanged" },
      { id: "failed", label: "Failed", color: "#dc2626", hint: "Lead creation could not run", exitOnDefault: "failed" },
    ],
  },
  // Find Lead: search the tenant's lead pool for any matching row. Useful for
  // dedupe checks ("does another lead already have this email?") and branching.
  // Spec shape: step.filters = [{ key, value }], step.match_strategy = 'any'|'all'
  find_lead: {
    label: "Find Lead",
    icon: "UserSearch",
    borderClass: "border-violet-500/10 dark:border-violet-500/20",
    iconClass: "bg-violet-500/10 text-violet-500",
    paletteClass: "bg-violet-500/10 text-violet-500 border-violet-500/20 hover:bg-violet-500/20",
    supportsTemplate: false,
    customSidePanel: "find_lead",
    defaultDelay: { amount: 0, unit: "minutes" },
    defaultsExtra: { filters: [], match_strategy: "all", action_name: "Find lead" },
    outcomes: [
      { id: "found",     label: "Found",     color: "#10b981", hint: "A matching lead exists" },
      { id: "not_found", label: "Not found", color: "#ef4444", hint: "No matching lead" },
    ],
  },
  // Find Lead from Payload: event-workflow-aware lookup that resolves search
  // values from the webhook payload (or context/static values). Never creates
  // a lead; it only attaches an existing lead to the journey run when found.
  // Spec shape: step.search = [{ field, source }]
  find_lead_from_payload: {
    label: "Find Lead",
    icon: "UserSearch",
    borderClass: "border-violet-500/10 dark:border-violet-500/20",
    iconClass: "bg-violet-500/10 text-violet-500",
    paletteClass: "bg-violet-500/10 text-violet-500 border-violet-500/20 hover:bg-violet-500/20",
    supportsTemplate: false,
    customSidePanel: "find_lead_from_payload",
    defaultDelay: { amount: 0, unit: "minutes" },
    defaultsExtra: {
      action_name: "Find Lead",
      search: [
        { field: "email", source: { source: "payload.email" } },
        { field: "phone", source: { source: "payload.phone" } },
      ],
    },
    outcomes: [
      { id: "found",     label: "Found",     color: "#10b981", hint: "A matching lead exists" },
      { id: "not_found", label: "Not found", color: "#ef4444", hint: "No matching lead" },
    ],
  },
  exit_flow: {
    label: "End Journey",
    icon: "X",
    borderClass: "border-rose-500/20 dark:border-rose-500/30",
    iconClass: "bg-rose-500/10 text-rose-500",
    paletteClass: "bg-rose-500/10 text-rose-500 border-rose-500/30 hover:bg-rose-500/20",
    supportsTemplate: false,
    defaultDelay: { amount: 0, unit: "minutes" },
    outcomes: [], // terminal — no output sockets
  },
};

// Order of entries in the "Add Step" palette
export const PALETTE_ORDER = [
  "call",
  "sms",
  "email",
  "wait",
  "wait_reply",
  "conditional_split",
  "ab_split",
  "http_request",
  "add_tag",
  "remove_tag",
  "update_lead",
  "find_lead",
  "team_alert",
  "exit_flow",
];

export const EVENT_WORKFLOW_PALETTE_ORDER = [
  "find_lead_from_payload",
  "create_lead_from_payload",
  "conditional_split",
  "ab_split",
  "wait",
  "http_request",
  "exit_flow",
];

// Build the default on_outcome map for a step of the given type.
export function defaultOutcomesFor(stepType) {
  const outcomes = outcomesForStep(stepType);
  if (!outcomes.length) return {};
  const out = {};
  for (const o of outcomes) {
    out[o.id] = { exit: o.exitOnDefault || "completed" };
  }
  return out;
}

// Migrate an existing step's on_outcome to the current schema vocabulary.
// If the saved spec used an outdated outcome key (e.g. `default` on an SMS step),
// fan it out across all current outcomes so the new handles show the existing routing.
export function migrateOnOutcomes(step) {
  const outcomes = outcomesForStep(step);
  if (!outcomes.length) return step;
  const existing = step.on_outcome || {};
  const fallback = existing.default || { exit: "completed" };
  const next = {};
  for (const o of outcomes) {
    next[o.id] = existing[o.id] ?? fallback;
  }
  return { ...step, on_outcome: next };
}

export function outcomesForStep(stepOrType) {
  const step = typeof stepOrType === "string" ? { type: stepOrType } : (stepOrType || {});
  const cfg = STEP_TYPES[step.type];
  if (!cfg?.outcomes?.length) return [];

  if (step.type === "conditional_split" && Array.isArray(step.branches) && step.branches.length > 0) {
    const branchColors = ["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6"];
    const branchOutcomes = step.branches
      .map((branch, index) => {
        const id = String(branch?.id || `branch_${index + 1}`).trim();
        if (!id) return null;
        return {
          id,
          label: String(branch?.label || `Branch ${index + 1}`).trim() || `Branch ${index + 1}`,
          color: branchColors[index % branchColors.length],
          hint: "First matching branch",
        };
      })
      .filter(Boolean);

    if (branchOutcomes.length > 0) {
      return [
        ...branchOutcomes,
        { id: "else", label: "Else", color: "#ef4444", hint: "No branch matched" },
      ];
    }
  }

  return cfg.outcomes;
}

// Whether this step type supports the standard template selector
export function templateChannelFor(stepType) {
  const cfg = STEP_TYPES[stepType];
  if (!cfg?.supportsTemplate) return null;
  return cfg.templateChannel || stepType;
}

const OUTCOME_LABELS = {
  answered: "Call answered",
  no_answer: "No answer",
  voicemail: "Voicemail",
  busy: "Busy",
  failed: "Failed",
  failed_permanent: "Failed",
  invalid_number: "Invalid number",
  wrong_number: "Wrong number",
  sent: "Sent successfully",
  delivered: "Delivered",
  replied: "Lead replied",
  opt_out: "Opted out",
  bounced: "Email bounced",
  bounce_hard: "Hard bounced",
  timeout: "No reply yet",
  yes: "Yes",
  no: "No",
  found: "Found",
  not_found: "Not found",
  default: "Continue",
  completed: "Completed",
  responded: "Lead replied",
  opted_out: "Opted out",
};

const EXIT_LABELS = {
  completed: "Completed",
  responded: "Lead replied",
  opted_out: "Opted out",
  failed: "Failed",
  error: "Failed",
};

export function getJourneyNodeDisplay(stepType) {
  const cfg = STEP_TYPES[stepType];
  return {
    label: cfg?.label || humanizeJourneyLabel(stepType || "Action step"),
    rawValue: stepType,
  };
}

export function getJourneyOutcomeDisplay(stepOrType, outcomeKey) {
  const outcome = outcomesForStep(stepOrType).find((item) => item.id === outcomeKey);
  return {
    label: outcome?.label || OUTCOME_LABELS[String(outcomeKey || "").toLowerCase()] || humanizeJourneyLabel(outcomeKey || "Outcome"),
    rawValue: outcomeKey,
  };
}

export function getJourneyExitDisplay(exitKey) {
  return {
    label: EXIT_LABELS[String(exitKey || "").toLowerCase()] || humanizeJourneyLabel(exitKey || "End journey"),
    rawValue: exitKey,
  };
}

function humanizeJourneyLabel(value) {
  return String(value || "")
    .replace(/AI_REPLY/gi, "AI reply")
    .replace(/EXIT_FLOW/gi, "Journey ended")
    .replace(/team_alert/gi, "Team alert")
    .replace(/bounce_hard/gi, "Hard bounced")
    .replace(/opt_out/gi, "Opted out")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
