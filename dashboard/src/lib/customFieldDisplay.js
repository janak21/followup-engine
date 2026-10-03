const FIELD_TYPE_LABELS = {
  single_line: "Single line text",
  multi_line: "Multi-line text",
  number: "Number",
  date: "Date",
  boolean: "Toggle",
  dropdown: "Dropdown",
  radio: "Radio select",
  multi_select: "Multi-select",
  email: "Email",
  phone: "Phone",
  url: "URL",
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stringifyRecord(record) {
  if (!record) return ""
  try {
    return JSON.stringify(record)
  } catch {
    return String(record)
  }
}

export function getCustomFieldTypeDisplay(type) {
  const raw = String(type || "").trim()
  return {
    label: FIELD_TYPE_LABELS[raw] || raw.replace(/_/g, " ") || "Unknown type",
    rawValue: raw,
  }
}

export function getCustomFieldMergeTag(fieldOrKey) {
  const key = typeof fieldOrKey === "string" ? fieldOrKey : fieldOrKey?.key
  return `{{${String(key || "").trim()}}}`
}

export function textReferencesCustomField(text, fieldOrKey) {
  const key = typeof fieldOrKey === "string" ? fieldOrKey : fieldOrKey?.key
  const normalizedKey = String(key || "").trim()
  if (!normalizedKey) return false

  const escaped = escapeRegex(normalizedKey)
  const patterns = [
    new RegExp(`{{\\s*${escaped}\\s*}}`, "i"),
    new RegExp(`{{\\s*custom\\.${escaped}\\s*}}`, "i"),
    new RegExp(`(^|[^a-zA-Z0-9_])custom\\.${escaped}([^a-zA-Z0-9_]|$)`, "i"),
  ]

  return patterns.some((pattern) => pattern.test(String(text || "")))
}

export function getCustomFieldUsageSummary(field, sources = {}) {
  const templates = Array.isArray(sources.templates) ? sources.templates : []
  const journeys = Array.isArray(sources.journeys) ? sources.journeys : []
  const checked = sources.checked === true

  if (!checked) {
    return {
      checked: false,
      templateCount: 0,
      journeyCount: 0,
      total: 0,
      label: "Usage not checked",
      detail: "Usage has not been fully checked.",
    }
  }

  const templateCount = templates.filter((template) => {
    const haystack = [
      template.subject,
      template.body,
      template.notes,
      stringifyRecord(template.variables),
    ].join("\n")
    return textReferencesCustomField(haystack, field)
  }).length

  const journeyCount = journeys.filter((journey) => {
    const haystack = stringifyRecord(journey.spec)
    return textReferencesCustomField(haystack, field)
  }).length

  const parts = []
  if (templateCount > 0) parts.push(`${templateCount} ${templateCount === 1 ? "template" : "templates"}`)
  if (journeyCount > 0) parts.push(`${journeyCount} ${journeyCount === 1 ? "journey" : "journeys"}`)

  return {
    checked: true,
    templateCount,
    journeyCount,
    total: templateCount + journeyCount,
    label: parts.length ? `Used in ${parts.join(", ")}` : "No references found",
    detail: parts.length
      ? `This field appears in ${parts.join(" and ")}.`
      : "No template or journey references were found in loaded data.",
  }
}
