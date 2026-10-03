// Shared validator + coercer for tenant custom_fields values.
// Single source of truth used by both /api/leads (server) and the leads modal (client).
//
// Schema field shape (matches /api/custom-fields):
// { id, key, label, type, required, options?, active? }
//
// Types: single_line | multi_line | number | date | boolean
//        dropdown | radio | multi_select | url | email | phone

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^https?:\/\/[^\s]+$/i
// Permissive phone: digits, +, spaces, dashes, parens. Length ≥ 7.
const PHONE_RE = /^[+()\-.\s\d]{7,}$/

function isEmptyValue(v) {
  if (v === null || v === undefined) return true
  if (typeof v === "string" && v.trim() === "") return true
  if (Array.isArray(v) && v.length === 0) return true
  return false
}

// Coerce one value according to type. Returns { ok, value, error }.
// `null`/empty → null (so DB stores null instead of "").
export function coerceValue(field, raw) {
  if (isEmptyValue(raw)) return { ok: true, value: null }

  switch (field.type) {
    case "single_line":
    case "multi_line":
      return { ok: true, value: String(raw) }

    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n)) return { ok: false, error: `"${field.label}" must be a number` }
      return { ok: true, value: n }
    }

    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw }
      const s = String(raw).trim().toLowerCase()
      if (["true", "1", "yes", "y", "on"].includes(s)) return { ok: true, value: true }
      if (["false", "0", "no", "n", "off"].includes(s)) return { ok: true, value: false }
      return { ok: false, error: `"${field.label}" must be true or false` }
    }

    case "date": {
      // Accept ISO strings and YYYY-MM-DD; store as ISO date (YYYY-MM-DD) if possible, else full ISO.
      const s = String(raw).trim()
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: true, value: s }
      const d = new Date(s)
      if (isNaN(d.getTime())) return { ok: false, error: `"${field.label}" is not a valid date` }
      return { ok: true, value: d.toISOString().slice(0, 10) }
    }

    case "email": {
      const s = String(raw).trim()
      if (!EMAIL_RE.test(s)) return { ok: false, error: `"${field.label}" is not a valid email address` }
      return { ok: true, value: s }
    }

    case "url": {
      const s = String(raw).trim()
      if (!URL_RE.test(s)) return { ok: false, error: `"${field.label}" must be a URL starting with http:// or https://` }
      return { ok: true, value: s }
    }

    case "phone": {
      const s = String(raw).trim()
      if (!PHONE_RE.test(s)) return { ok: false, error: `"${field.label}" is not a valid phone number` }
      return { ok: true, value: s }
    }

    case "dropdown":
    case "radio": {
      const s = String(raw)
      const opts = Array.isArray(field.options) ? field.options.map(String) : []
      if (opts.length && !opts.includes(s)) {
        return { ok: false, error: `"${field.label}" must be one of: ${opts.join(", ")}` }
      }
      return { ok: true, value: s }
    }

    case "multi_select": {
      const arr = Array.isArray(raw)
        ? raw
        : String(raw).split(",").map(x => x.trim()).filter(Boolean)
      const opts = Array.isArray(field.options) ? field.options.map(String) : []
      if (opts.length) {
        const bad = arr.filter(v => !opts.includes(String(v)))
        if (bad.length) return { ok: false, error: `"${field.label}" has invalid value(s): ${bad.join(", ")}` }
      }
      return { ok: true, value: arr.map(String) }
    }

    default:
      // Unknown type — store raw, don't break.
      return { ok: true, value: raw }
  }
}

/**
 * Validate + coerce every value in `values` against the tenant's `schema`.
 * Unknown keys (not in schema) are passed through unchanged — webhooks can drop
 * arbitrary properties before fields are formally defined.
 *
 * Returns:
 *   { ok: true,  value: <coerced object> }
 *   { ok: false, errors: { [fieldKey]: "message" } }
 */
export function validateAndCoerceCustomFields(values, schema) {
  const out = {}
  const errors = {}
  const active = (schema || []).filter(f => f && f.active !== false)
  const byKey = Object.fromEntries(active.map(f => [f.key, f]))

  // Pass through any keys not defined in schema (extra payload data from webhooks).
  if (values && typeof values === "object") {
    for (const [k, v] of Object.entries(values)) {
      if (!byKey[k]) out[k] = v
    }
  }

  for (const f of active) {
    const raw = values?.[f.key]
    if (isEmptyValue(raw)) {
      if (f.required) {
        errors[f.key] = `"${f.label}" is required`
      }
      // Don't store empty values — leave key absent so downstream merge-tag
      // resolution falls through to a clear empty string.
      continue
    }
    const r = coerceValue(f, raw)
    if (!r.ok) {
      errors[f.key] = r.error
    } else {
      out[f.key] = r.value
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, value: out }
}
