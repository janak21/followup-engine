import type { StatusVariant } from "./statusDisplay.ts";

export interface ErrorRow {
  signature?: string | null;
  workflow_name?: string | null;
  journey_name?: string | null;
  node_name?: string | null;
  action_type?: string | null;
  error_message?: string | null;
  sample_message?: string | null;
  severity?: string | null;
}

export interface IssueDisplay {
  label: string;
  variant: StatusVariant;
  title: string;
  rawValue: string | null | undefined;
}

export interface FailureExplanation {
  cause: string;
  suggestion: string;
}

interface IssuePattern {
  match: RegExp;
  label: string;
  variant: StatusVariant;
  title: string;
}

interface FailurePattern {
  match: RegExp;
  cause: string;
  suggestion: string;
}

const ISSUE_PATTERNS: IssuePattern[] = [
  {
    match: /dispatch_pending_actions:inline:http_request|http_request|webhook/i,
    label: "Webhook step failed",
    variant: "danger",
    title: "A journey webhook step could not complete.",
  },
  {
    match: /dispatch_pending_actions:inline:exit_flow|exit_flow/i,
    label: "Journey end step failed",
    variant: "danger",
    title: "A journey tried to end but the final step reported an issue.",
  },
  {
    match: /action_failed_permanent|failed_permanent/i,
    label: "Follow-up action failed",
    variant: "danger",
    title: "A follow-up action failed and may need review.",
  },
  {
    match: /team_alert/i,
    label: "Team alert issue",
    variant: "warning",
    title: "A team alert needs review.",
  },
  {
    match: /email_bounce|inbound_email_bounce|bounce_hard|hard bounce/i,
    label: "Email bounced",
    variant: "danger",
    title: "An outbound email bounced or created a suppression.",
  },
  {
    match: /engagement_cancel/i,
    label: "Engagement cancelled",
    variant: "neutral",
    title: "A follow-up path was cancelled.",
  },
  {
    match: /dispatcher_lock_expired|lock expired|locked_until/i,
    label: "Processing lock expired",
    variant: "warning",
    title: "A queued follow-up may have been held too long.",
  },
  {
    match: /journey not found|template not found|workflow not found/i,
    label: "Journey not found",
    variant: "danger",
    title: "The system could not find the journey referenced by this item.",
  },
  {
    match: /sql|database|postgres|supabase|relation .* does not exist/i,
    label: "System data issue",
    variant: "danger",
    title: "A database or data access error was logged.",
  },
];

const SEVERITY_VARIANTS: Record<string, StatusVariant> = {
  critical: "danger",
  error: "danger",
  warning: "warning",
};

const STATUS_LABELS: Record<string, [string, StatusVariant]> = {
  open: ["Open", "warning"],
  investigating: ["Investigating", "info"],
  resolved: ["Resolved", "success"],
  ignored: ["Ignored", "neutral"],
};

export function getErrorIssueDisplay(error: ErrorRow = {}): IssueDisplay {
  const haystack = [
    error.signature,
    error.workflow_name,
    error.node_name,
    error.error_message,
    error.sample_message,
  ].filter(Boolean).join(" ");
  const found = ISSUE_PATTERNS.find((entry) => entry.match.test(haystack));
  if (found) {
    return {
      label: found.label,
      variant: found.variant,
      title: found.title,
      rawValue: error.signature || error.error_message || error.sample_message,
    };
  }
  return {
    label: "Operational issue",
    variant: SEVERITY_VARIANTS[String(error.severity || "").toLowerCase()] || "warning",
    title: "A system issue was logged and may need review.",
    rawValue: error.signature || error.error_message || error.sample_message,
  };
}

