const CHANNELS = {
  email: { label: "Email", variant: "info" },
  sms: { label: "SMS", variant: "warning" },
  whatsapp: { label: "WhatsApp", variant: "success" },
  call: { label: "Call", variant: "ai" },
  team_alert: { label: "Team alert", variant: "neutral" },
};

const CHANNEL_CLASS = {
  info: "bg-blue-500/15 text-blue-800 dark:text-blue-300 border-blue-500/35",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40",
  success: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/35",
  ai: "bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border-indigo-500/35",
  neutral: "bg-zinc-500/15 text-zinc-800 dark:text-zinc-200 border-zinc-500/35",
};

export const COMMON_MERGE_TAGS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "company",
  "source",
  "zip_code",
  "address",
  "timezone",
];

export function getTemplateChannelDisplay(channel) {
  const key = String(channel || "").toLowerCase();
  const display = CHANNELS[key] || { label: humanize(channel || "Unknown"), variant: "neutral" };
  return { ...display, rawValue: channel };
}

export function getTemplateChannelClass(channel) {
  const display = getTemplateChannelDisplay(channel);
  return CHANNEL_CLASS[display.variant] || CHANNEL_CLASS.neutral;
}

export function getTemplateTitle(template = {}) {
  return template.subject || template.notes || humanize(template.template_key || "Untitled template");
}

export function normalizeTemplateText(value = "") {
  return String(value)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

export function validateMergeTags(text = "") {
  const source = String(text || "");
  const warnings = [];
  const openCount = (source.match(/{{/g) || []).length;
  const closeCount = (source.match(/}}/g) || []).length;

  if (openCount > closeCount) {
    warnings.push("A merge tag is missing closing braces: }}");
  }
  if (closeCount > openCount) {
    warnings.push("A merge tag has closing braces without matching opening braces: {{");
  }
  if (/{{[^}]*$/.test(source)) {
    warnings.push("A merge tag appears unfinished.");
  }
  if (/{{\s*}}/.test(source)) {
    warnings.push("A merge tag is empty.");
  }

  return [...new Set(warnings)];
}

function humanize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
