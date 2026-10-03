const INTENT_DISPLAYS = {
  positive: {
    label: "Interested / positive",
    description: "Lead sounds interested or receptive.",
  },
  negative: {
    label: "Not interested",
    description: "Lead says they are not interested or declines.",
  },
  question: {
    label: "Question",
    description: "Lead asks a straightforward question.",
  },
  objection: {
    label: "Objection",
    description: "Lead raises a concern that may need judgment.",
  },
  out_of_office: {
    label: "Out of office",
    description: "Reply appears to be an out-of-office message.",
  },
  complex: {
    label: "Complex or multi-part question",
    description: "Lead asks something nuanced, unclear, or multi-step.",
  },
  unsubscribe: {
    label: "Opt-out request",
    description: "Lead asks to stop, unsubscribe, or not be contacted.",
  },
  auto_reply: {
    label: "Auto-reply",
    description: "Reply appears automated, like a vacation or system response.",
  },
  meeting_request: {
    label: "Meeting or callback request",
    description: "Lead asks to meet, talk, or be called back.",
  },
  pricing_question: {
    label: "Pricing question",
    description: "Lead asks about price, coverage, plans, or costs.",
  },
  other: {
    label: "Unclear intent",
    description: "The reply does not fit a clearer category.",
  },
};

export const AI_AGENT_INTENT_OPTIONS = [
  "positive",
  "negative",
  "question",
  "objection",
  "out_of_office",
  "complex",
  "unsubscribe",
  "auto_reply",
  "meeting_request",
  "pricing_question",
  "other",
].map((value) => ({ value, ...INTENT_DISPLAYS[value] }));

export const AI_AGENT_ESCALATION_EXAMPLES = [
  { quote: "Can you explain pricing and coverage?", label: "Pricing question" },
  { quote: "Call me tomorrow afternoon.", label: "Meeting or callback request" },
  { quote: "Stop texting me.", label: "Opt-out request" },
  { quote: "I'm confused. Can a person help?", label: "Complex or multi-part question" },
];

export function getAiAgentIntentDisplay(value) {
  const key = String(value || "").toLowerCase();
  return {
    label: INTENT_DISPLAYS[key]?.label || humanizeIntent(value || "other"),
    description: INTENT_DISPLAYS[key]?.description || "Lead reply category.",
    rawValue: value,
  };
}

function humanizeIntent(value) {
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
