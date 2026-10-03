// Field catalog for the Condition Split builder.
// Each entry declares the lead-side field, what input control to render for its value,
// and which operators are valid.
//
// To add a new field a user can branch on: add an entry here. The condition spec saved
// on a step is { combinator: 'and'|'or', rules: [{ field, op, value }, ...] } — the engine's
// evaluate_condition() RPC handles all the field-resolution logic in SQL.

// Operator presets shared by primitive types.
const STRING_OPS = [
  { id: "equals",        label: "Equals" },
  { id: "not_equals",    label: "Does not equal" },
  { id: "contains",      label: "Contains" },
  { id: "not_contains",  label: "Does not contain" },
  { id: "is_empty",      label: "Is empty",      noValue: true },
  { id: "is_not_empty",  label: "Is not empty",  noValue: true },
];

const NUMBER_OPS = [
  { id: "equals",     label: "Equals" },
  { id: "not_equals", label: "Does not equal" },
  { id: "gt",         label: "Greater than" },
  { id: "lt",         label: "Less than" },
  { id: "gte",        label: "Greater than or equal" },
  { id: "lte",        label: "Less than or equal" },
];

const BOOLEAN_OPS = [
  { id: "is_true",  label: "Is true",  noValue: true },
  { id: "is_false", label: "Is false", noValue: true },
];

const ENUM_OPS = [
  { id: "equals",     label: "Equals" },
  { id: "not_equals", label: "Does not equal" },
];

const TAGS_OPS = [
  { id: "includes",      label: "Includes" },
  { id: "excludes",      label: "Excludes" },
  { id: "includes_any",  label: "Includes any of" },
  { id: "includes_all",  label: "Includes all of" },
  { id: "is_empty",      label: "Has no tags",     noValue: true },
  { id: "is_not_empty",  label: "Has any tag",     noValue: true },
];

export const CONDITION_FIELDS = [
  {
    key: "tags",
    label: "Tags",
    valueType: "tag",
    operators: TAGS_OPS,
    group: "Lifecycle",
  },
  {
    key: "journey_status",
    label: "Journey status",
    valueType: "enum",
    options: ["new", "active", "paused", "responded", "callback_booked", "opted_out", "completed", "error"],
    operators: ENUM_OPS,
    group: "Lifecycle",
  },
  {
    key: "responded",
    label: "Has responded",
    valueType: "boolean",
    operators: BOOLEAN_OPS,
    group: "Lifecycle",
  },
  {
    key: "opt_out",
    label: "Has opted out",
    valueType: "boolean",
    operators: BOOLEAN_OPS,
    group: "Lifecycle",
  },
  {
    key: "callback_requested",
    label: "Callback requested",
    valueType: "boolean",
    operators: BOOLEAN_OPS,
    group: "Lifecycle",
  },
  {
    key: "email_conversation_count",
    label: "Email conversation count",
    valueType: "number",
    operators: NUMBER_OPS,
    group: "Engagement",
  },
  {
    key: "sms_conversation_count",
    label: "SMS conversation count",
    valueType: "number",
    operators: NUMBER_OPS,
    group: "Engagement",
  },
  {
    key: "current_step",
    label: "Current step index",
    valueType: "number",
    operators: NUMBER_OPS,
    group: "Engagement",
  },
  {
    key: "email",
    label: "Email address",
    valueType: "string",
    operators: STRING_OPS,
    group: "Identity",
  },
  {
    key: "first_name",
    label: "First name",
    valueType: "string",
    operators: STRING_OPS,
    group: "Identity",
  },
  {
    key: "last_name",
    label: "Last name",
    valueType: "string",
    operators: STRING_OPS,
    group: "Identity",
  },
  {
    key: "phone_e164",
    label: "Phone (E.164)",
    valueType: "string",
    operators: STRING_OPS,
    group: "Identity",
  },
  {
    key: "state",
    label: "State",
    valueType: "string",
    operators: STRING_OPS,
    group: "Identity",
  },
  {
    key: "zip_code",
    label: "ZIP code",
    valueType: "string",
    operators: STRING_OPS,
    group: "Identity",
  },
  {
    key: "campaign_type",
    label: "Enrollment Type",
    valueType: "string",
    operators: STRING_OPS,
    group: "Identity",
  },
  {
    key: "__custom__",
    label: "Custom field…",
    valueType: "custom",
    operators: STRING_OPS, // default; the user picks a real op after typing the key
    group: "Custom",
  },
];

// Build an empty condition rule of the requested field
export function newRule(fieldKey = "tags") {
  const field = CONDITION_FIELDS.find(f => f.key === fieldKey) || CONDITION_FIELDS[0];
  const firstOp = field.operators[0]?.id || "equals";
  return { field: fieldKey, op: firstOp, value: "" };
}

export function getFieldConfig(fieldKey) {
  if (!fieldKey) return null;
  if (fieldKey.startsWith("custom.")) {
    return { key: fieldKey, label: fieldKey, valueType: "string", operators: STRING_OPS, group: "Custom" };
  }
  if (
    fieldKey === "$json" ||
    fieldKey.startsWith("$json.") ||
    fieldKey === "payload" ||
    fieldKey.startsWith("payload.") ||
    fieldKey === "context" ||
    fieldKey.startsWith("context.")
  ) {
    return { key: fieldKey, label: fieldKey, valueType: "string", operators: STRING_OPS, group: "Webhook payload" };
  }
  return CONDITION_FIELDS.find(f => f.key === fieldKey) || null;
}
