const STATUS_CLASS = {
  healthy: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/35",
  limited: "bg-blue-500/15 text-blue-800 dark:text-blue-300 border-blue-500/35",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40",
  danger: "bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/40",
  neutral: "bg-zinc-500/15 text-zinc-800 dark:text-zinc-200 border-zinc-500/35",
};

export const SENDER_HEALTH_OPTIONS = [
  { value: "green", label: "Healthy" },
  { value: "yellow", label: "Limited" },
  { value: "red", label: "Needs review" },
];

export const SENDER_POOL_OPTIONS = [
  { value: "warming", label: "Warming" },
  { value: "active", label: "Ready" },
  { value: "paused", label: "Paused" },
  { value: "burnt", label: "Needs review" },
];

export function getSenderHealthDisplay(sender = {}) {
  const sentToday = Number(sender.sent_today || 0);
  const dailyLimit = Number(sender.daily_limit || 0);
  // Prefer the server-derived boolean the API now emits. Fall back to
  // google_connected_at / google_refresh_token for back-compat with older
  // cached rows that predate the derived flag.
  const connected =
    sender.google_connected === true ||
    Boolean(sender.google_connected_at || sender.google_refresh_token);
  const pausedUntil = sender.pause_until ? new Date(sender.pause_until).getTime() : 0;
  const pausedByTime = Number.isFinite(pausedUntil) && pausedUntil > Date.now();

  if (!sender.active || sender.warmup_stage === "paused" || pausedByTime) {
    return display(
      "Paused",
      "neutral",
      pausedByTime ? `Paused until ${formatDateTime(sender.pause_until)}.` : "Paused manually.",
      { canSendToday: false, connected, sentToday, dailyLimit }
    );
  }

  if (!connected) {
    return display("Disconnected", "danger", "Connect Google before this sender can send.", {
      canSendToday: false,
      connected,
      sentToday,
      dailyLimit,
    });
  }

  if (dailyLimit > 0 && sentToday >= dailyLimit) {
    return display("At daily limit", "warning", "Daily sending limit reached.", {
      canSendToday: false,
      connected,
      sentToday,
      dailyLimit,
    });
  }

  if (sender.health_status === "red" || sender.warmup_stage === "burnt" || sender.last_error || sender.gmail_poll_error) {
    return display("Needs review", "danger", sender.last_error || sender.gmail_poll_error || "Sender is marked for review.", {
      canSendToday: true,
      connected,
      sentToday,
      dailyLimit,
    });
  }

  if (sender.health_status === "yellow" || sender.warmup_stage === "warming") {
    return display("Limited", "limited", "Sender is available, but sending should stay conservative.", {
      canSendToday: true,
      connected,
      sentToday,
      dailyLimit,
    });
  }

  if (sender.health_status === "green" && sender.active) {
    return display("Healthy", "healthy", "Connected and available to send.", {
      canSendToday: true,
      connected,
      sentToday,
      dailyLimit,
    });
  }

  return display("Unknown", "neutral", "Connection and health status are not fully verified.", {
    canSendToday: connected,
    connected,
    sentToday,
    dailyLimit,
  });
}

export function getSenderStatusClass(variant) {
  return STATUS_CLASS[variant] || STATUS_CLASS.neutral;
}

export function getSenderUsageLabel(sender = {}) {
  const sentToday = Number(sender.sent_today || 0);
  const dailyLimit = Number(sender.daily_limit || 0);
  return dailyLimit > 0 ? `${sentToday} / ${dailyLimit} sent today` : `${sentToday} sent today`;
}

function display(label, variant, reason, details = {}) {
  return {
    label,
    variant,
    reason,
    ...details,
  };
}

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