// Provider/action failure explanations for the executions timeline. Maps the
// raw error_message stored on a failed action to a plain-language cause and a
// safe next step for the operator. Ordered: first match wins, most specific
// patterns first. Returns null when we have nothing better than the raw text.
const ACTION_FAILURE_PATTERNS: FailurePattern[] = [
  // --- Twilio SMS/voice error codes (before the generic suppression pattern:
  // 21610's provider text contains "unsubscribed") ---
  {
    match: /21610|blacklist|STOP.?keyword|attempt to send to unsubscribed/i,
    cause: "The recipient replied STOP to this number, so the carrier blocks further messages.",
    suggestion: "The lead must text START to the same number to re-subscribe. Do not attempt to contact them another way without consent.",
  },
  // --- Suppression / compliance (engine-side blocks) ---
  {
    match: /suppress|opt.?ed?.?out|do.?not.?contact|unsubscrib/i,
    cause: "The lead is suppressed (opted out or unsubscribed).",
    suggestion: "This is expected compliance behavior. Review the lead under Suppressions if you believe it's a mistake.",
  },
  {
    match: /21211|21614|invalid.{0,10}(phone|number)|not a valid phone/i,
    cause: "The lead's phone number is not a valid, reachable number.",
    suggestion: "Fix the phone number on the lead record, then re-enroll or retry.",
  },
  {
    match: /21608|unverified.{0,20}(number|caller)/i,
    cause: "The sending account is in trial mode and can only message verified numbers.",
    suggestion: "Upgrade the Twilio account or verify the recipient number in the Twilio console.",
  },
  {
    match: /21606|not a valid.{0,20}from|from.{0,15}not owned/i,
    cause: "The configured sender number is not owned by the connected Twilio account.",
    suggestion: "Check the sender configuration under Settings → Channels and pick a number that belongs to this account.",
  },
  {
    match: /30007|carrier.{0,20}(filter|block)|filtered/i,
    cause: "The carrier filtered this message as suspected spam.",
    suggestion: "Review the message content for spam triggers and check the sending number's reputation/registration (A2P 10DLC).",
  },
  {
    match: /30006|landline|incapable of receiving/i,
    cause: "The destination is a landline or a device that cannot receive SMS.",
    suggestion: "Use a call step for this lead, or correct the mobile number.",
  },
  {
    match: /30003|30005|unreachable|unknown.{0,10}(destination|handset)/i,
    cause: "The destination phone was unreachable or unknown when the message was sent.",
    suggestion: "The number may be off or deactivated. Verify the number; a retry may succeed if the phone was just offline.",
  },
  {
    match: /\b20003\b|authenticat/i,
    cause: "The messaging provider rejected the account credentials.",
    suggestion: "Reconnect or update the provider credentials under Settings → Channels. All sends on this channel will fail until fixed.",
  },
  // --- Email ---
  {
    match: /5\.1\.1|550|mailbox (not found|unavailable)|no such user|bounce_hard|hard bounce/i,
    cause: "The email address does not exist (hard bounce).",
    suggestion: "Correct the lead's email address. Repeated hard bounces damage sender reputation — the address was suppressed automatically.",
  },
  {
    match: /5\.7\.1|554|rejected.{0,20}spam|spam.{0,20}rejected|blocked.{0,30}spam/i,
    cause: "The recipient's mail server rejected the message as spam.",
    suggestion: "Review content and sending domain authentication (SPF/DKIM/DMARC) under Settings → Channels.",
  },
  {
    match: /invalid_grant|refresh.?token|token.{0,15}(expired|revoked)/i,
    cause: "The connected Google/OAuth mailbox authorization has expired or was revoked.",
    suggestion: "Reconnect the mailbox under Settings → Channels. All email sends from this sender will fail until reconnected.",
  },
  {
    match: /quota|daily.{0,10}limit|limit.{0,10}exceeded|429|rate.?limit/i,
    cause: "The sender hit its sending quota or rate limit.",
    suggestion: "Wait for the quota window to reset, or raise the sender's daily cap / add another sender under Settings → Channels.",
  },
  // --- Generic infrastructure ---
  {
    match: /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i,
    cause: "The provider or endpoint could not be reached in time.",
    suggestion: "Usually transient — a retry often succeeds. If it persists, check System Health and the provider's status page.",
  },
  {
    match: /\b(401|403)\b|unauthorized|forbidden|api key/i,
    cause: "The provider rejected the request as unauthorized.",
    suggestion: "Check the credentials for this channel under Settings → Channels.",
  },
  {
    match: /template.{0,15}not found|missing template/i,
    cause: "The step references a template that no longer exists.",
    suggestion: "Open the journey step and select an existing template, then save.",
  },
];

/**
 * Explain a failed action's error_message in operator terms.
 * Returns { cause, suggestion } or null when no pattern matches.
 */
export function explainActionFailure(errorMessage: unknown): FailureExplanation | null {
  const text = String(errorMessage || "");
  if (!text) return null;
  const found = ACTION_FAILURE_PATTERNS.find((p) => p.match.test(text));
  return found ? { cause: found.cause, suggestion: found.suggestion } : null;
}

export function getErrorStatusDisplay(status: unknown): { label: string; variant: StatusVariant; rawValue: unknown } {
  const [label, variant] = STATUS_LABELS[String(status || "").toLowerCase()] || ["Open", "warning"];
  return { label, variant, rawValue: status };
}

export function getErrorAffectedLabel(error: ErrorRow = {}): string {
  const journey = error.workflow_name || error.journey_name;
  const node = error.node_name || error.action_type;
  if (journey && node) return `${journey} · ${node}`;
  if (journey) return journey;
  if (node) return node;
  return "Not specified";
}

