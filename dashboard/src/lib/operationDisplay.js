import { getAiAgentIntentDisplay } from "./aiAgentDisplay.js";
import { getDeliveryStatusDisplay } from "./statusDisplay.ts";

const ACTION_LABELS = {
  email: "Email follow-up",
  sms: "SMS follow-up",
  call: "Call follow-up",
  ai_reply: "AI reply",
  team_alert: "Team alert",
  http_request: "Webhook",
  exit_flow: "End journey",
};

const AI_ESCALATION_LABELS = {
  confidence_below_threshold: "Sent to human because confidence was low",
  max_auto_replies: "Sent to human after the reply limit",
  no_reply: "No AI reply was sent",
};

export function getOperationActionDisplay(actionType) {
  const key = String(actionType || "").toLowerCase();
  return {
    label: ACTION_LABELS[key] || humanize(actionType || "Follow-up action"),
    rawValue: actionType,
  };
}

export function getOperationStatusDisplay(status, row = {}) {
  const base = getDeliveryStatusDisplay(status, row);
  if (status === "in_progress") {
    return { ...base, label: "Processing", title: "Follow-up action is currently being processed." };
  }
  if (status === "pending") {
    return { ...base, label: "Queued", title: "Follow-up action is waiting to be processed." };
  }
  return base;
}

export function getAiDecisionDisplay(event = {}) {
  const reason = String(event.escalation_reason || "");
  if (reason.startsWith("llm_error")) {
    return {
      label: "AI reply failed",
      variant: "danger",
      reason: "AI reply could not be generated.",
      rawValue: event.escalation_reason,
    };
  }
  if (reason) {
    return {
      label: "Needs human review",
      variant: "warning",
      reason: AI_ESCALATION_LABELS[reason] || humanize(reason),
      rawValue: event.escalation_reason,
    };
  }
  return {
    label: "AI replied",
    variant: "success",
    reason: "AI sent a reply.",
    rawValue: event.escalation_reason,
  };
}

export function getAiIntentLabel(intent) {
  return getAiAgentIntentDisplay(intent).label;
}

function humanize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

