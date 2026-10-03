const PROTECTED_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "journey_status",
  "current_step",
  "opt_out",
  "responded",
  "assigned_sender_id",
  "email_thread_id",
  "last_email_message_id",
  "last_action_at",
  "next_action_at",
  "source_batch_id",
]);

const SYSTEM_FIELDS = [
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "full_name", label: "Full name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "source", label: "Source" },
  { value: "notes", label: "Notes" },
  { value: "raw.company", label: "Company" },
];

const AUTO_MAP = new Map([
  ["first_name", "first_name"],
  ["firstname", "first_name"],
  ["first", "first_name"],
  ["given_name", "first_name"],
  ["given", "first_name"],
  ["last_name", "last_name"],
  ["lastname", "last_name"],
  ["last", "last_name"],
  ["surname", "last_name"],
  ["family_name", "last_name"],
  ["full_name", "full_name"],
  ["name", "full_name"],
  ["contact_name", "full_name"],
  ["email", "email"],
  ["email_address", "email"],
  ["e_mail", "email"],
  ["mail", "email"],
  ["phone", "phone"],
  ["phone_number", "phone"],
  ["mobile", "phone"],
  ["mobile_phone", "phone"],
  ["cell_phone", "phone"],
  ["cell", "phone"],
  ["company", "raw.company"],
  ["business", "raw.company"],
  ["organization", "raw.company"],
  ["source", "source"],
  ["lead_source", "source"],
  ["notes", "notes"],
  ["note", "notes"],
]);

export const DO_NOT_IMPORT = "__skip";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (inQuotes) {
    throw new Error("CSV appears malformed: an open quoted field was not closed.");
  }

  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((v) => String(v || "").trim() !== ""));
}

export function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizePhone(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("+")) return value;
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return value;
}

export function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: "", last_name: "" };
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

export function parseCsvDocument(text) {
  const parsed = parseCsv(text);
  if (parsed.length < 2) {
    throw new Error("CSV must contain a header row and at least one lead row.");
  }

  const headers = parsed[0].map((header, index) => ({
    index,
    header: String(header || "").trim(),
    normalized: normalizeHeader(header),
  }));

  const rows = parsed.slice(1).map((values, rowIndex) => {
    const cells = {};
    headers.forEach((h, i) => {
      cells[h.normalized || `column_${i + 1}`] = String(values[i] || "").trim();
    });
    return { rowNumber: rowIndex + 2, cells };
  });

  return { headers, rows };
}

export function mappingOptions(customFields = []) {
  const custom = (customFields || [])
    .filter((field) => field && field.active !== false && field.key)
    .map((field) => ({
      value: `custom.${field.key}`,
      label: field.label || field.key,
      group: "Custom fields",
    }));

  return [
    { value: DO_NOT_IMPORT, label: "Do not import", group: "Import" },
    ...SYSTEM_FIELDS.map((field) => ({ ...field, group: "Lead fields" })),
    ...custom,
  ];
}

export function autoMapColumns(headers, customFields = []) {
  const customByHeader = new Map();
  for (const field of customFields || []) {
    if (!field?.key || field.active === false) continue;
    customByHeader.set(normalizeHeader(field.key), `custom.${field.key}`);
    customByHeader.set(normalizeHeader(field.label), `custom.${field.key}`);
  }

  const used = new Set();
  const mappings = {};

  for (const header of headers) {
    const key = header.normalized || `column_${header.index + 1}`;
    let mapped = AUTO_MAP.get(header.normalized) || customByHeader.get(header.normalized) || DO_NOT_IMPORT;
    if (PROTECTED_FIELDS.has(header.normalized)) mapped = DO_NOT_IMPORT;
    if (mapped !== DO_NOT_IMPORT && used.has(mapped)) mapped = DO_NOT_IMPORT;
    if (mapped !== DO_NOT_IMPORT) used.add(mapped);
    mappings[key] = mapped;
  }

  return mappings;
}

export function sampleValuesForHeaders(headers, rows, limit = 3) {
  const samples = {};
  for (const header of headers) {
    const key = header.normalized || `column_${header.index + 1}`;
    samples[key] = rows
      .map((row) => row.cells[key])
      .filter((value) => String(value || "").trim() !== "")
      .slice(0, limit);
  }
  return samples;
}

export function isProtectedMapping(value) {
  if (!value || value === DO_NOT_IMPORT) return false;
  if (PROTECTED_FIELDS.has(value)) return true;
  return value.startsWith("raw.") && PROTECTED_FIELDS.has(value.slice(4));
}

