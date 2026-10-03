// Shared step-palette metadata for the builder: the webhook-context validity
// rules, the display-label overrides, and the categorised grouping used by the
// guided "+" action picker. Kept here (not duplicated in each component) so the
// toolbox palette and the add-step picker share one source of truth.

import { EVENT_WORKFLOW_PALETTE_ORDER } from "@/lib/journeyStepTypes"

export const WEBHOOK_ACTION_PALETTE_ORDER = [
  "find_lead_from_payload",
  "create_lead_from_payload",
  "update_lead",
  "add_tag",
  "remove_tag",
  "sms",
  "email",
  "call",
  "wait",
  "wait_reply",
  "conditional_split",
  "http_request",
  "team_alert",
  "exit_flow",
]

const WEBHOOK_EXECUTABLE_ACTIONS = new Set([
  ...EVENT_WORKFLOW_PALETTE_ORDER,
  "sms",
  "email",
  "call",
  "wait",
  "wait_reply",
  "add_tag",
  "remove_tag",
  "update_lead",
  "team_alert",
])
const WEBHOOK_LEAD_REQUIRED_ACTIONS = new Set(["update_lead", "add_tag", "remove_tag", "sms", "email", "call", "wait_reply"])
const WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS = new Set([])

// Why a given step type can't be added to a webhook-triggered automation yet,
// or null if it's allowed. `hasLeadContext` = the automation already has a
// create/find-lead step that establishes a lead to act on.
export function getWebhookActionDisabledReason(stepType, hasLeadContext) {
  if (EVENT_WORKFLOW_PALETTE_ORDER.includes(stepType)) return null
  if (WEBHOOK_EXECUTABLE_ACTIONS.has(stepType) && hasLeadContext) return null
  if (WEBHOOK_EVENT_AWARE_RUNTIME_PENDING_ACTIONS.has(stepType)) {
    return "Needs event-aware runtime before this can run in webhook-triggered automations."
  }
  if (!hasLeadContext && WEBHOOK_LEAD_REQUIRED_ACTIONS.has(stepType)) {
    return "Requires a lead. Add Create Lead or Find Lead earlier in this automation."
  }
  if (!hasLeadContext) {
    return "Add Create Lead earlier in this automation so this action can run."
  }
  if (WEBHOOK_LEAD_REQUIRED_ACTIONS.has(stepType)) {
    return "Requires a lead. Add Create Lead or Find Lead earlier in this automation."
  }
  return "Not supported for webhook-triggered automations yet."
}

// Display-label overrides for a couple of step types whose canvas name reads
// better than the raw registry label. Labels still originate from the registry.
export function paletteLabelFor(stepType, cfg) {
  if (stepType === "http_request") return "Send webhook / HTTP request"
  if (stepType === "conditional_split") return "If/Else"
  return cfg.label
}

// Categorised grouping for the add-step picker. Type keys reference the
// registry; labels/icons/hints are pulled from STEP_TYPES at render time so
// this file is not a second source of truth for them.
export const ADD_STEP_CATEGORIES = [
  { id: "communication", label: "Communication", types: ["sms", "email", "call", "team_alert"] },
  { id: "timing", label: "Timing", types: ["wait", "wait_reply"] },
  { id: "logic", label: "Logic", types: ["conditional_split", "ab_split"] },
  {
    id: "lead_ops",
    label: "Lead ops",
    types: [
      "add_tag",
      "remove_tag",
      "update_lead",
      "create_lead",
      "create_lead_from_payload",
      "find_lead",
      "find_lead_from_payload",
    ],
  },
  { id: "integrations", label: "Integrations", types: ["http_request"] },
]

// Whether the automation already establishes a lead (mirrors the toolbox's
// check). Used only for webhook journeys.
export function webhookHasLeadContext(steps = []) {
  return steps.some((s) => s.type === "create_lead_from_payload" || s.type === "find_lead_from_payload")
}
