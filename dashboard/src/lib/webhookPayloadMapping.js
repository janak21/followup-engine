export const LEAD_MAPPING_TARGETS = [
  { value: "first_name", label: "Lead first name" },
  { value: "last_name", label: "Lead last name" },
  { value: "email", label: "Lead email" },
  { value: "phone", label: "Lead phone" },
  { value: "source", label: "Lead source" },
  { value: "custom", label: "Custom field" },
  { value: "variable", label: "Journey variable" },
];

export function joinPayloadPath(parent, key, isArrayIndex = false) {
  if (!parent) return isArrayIndex ? `[${key}]` : String(key);
  return isArrayIndex ? `${parent}[${key}]` : `${parent}.${key}`;
}

export function toWorkflowPayloadSource(path) {
  let clean = String(path || "").trim();
  if (clean.match(/^\{\{[\s\S]*\}\}$/)) {
    clean = clean.slice(2, -2).trim();
  }
  if (clean.startsWith("$json.")) {
    clean = `payload.${clean.slice(6)}`;
  } else if (clean === "$json") {
    clean = "payload";
  }
  if (!clean) return "payload";
  if (clean === "payload" || clean.startsWith("payload.")) return clean;
  if (clean.startsWith("payload[")) return clean;
  return `payload.${clean}`;
}

export function flattenPayloadScalars(value, path = "") {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return [{ path, source: toWorkflowPayloadSource(path), value, type: value === null ? "null" : typeof value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenPayloadScalars(item, joinPayloadPath(path, index, true)));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => flattenPayloadScalars(child, joinPayloadPath(path, key)));
  }

  return [];
}

export function normalizeCustomKey(label) {
  const key = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "webhook_value";
}

export function suggestLeadDestination(label) {
  const normalized = String(label || "").toLowerCase();
  if (/\b(consent|agree|agreement|permission|terms|privacy|checking this box|checkbox)\b/.test(normalized)) {
    return `custom.${normalizeCustomKey(label)}`;
  }
  if (/\b(e-?mail|email address)\b/.test(normalized)) return "email";
  if (/\b(phone|mobile|cell|telephone)\b/.test(normalized)) return "phone";
  if (/\b(first name|given name)\b/.test(normalized)) return "first_name";
  if (/\b(last name|surname|family name)\b/.test(normalized)) return "last_name";
  if (/\b(source|utm source|lead source)\b/.test(normalized)) return "source";
  if (/\b(full name|name)\b/.test(normalized)) return "first_name";
  return `custom.${normalizeCustomKey(label)}`;
}

function fieldLabel(field, fallback) {
  return field?.label || field?.title || field?.question || field?.text || field?.key || field?.name || field?.id || fallback;
}

function looksLikeFieldObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "value") &&
    fieldLabel(value, null)
  );
}

export function getDetectedPayloadFieldRows(payload) {
  const groups = [];

  function walk(value, path = "") {
    if (Array.isArray(value)) {
      const fieldRows = value
        .map((field, index) => ({ field, index }))
        .filter(({ field }) => looksLikeFieldObject(field));

      if (fieldRows.length > 0) {
        groups.push(...fieldRows.map(({ field, index }) => {
          const label = fieldLabel(field, `Field ${index + 1}`);
          const valuePath = joinPayloadPath(joinPayloadPath(path, index, true), "value");
          return {
            index,
            label: String(label),
            value: field.value,
            path: valuePath,
            source: toWorkflowPayloadSource(valuePath),
            suggestedDestination: suggestLeadDestination(label),
            field,
          };
        }));
      }

      value.forEach((item, index) => walk(item, joinPayloadPath(path, index, true)));
      return;
    }

    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => walk(child, joinPayloadPath(path, key)));
    }
  }

  walk(payload);

  // Generic-JSON fallback: when the payload has no form-builder style field
  // arrays (Tally/Typeform), expose every scalar leaf as a mappable row so
  // plain webhooks ({ "email": "...", "meta": { "source": "..." } }) are just
  // as usable as form payloads.
  if (groups.length === 0) {
    const scalars = flattenPayloadScalars(payload).filter((row) => row.path);
    groups.push(...scalars.slice(0, 40).map((row, index) => {
      const lastSegment = String(row.path).split(".").pop().replace(/\[\d+\]/g, "");
      const label = lastSegment.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
      return {
        index,
        label,
        value: row.value,
        path: row.path,
        source: row.source,
        suggestedDestination: suggestLeadDestination(label),
        field: null,
      };
    }));
  }

  const seen = new Set();
  return groups.filter((row) => {
    if (seen.has(row.source)) return false;
    seen.add(row.source);
    return true;
  });
}

export function mergeWorkflowFieldMapping(fieldMappings, destination, source) {
  const cleanDestination = String(destination || "").trim();
  const cleanSource = toWorkflowPayloadSource(source);
  if (!cleanDestination || !cleanSource) {
    return Array.isArray(fieldMappings) ? fieldMappings : [];
  }

  const mappings = Array.isArray(fieldMappings) ? fieldMappings : [];
  const nextMapping = { destination: cleanDestination, source: { source: cleanSource } };

  if (mappings.some((mapping) => mapping.destination === cleanDestination)) {
    return mappings.map((mapping) =>
      mapping.destination === cleanDestination ? { ...mapping, ...nextMapping } : mapping
    );
  }

  return [...mappings, nextMapping];
}