export function buildLeadDraft(row, mappings, { batchId = null, campaignType = "csv_import" } = {}) {
  const draft = {
    first_name: "",
    last_name: "",
    email: null,
    phone_raw: null,
    phone_e164: null,
    source: "CSV Import",
    custom_fields: {},
    raw_payload: {
      source: "csv_import",
      campaign_type: campaignType,
      row_number: row.rowNumber,
      row: row.cells,
    },
  };

  if (batchId) draft.source_batch_id = batchId;

  for (const [columnKey, target] of Object.entries(mappings || {})) {
    if (!target || target === DO_NOT_IMPORT || isProtectedMapping(target)) continue;
    const value = String(row.cells[columnKey] || "").trim();
    if (!value) continue;

    if (target === "first_name") draft.first_name = value;
    else if (target === "last_name") draft.last_name = value;
    else if (target === "full_name") {
      const split = splitName(value);
      if (!draft.first_name) draft.first_name = split.first_name;
      if (!draft.last_name) draft.last_name = split.last_name;
    } else if (target === "email") draft.email = value.toLowerCase();
    else if (target === "phone") {
      draft.phone_raw = value;
      draft.phone_e164 = normalizePhone(value);
    } else if (target === "source") draft.source = value;
    else if (target === "notes") draft.raw_payload.notes = value;
    else if (target.startsWith("custom.")) draft.custom_fields[target.slice(7)] = value;
    else if (target.startsWith("raw.")) draft.raw_payload[target.slice(4)] = value;
  }

  return draft;
}

export function rowContactKey(draft) {
  if (draft.email) return { type: "email", value: draft.email };
  if (draft.phone_e164) return { type: "phone", value: draft.phone_e164 };
  return null;
}

export function validateDraft(row, draft) {
  const errors = [];
  if (!draft.email && !draft.phone_e164) errors.push("Missing email or phone.");
  return errors.map((error) => ({ row: row.rowNumber, error }));
}

export function mergeLeadForMode(existing, draft, mode) {
  if (!existing) return draft;
  const allowed = ["first_name", "last_name", "email", "phone_raw", "phone_e164", "source"];
  const next = {};

  if (mode === "update_missing") {
    for (const key of allowed) {
      if ((existing[key] === null || existing[key] === undefined || existing[key] === "") && draft[key]) {
        next[key] = draft[key];
      }
    }
    const mergedCustom = { ...(existing.custom_fields || {}) };
    for (const [key, value] of Object.entries(draft.custom_fields || {})) {
      if (mergedCustom[key] === null || mergedCustom[key] === undefined || mergedCustom[key] === "") {
        mergedCustom[key] = value;
      }
    }
    next.custom_fields = mergedCustom;
    next.raw_payload = { ...(existing.raw_payload || {}), import_update: draft.raw_payload };
    return next;
  }

  if (mode === "overwrite") {
    for (const key of allowed) {
      if (draft[key] !== undefined) next[key] = draft[key];
    }
    next.custom_fields = { ...(existing.custom_fields || {}), ...(draft.custom_fields || {}) };
    next.raw_payload = { ...(existing.raw_payload || {}), import_update: draft.raw_payload };
    return next;
  }

  return null;
}

export function planImportRows(rows, mappings, existingLeads = [], options = {}) {
  const mode = options.duplicateMode || "skip";
  const existingByEmail = new Map();
  const existingByPhone = new Map();
  for (const lead of existingLeads || []) {
    if (lead.email) existingByEmail.set(String(lead.email).toLowerCase(), lead);
    if (lead.phone_e164) existingByPhone.set(String(lead.phone_e164), lead);
  }

  const seen = new Set();
  const result = {
    creates: [],
    updates: [],
    skipped: [],
    errors: [],
  };

  for (const row of rows) {
    const draft = buildLeadDraft(row, mappings, options);
    const errors = validateDraft(row, draft);
    if (errors.length) {
      result.errors.push(...errors);
      continue;
    }

    const contact = rowContactKey(draft);
    const dedupeKey = `${contact.type}:${contact.value}`;
    if (seen.has(dedupeKey)) {
      result.skipped.push({ row: row.rowNumber, reason: "Duplicate within this CSV.", duplicate: true });
      continue;
    }
    seen.add(dedupeKey);

    const existing = contact.type === "email"
      ? existingByEmail.get(contact.value)
      : existingByPhone.get(contact.value);

    if (!existing) {
      result.creates.push({ row: row.rowNumber, draft });
    } else if (mode === "skip") {
      result.skipped.push({ row: row.rowNumber, reason: "Existing lead matched.", lead_id: existing.id, duplicate: true });
    } else {
      result.updates.push({ row: row.rowNumber, lead_id: existing.id, draft: mergeLeadForMode(existing, draft, mode) });
    }
  }

  return result;
}
