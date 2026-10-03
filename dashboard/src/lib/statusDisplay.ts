// Single source of truth for status → label/variant/tooltip mapping across
// the dashboard. Typed: every helper returns a StatusDisplay, so callers can
// rely on label/variant/className being present.

export type StatusVariant = "success" | "warning" | "danger" | "neutral" | "info" | "ai";

export interface StatusDisplay {
  label: string;
  variant: StatusVariant;
  title: string;
  rawValue: unknown;
  className: string;
  pillClassName: string;
  dotClassName: string;
}

type DisplayTuple = [label: string, variant: StatusVariant, title: string];

const DISPLAY_BY_VARIANT: Record<StatusVariant, string> = {
  success: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/35",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40",
  danger: "bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/40",
  neutral: "bg-zinc-500/15 text-zinc-800 dark:text-zinc-200 border-zinc-500/35",
  info: "bg-blue-500/15 text-blue-800 dark:text-blue-300 border-blue-500/35",
  ai: "bg-violet-500/15 text-violet-800 dark:text-violet-300 border-violet-500/35",
};

const DOT_BY_VARIANT: Record<StatusVariant, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  neutral: "bg-zinc-400",
  info: "bg-blue-500",
  ai: "bg-violet-500",
};

const BASE_PILL_CLASS = "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border";

const JOURNEY_STATUS: Record<string, DisplayTuple> = {
  new: ["Not enrolled", "neutral", "Lead exists, but the automation has not started."],
  active: ["Running", "success", "Automation is currently running for this lead."],
  paused: ["Paused", "neutral", "Automation is paused."],
  responded: ["Exited", "neutral", "Automation exited because the lead replied."],
  callback_booked: ["Exited", "neutral", "Automation exited after a callback was requested."],
  opted_out: ["Exited", "danger", "Automation exited because the lead opted out."],
  completed: ["Completed", "success", "Automation reached a terminal completed state."],
  failed: ["Failed", "danger", "Automation stopped after a failure."],
  error: ["Failed", "danger", "Automation stopped after an error."],
};

const DELIVERY_STATUS: Record<string, DisplayTuple> = {
  pending: ["Scheduled", "warning", "Outbound action is queued for a future run."],
  in_progress: ["Sending", "info", "Outbound action is currently being processed."],
  completed: ["Accepted", "success", "Provider accepted or completed the outbound action."],
  sent: ["Sent", "success", "Outbound action was sent."],
  delivered: ["Delivered", "success", "Provider confirmed delivery."],
  failed: ["Failed", "danger", "Outbound action failed."],
  failed_permanent: ["Failed", "danger", "Outbound action failed permanently."],
  cancelled: ["Cancelled", "neutral", "Outbound action was cancelled before sending."],
  skipped: ["Skipped", "neutral", "Outbound action was skipped by the engine."],
  bounced: ["Bounced", "danger", "Outbound email bounced."],
  bounce_hard: ["Hard bounced", "danger", "Email hard-bounced."],
};

const SUPPRESSION_REASONS: Record<string, DisplayTuple> = {
  opt_out: ["Opted out", "danger", "Lead asked not to be contacted."],
  unsubscribe: ["Unsubscribed", "danger", "Lead unsubscribed from outreach."],
  manual: ["Manual suppression", "warning", "Suppression was added manually."],
  bounce: ["Email bounce", "danger", "Email bounced."],
  bounce_hard: ["Hard bounced", "danger", "Email hard-bounced."],
  hard_bounce: ["Hard bounced", "danger", "Email hard-bounced."],
  complaint: ["Spam complaint", "danger", "Recipient complained or marked outreach as spam."],
  do_not_contact: ["Do not contact", "danger", "Lead must not be contacted."],
};

const SUPPRESSION_SOURCES: Record<string, DisplayTuple> = {
  inbound_sms: ["Inbound SMS", "info", "Suppression came from an inbound SMS."],
  inbound_email: ["Inbound email", "info", "Suppression came from an inbound email."],
  inbound_email_bounce: ["Email bounce", "danger", "Suppression came from an inbound email bounce."],
  gmail_bounce: ["Email bounce", "danger", "Suppression came from Gmail bounce handling."],
  manual: ["Manual entry", "warning", "Suppression was added manually."],
  import: ["Imported", "neutral", "Suppression was imported."],
};

type Row = Record<string, unknown>;

