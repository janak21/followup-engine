import {
  getDeliveryStatusDisplay,
  getStatusClass,
  getSuppressionReasonDisplay,
  getSuppressionSourceDisplay,
} from "./statusDisplay.ts";

const PRIORITY = {
  human_reply: 1,
  callback: 2,
  failed_action: 3,
  suppressed: 4,
  system_issue: 5,
  setup_issue: 6,
};

const SEVERITY = {
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "info",
};

export function buildAttentionItems(source = {}, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 8;
  const items = [
    ...humanReplyItems(source.aiEscalations),
    ...callbackItems(source.callbacks),
    ...failedActionItems(source.failedActions),
    ...suppressionItems(source.suppressions),
    ...stuckActionItems(source.stuckActions),
    ...systemIssueItems(source.errors),
    ...setupIssueItems(source.setupIssues),
  ];

  return items
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return toTime(b.time) - toTime(a.time);
    })
    .slice(0, limit)
    .map((item) => ({
      ...item,
      badgeClassName: getStatusClass(SEVERITY[item.severity] || "neutral"),
    }));
}

function humanReplyItems(rows = []) {
  return rows.filter(Boolean).map((row) => {
    const intent = humanize(row.intent || row.escalation_reason || "reply");
    return baseItem({
      id: `human-${row.id}`,
      category: "human_reply",
      type: "Needs human reply",
      severity: "high",
      title: leadTitle(row),
      reason: `AI escalated this reply as ${intent.toLowerCase()}.`,
      time: row.created_at,
      href: leadHref(row.lead_id),
      actionLabel: row.lead_id ? "View lead" : null,
    });
  });
}

function callbackItems(rows = []) {
  return rows.filter(Boolean).map((row) => {
    const hasDueTime = !!row.callback_at;
    return baseItem({
      id: `callback-${row.id}`,
      category: "callback",
      type: hasDueTime ? "Callback due" : "Callback requested",
      severity: "medium",
      title: leadTitle(row),
      reason: hasDueTime ? "Lead requested a callback time." : "Lead requested a callback.",
      time: row.callback_at || row.updated_at || row.created_at,
      href: leadHref(row.id || row.lead_id),
      actionLabel: "View lead",
    });
  });
}

function failedActionItems(rows = []) {
  return rows.filter(Boolean).map((row) => {
    const delivery = getDeliveryStatusDisplay(row.status, row);
    const action = humanize(row.action_type || "follow-up");
    const error = cleanText(row.error_message);
    return baseItem({
      id: `action-${row.id}`,
      category: "failed_action",
      type: "Failed action",
      severity: "high",
      title: leadTitle(row),
      reason: `${action} follow-up ${delivery.label.toLowerCase()}${error ? `: ${error}` : "."}`,
      time: row.completed_at || row.run_at || row.created_at,
      href: row.lead_id ? leadHref(row.lead_id) : "/operations",
      actionLabel: row.lead_id ? "View lead" : "View operations",
    });
  });
}

function suppressionItems(rows = []) {
  return rows.filter(Boolean).map((row) => {
    const reason = getSuppressionReasonDisplay(row.reason);
    const source = getSuppressionSourceDisplay(row.source);
    const reasonLabel = reason.label === "Hard bounced" ? "Email hard bounced" : reason.label;
    const title = leadTitle(row, row.email || row.phone_e164 || "Suppressed contact");
    return baseItem({
      id: `suppression-${row.id}`,
      category: "suppressed",
      type: reasonLabel.includes("bounce") || reasonLabel.includes("bounced") ? "Email bounced" : "Contact suppressed",
      severity: "high",
      title,
      reason: `${reasonLabel} from ${source.label}.`,
      time: row.created_at,
      href: row.lead_id ? leadHref(row.lead_id) : "/suppressions",
      actionLabel: row.lead_id ? "View lead" : "Review suppression",
    });
  });
}

function stuckActionItems(rows = []) {
  return rows.filter(Boolean).map((row) => {
    const action = humanize(row.action_type || "follow-up");
    return baseItem({
      id: `stuck-${row.id}`,
      category: "system_issue",
      type: "Stuck action",
      severity: "medium",
      title: leadTitle(row),
      reason: `${action} follow-up is stuck past its lock window.`,
      time: row.locked_until || row.run_at || row.created_at,
      href: row.lead_id ? leadHref(row.lead_id) : "/operations",
      actionLabel: row.lead_id ? "View lead" : "View operations",
    });
  });
}

function systemIssueItems(rows = []) {
  return rows.filter(Boolean).map((row) => baseItem({
    id: `error-${row.id}`,
    category: "system_issue",
    type: "System issue",
    severity: row.severity === "critical" || row.severity === "error" ? "high" : "medium",
    title: cleanText(row.context || row.source || row.workflow_name || row.node_name || "Operational issue"),
    reason: cleanText(row.message || row.error_message || "Recent operational error affects follow-up."),
    time: row.created_at,
    href: "/errors",
    actionLabel: "View errors",
  }));
}

function setupIssueItems(rows = []) {
  return rows.filter(Boolean).map((row) => baseItem({
    id: `setup-${row.id || row.type}`,
    category: "setup_issue",
    type: "Setup issue",
    severity: "medium",
    title: cleanText(row.title || "Configuration issue"),
    reason: cleanText(row.reason || "Review setup before follow-up continues."),
    time: row.created_at,
    href: row.href || "/settings",
    actionLabel: row.actionLabel || "Review settings",
  }));
}

function baseItem(item) {
  return {
    disabled: !item.href,
    ...item,
    priority: PRIORITY[item.category] || 99,
  };
}

function leadHref(leadId) {
  return leadId ? `/leads?leadId=${encodeURIComponent(leadId)}` : null;
}

function leadTitle(row, fallback = "Lead") {
  return cleanText(row.leadName || [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || row.phone_e164 || fallback);
}

function cleanText(value) {
  return String(value || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function humanize(value) {
  const text = cleanText(value);
  return text ? text.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
}

function toTime(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}
