"use client"

// Presentational helpers shared across the leads table, detail drawer, and
// conversation timeline. Extracted verbatim from leads/page.jsx — no behavior
// change; page-level state stays in the page.

import { Badge } from "@/components/ui/badge"
import {
  getComplianceStatusDisplay,
  getConversationStatusDisplay,
  getDeliveryStatusDisplay,
  getJourneyStatusDisplay,
} from "@/lib/statusDisplay"

function StatusPill({ display, className = "" }) {
  return (
    <Badge variant={display.variant} className={className} title={display.title}>
      {display.label}
    </Badge>
  )
}

function getLeadCurrentStateSummary(lead, timeline = []) {
  if (!lead) return null
  const aiEscalation = timeline.find((item) => item.isAIEscalation)
  const failedAction = timeline.find((item) => ["failed", "failed_permanent", "error"].includes(item.status))
  const pendingAction = timeline.find((item) => item.status === "pending")
  const conversation = getConversationStatusDisplay(lead)
  const compliance = getComplianceStatusDisplay(lead)
  const journey = getJourneyStatusDisplay(lead.journey_status, lead)

  if (compliance.variant === "danger") {
    return {
      tone: "danger",
      title: "This lead cannot be contacted.",
      detail: compliance.title || "Contactability is restricted for this lead.",
    }
  }
  if (aiEscalation) {
    return {
      tone: "warning",
      title: "This lead replied and needs a human response.",
      detail: "AI escalated this reply for human review.",
    }
  }
  if (failedAction) {
    return {
      tone: "danger",
      title: "The last follow-up action failed.",
      detail: failedAction.error || failedAction.subtitle || "Review the timeline before continuing follow-up.",
    }
  }
  if (conversation.label === "Replied") {
    return {
      tone: "info",
      title: "Lead replied. Review before sending another follow-up.",
      detail: "Conversation history is available below.",
    }
  }
  if (lead.journey_status === "active") {
    return {
      tone: "success",
      title: "This lead is currently running through a journey.",
      detail: pendingAction?.subtitle || "Follow-up automation is active.",
    }
  }
  if (lead.journey_status === "completed") {
    return {
      tone: "neutral",
      title: "This lead completed the journey. No next step is scheduled.",
      detail: journey.title,
    }
  }
  if (["responded", "callback_booked", "opted_out"].includes(lead.journey_status)) {
    return {
      tone: lead.journey_status === "opted_out" ? "danger" : "neutral",
      title: "This lead exited the journey.",
      detail: journey.title,
    }
  }
  if (["failed", "error"].includes(lead.journey_status)) {
    return {
      tone: "danger",
      title: "This lead's journey failed.",
      detail: journey.title,
    }
  }
  return {
    tone: "info",
    title: "This lead is ready for follow-up.",
    detail: "No reply or failure is recorded yet.",
  }
}

function getTimelineEventDisplay(item) {
  const channelLabel = {
    email: "Email",
    sms: "SMS",
    call: "Call",
    system: "System",
  }[item.channel] || "Follow-up"
  const delivery = item.type === "outbound" ? getDeliveryStatusDisplay(item.status, item) : null
  const status = item.wasRescheduled
    ? { label: "Rescheduled", variant: "info", title: "Action was moved to a later time." }
    : delivery || getReadableStatusDisplay(item.status)

  if (item.isAIEscalation) {
    return {
      title: "AI escalated reply",
      status,
    }
  }
  if (item.aiSource === "ai_reply") {
    return {
      title: "AI reply sent",
      status,
    }
  }
  // Team alerts fire outbound emails, but the recipient is the internal team,
  // not the lead. Label them distinctly so the timeline doesn't imply the
  // customer got an email. Field name is `aiSource` for historical reasons —
  // it carries payload.source, which is 'ai_reply' | 'team_alert' | null.
  if (item.aiSource === "team_alert" || item.aiSource === "ai_reply_escalation") {
    return {
      title: item.aiSource === "team_alert" ? "Team alert sent" : "Team alert (AI escalation)",
      status,
    }
  }
  if (item.type === "inbound") {
    return {
      title: `${channelLabel} reply received`,
      status,
    }
  }
  if (item.type === "outbound") {
    return {
      title: `${channelLabel} follow-up`,
      status,
    }
  }
  return {
    title: humanizeTimelineTitle(item.title || item.channel || "Timeline event"),
    status,
  }
}

function getReadableStatusDisplay(status) {
  const value = String(status || "").toLowerCase()
  const map = {
    received: ["Received", "success", "Inbound event was received."],
    connected: ["Connected", "success", "Call connected."],
    pending: ["Scheduled", "warning", "Action is scheduled."],
    skipped: ["Skipped", "neutral", "Action was skipped."],
    cancelled: ["Cancelled", "neutral", "Action was cancelled."],
    failed: ["Failed", "danger", "Action failed."],
    error: ["Failed", "danger", "Action failed."],
  }
  const mapped = map[value] || [humanizeTimelineTitle(status || "Logged"), "neutral", "Timeline status."]
  return { label: mapped[0], variant: mapped[1], title: mapped[2] }
}

function humanizeTimelineTitle(value) {
  const text = String(value || "")
    .replace(/AI_REPLY/gi, "AI reply sent")
    .replace(/EXIT_FLOW/gi, "Journey ended")
    .replace(/team_alert/gi, "Team alert created")
    .replace(/inbound_email_bounce/gi, "Email bounced")
    .replace(/bounce_hard/gi, "Hard bounced")
    .replace(/_/g, " ")
    .trim()
  return text.replace(/\b\w/g, (char) => char.toUpperCase())
}

function humanizeInlineLabel(value, fallback = "Needs review") {
  const text = String(value || fallback)
    .replace(/AI_REPLY/gi, "AI reply sent")
    .replace(/EXIT_FLOW/gi, "Journey ended")
    .replace(/team_alert/gi, "Team alert created")
    .replace(/inbound_email_bounce/gi, "Email bounced")
    .replace(/bounce_hard/gi, "Hard bounced")
    .replace(/_/g, " ")
    .trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function getWarningDisplay(warning) {
  const code = String(warning?.code || "")
  const message = String(warning?.message || "")
  if (/completed.*step 0|step 0.*completed|exited/i.test(`${code} ${message}`)) {
    return {
      label: "Journey ended early",
      message: "This journey ended after the first step. No further steps are scheduled.",
      details: message,
    }
  }
  if (/bounce_hard|inbound_email_bounce/i.test(`${code} ${message}`)) {
    return {
      label: "Email bounced",
      message: "Email delivery failed and this lead may not be contactable.",
      details: message,
    }
  }
  return {
    label: humanizeTimelineTitle(code || "Notice"),
    message: humanizeTimelineTitle(message || "Review this lead before continuing follow-up."),
    details: message,
  }
}

function getJourneyStepLabel(type) {
  const map = {
    email: "Email",
    sms: "SMS",
    call: "Call",
    wait: "Wait",
    condition: "Condition",
    condition_split: "Condition split",
    exit_flow: "Journey ended",
    team_alert: "Team alert",
    create_lead: "Lead created",
  }
  return map[String(type || "").toLowerCase()] || humanizeTimelineTitle(type || "Step")
}

export {
  StatusPill,
  getLeadCurrentStateSummary,
  getTimelineEventDisplay,
  getReadableStatusDisplay,
  humanizeTimelineTitle,
  humanizeInlineLabel,
  getWarningDisplay,
  getJourneyStepLabel,
}
