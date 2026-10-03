export const BULK_ENROLL_STATUSES = {
  ENROLLED: "enrolled",
  READY: "ready",
  SKIPPED_ALREADY_ACTIVE: "skipped_already_active",
  SKIPPED_OPTED_OUT: "skipped_opted_out",
  SKIPPED_SUPPRESSED: "skipped_suppressed",
  SKIPPED_MISSING_CONTACT: "skipped_missing_contact",
  FAILED: "failed",
};

export function normalizeLeadIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

export function getFirstJourneyStep(journey) {
  const steps = Array.isArray(journey?.spec?.steps) ? journey.spec.steps : [];
  return steps.find((step) => Number(step?.index) === 0) || steps[0] || null;
}

export function getStepContactRequirement(step) {
  const type = String(step?.type || "").toLowerCase();
  if (type === "email" || type === "ai_reply") return "email";
  if (type === "sms" || type === "call") return "phone";
  return null;
}

export function buildBulkEnrollIdempotencyKey(leadId, journeyKey) {
  return `${leadId}:${journeyKey}:0:bulk_enroll`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").trim();
}

export function buildSuppressionLookup(suppressions = []) {
  const byLeadId = new Set();
  const byEmail = new Set();
  const byPhone = new Set();

  for (const row of suppressions || []) {
    if (row?.lead_id) byLeadId.add(String(row.lead_id));
    const email = normalizeEmail(row?.email);
    const phone = normalizePhone(row?.phone_e164);
    if (email) byEmail.add(email);
    if (phone) byPhone.add(phone);
  }

  return { byLeadId, byEmail, byPhone };
}

export function isLeadSuppressed(lead, suppressionLookup) {
  if (!lead || !suppressionLookup) return false;
  const email = normalizeEmail(lead.email);
  const phone = normalizePhone(lead.phone_e164 || lead.phone_raw);
  return suppressionLookup.byLeadId.has(String(lead.id))
    || (email && suppressionLookup.byEmail.has(email))
    || (phone && suppressionLookup.byPhone.has(phone));
}

export function getBulkEnrollEligibility(lead, journey, suppressionLookup = buildSuppressionLookup(), activeJourneyKeys = new Set()) {
  if (!lead) {
    return {
      status: BULK_ENROLL_STATUSES.FAILED,
      reason: "Lead was not found for this tenant.",
    };
  }

  const step0 = getFirstJourneyStep(journey);
  if (!step0) {
    return {
      status: BULK_ENROLL_STATUSES.FAILED,
      reason: "Selected journey has no first step.",
    };
  }

  if (lead.opt_out || lead.journey_status === "opted_out") {
    return {
      status: BULK_ENROLL_STATUSES.SKIPPED_OPTED_OUT,
      reason: "Lead is opted out.",
    };
  }

  if (activeJourneyKeys.has(journey?.journey_key)) {
    return {
      status: BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE,
      reason: "Lead already has a running enrollment in this journey.",
    };
  }

  if (isLeadSuppressed(lead, suppressionLookup)) {
    return {
      status: BULK_ENROLL_STATUSES.SKIPPED_SUPPRESSED,
      reason: "Lead has a matching suppression.",
    };
  }

  const requiredContact = getStepContactRequirement(step0);
  if (requiredContact === "email" && !normalizeEmail(lead.email)) {
    return {
      status: BULK_ENROLL_STATUSES.SKIPPED_MISSING_CONTACT,
      reason: "First journey step requires an email address.",
    };
  }
  if (requiredContact === "phone" && !normalizePhone(lead.phone_e164 || lead.phone_raw)) {
    return {
      status: BULK_ENROLL_STATUSES.SKIPPED_MISSING_CONTACT,
      reason: "First journey step requires a phone number.",
    };
  }

  return {
    status: BULK_ENROLL_STATUSES.READY,
    reason: "Ready to enroll.",
    step0,
  };
}

export function summarizeBulkEnrollResults(results = []) {
  const summary = {
    selected: results.length,
    ready: 0,
    enrolled: 0,
    skipped_already_active: 0,
    skipped_opted_out: 0,
    skipped_suppressed: 0,
    skipped_missing_contact: 0,
    failed: 0,
  };

  for (const result of results) {
    if (Object.prototype.hasOwnProperty.call(summary, result.status)) {
      summary[result.status] += 1;
    } else if (result.status === BULK_ENROLL_STATUSES.READY) {
      summary.ready += 1;
    }
  }

  return summary;
}

export function planBulkEnroll({ requestedLeadIds = [], leads = [], journey = null, suppressions = [], activeRunsByLeadId = new Map() } = {}) {
  const leadById = new Map((leads || []).map((lead) => [String(lead.id), lead]));
  const suppressionLookup = buildSuppressionLookup(suppressions);

  const results = requestedLeadIds.map((leadId) => {
    const lead = leadById.get(String(leadId));
    const activeJourneyKeys = activeRunsByLeadId.get(String(leadId)) || new Set();
    const eligibility = getBulkEnrollEligibility(lead, journey, suppressionLookup, activeJourneyKeys);
    return {
      lead_id: String(leadId),
      status: eligibility.status,
      reason: eligibility.reason,
      action_type: eligibility.step0?.type || null,
    };
  });

  return {
    results,
    summary: summarizeBulkEnrollResults(results),
  };
}
