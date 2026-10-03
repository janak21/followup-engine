import {
  getSuppressionReasonDisplay as getBaseSuppressionReasonDisplay,
  getSuppressionSourceDisplay as getBaseSuppressionSourceDisplay,
} from "./statusDisplay.ts";

const CHANNELS = {
  email: { label: "Email", variant: "info" },
  sms: { label: "SMS / phone", variant: "success" },
  call: { label: "Call", variant: "info" },
  phone: { label: "Phone", variant: "success" },
};

const CHANNEL_CLASS = {
  info: "bg-blue-500/15 text-blue-800 dark:text-blue-300 border-blue-500/35",
  success: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/35",
  neutral: "bg-zinc-500/15 text-zinc-800 dark:text-zinc-200 border-zinc-500/35",
};

const SOURCE_OVERRIDES = {
  inbound_email_bounce: ["Automatic email bounce", "danger", "Suppression was created automatically from an email bounce."],
  manual: ["Manually added", "warning", "Suppression was added manually."],
  import: ["Imported", "neutral", "Suppression was imported."],
  webhook: ["Webhook", "info", "Suppression was created through a webhook."],
  system: ["System", "neutral", "Suppression was created by the system."],
  journey: ["Journey automation", "info", "Suppression was created by journey automation."],
};

const REASON_OVERRIDES = {
  bounce_hard: ["Hard bounce", "danger", "Email hard-bounced."],
  hard_bounce: ["Hard bounce", "danger", "Email hard-bounced."],
  opt_out: ["Opted out", "danger", "Contact opted out of outreach."],
  opted_out: ["Opted out", "danger", "Contact opted out of outreach."],
  manual: ["Manually added", "warning", "Suppression was added manually."],
  invalid_phone: ["Invalid phone", "danger", "Phone number is invalid or unusable."],
  unknown: ["Unknown reason", "neutral", "Suppression reason is unknown."],
};

export function getSuppressionReasonDisplay(value) {
  const key = normalize(value);
  const override = REASON_OVERRIDES[key];
  if (override) return display(override[0], override[1], override[2], value);
  return getBaseSuppressionReasonDisplay(value);
}

export function getSuppressionSourceDisplay(value) {
  const key = normalize(value);
  const override = SOURCE_OVERRIDES[key];
  if (override) return display(override[0], override[1], override[2], value);
  return getBaseSuppressionSourceDisplay(value);
}

export function getSuppressionChannelDisplay(channel) {
  const key = normalize(channel);
  const mapped = CHANNELS[key] || { label: channel ? humanize(channel) : "All channels", variant: "neutral" };
  return { ...mapped, rawValue: channel };
}

export function getSuppressionChannelClass(channel) {
  const display = getSuppressionChannelDisplay(channel);
  return CHANNEL_CLASS[display.variant] || CHANNEL_CLASS.neutral;
}

export function getSuppressionIdentifier(row = {}) {
  return row.email || row.phone_e164 || "Unknown contact";
}

export function groupSuppressions(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const identifier = getSuppressionIdentifier(row);
    const key = `${normalize(row.channel || "all")}::${identifier.toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.events.push(row);
      existing.count += 1;
      if (new Date(row.created_at || 0) > new Date(existing.latest.created_at || 0)) {
        existing.latest = row;
      }
    } else {
      groups.set(key, {
        key,
        identifier,
        channel: row.channel,
        latest: row,
        events: [row],
        count: 1,
      });
    }
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    events: group.events.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)),
  }));
}

function display(label, variant, title, rawValue) {
  return { label, variant, title, rawValue };
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function humanize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