export function getLeadStatusDisplay(value: unknown, row: Row = {}): StatusDisplay {
  if (row.opt_out || value === "opted_out") {
    return display("Opted out", "danger", "Lead asked not to be contacted.", value);
  }
  if (row.callback_requested || value === "callback_booked") {
    return display("Engaged", "warning", "Lead requested or needs a callback.", value);
  }
  if (row.responded || value === "responded") {
    return display("Engaged", "info", "Lead has replied or otherwise engaged.", value);
  }
  if (value === "completed") {
    return display("Completed", "success", "Lead completed the intended follow-up path.", value);
  }
  if (value === "failed" || value === "error") {
    return display("Lost", "danger", "Lead is blocked by a failed journey state.", value);
  }
  if (value === "active") {
    return display("Active", "success", "Lead is currently in active follow-up.", value);
  }
  return display("New", "info", "Lead is new or not yet engaged.", value);
}

export function getJourneyStatusDisplay(value: unknown, row: Row | null = {}): StatusDisplay {
  if (!row?.journey_template && !value) {
    return display("Not enrolled", "neutral", "Lead is not enrolled in a journey.", value);
  }
  return displayFromMap(JOURNEY_STATUS, value, "Not enrolled", "neutral", "Unknown journey status.");
}

export function getConversationStatusDisplay(row: Row = {}): StatusDisplay {
  if (row.needs_human_reply || row.ai_escalated) {
    return display("Needs human reply", "warning", "A person should reply before automation continues.", row.journey_status);
  }
  if (row.callback_requested || row.journey_status === "callback_booked") {
    return display("Callback requested", "warning", "Lead requested a callback.", row.journey_status);
  }
  if (row.responded || row.journey_status === "responded" || row.opt_out) {
    return display("Replied", "info", "Lead has replied.", row.journey_status);
  }
  if (row.journey_status === "active") {
    return display("Waiting for lead", "neutral", "Outreach has been sent and no reply is recorded yet.", row.journey_status);
  }
  return display("No reply yet", "neutral", "No reply is recorded for this lead.", row.journey_status);
}

export function getDeliveryStatusDisplay(value: unknown, row: Row = {}): StatusDisplay {
  if ((row.raw_payload as Row | undefined)?.bounce === true || row.email_status === "bounce_hard") {
    return display("Bounced", "danger", "Email bounced.", value);
  }
  return displayFromMap(DELIVERY_STATUS, value, humanize(value || "logged"), "neutral", "Delivery status reported by the action or event.");
}

export function getComplianceStatusDisplay(row: Row = {}): StatusDisplay {
  const reason = row.suppression_reason || row.reason;
  if (row.opt_out || row.journey_status === "opted_out") {
    return display("Unsubscribed", "danger", "Lead has opted out. Do not contact.", reason);
  }
  if (reason) {
    const reasonDisplay = getSuppressionReasonDisplay(reason);
    return display(reasonDisplay.label, reasonDisplay.variant, reasonDisplay.title, reason);
  }
  return display("Contactable", "success", "No opt-out or suppression is shown for this lead.", reason);
}

export function getSuppressionReasonDisplay(value: unknown): StatusDisplay {
  return displayFromMap(SUPPRESSION_REASONS, value, humanize(value || "Suppressed"), "danger", "Suppression reason.");
}

export function getSuppressionSourceDisplay(value: unknown): StatusDisplay {
  return displayFromMap(SUPPRESSION_SOURCES, value, humanize(value || "Unknown source"), "neutral", "Suppression source.");
}

export function getStatusClass(variant: string): string {
  return DISPLAY_BY_VARIANT[variant as StatusVariant] || DISPLAY_BY_VARIANT.neutral;
}

export function getStatusDotClass(variant: string): string {
  return DOT_BY_VARIANT[variant as StatusVariant] || DOT_BY_VARIANT.neutral;
}

export function getStatusPillClass(variant: string, extra = ""): string {
  return `${BASE_PILL_CLASS} ${getStatusClass(variant)}${extra ? ` ${extra}` : ""}`;
}

function displayFromMap(map: Record<string, DisplayTuple>, value: unknown, fallbackLabel: string, fallbackVariant: StatusVariant, fallbackTitle: string): StatusDisplay {
  const key = normalizeKey(value);
  const mapped = map[key];
  if (!mapped) return display(fallbackLabel, fallbackVariant, fallbackTitle, value);
  return display(mapped[0], mapped[1], mapped[2], value);
}

function display(label: string, variant: StatusVariant, title: string, rawValue: unknown): StatusDisplay {
  return {
    label,
    variant,
    title,
    rawValue,
    className: getStatusClass(variant),
    pillClassName: getStatusPillClass(variant),
    dotClassName: getStatusDotClass(variant),
  };
}

function normalizeKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function humanize(value: unknown): string {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
