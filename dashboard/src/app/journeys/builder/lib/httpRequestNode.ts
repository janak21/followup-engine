// Pure helpers for the Send webhook / HTTP request node UI.
//
// All of these operate TEXTUALLY on the URL/header values because they must
// tolerate unresolved merge tokens ({{lead.email}}, {{payload.x}}) that would
// break new URL() parsing and must never be percent-encoded (the runtime
// resolves them after these strings are stored).

export interface QueryParam {
  key: string
  value: string
}

export interface HttpAuth {
  type: "none" | "bearer" | "basic" | "custom"
  token?: string      // bearer
  username?: string   // basic
  password?: string   // basic
  raw?: string        // custom — the full Authorization header value
}

// Percent-encode a query key/value while leaving {{...}} tokens untouched so
// the runtime can resolve them. Only the characters that would corrupt the
// query-string structure are encoded.
export function encodeQueryPart(part: string): string {
  return String(part ?? "").replace(/\{\{[^}]*\}\}|[&=#+?]| /g, (m) => {
    if (m.startsWith("{{")) return m
    if (m === " ") return "%20"
    return encodeURIComponent(m)
  })
}

function decodeQueryPart(part: string): string {
  try {
    return decodeURIComponent(String(part ?? "").replace(/\+/g, "%20"))
  } catch {
    return String(part ?? "")
  }
}

// Split a URL into { base, params } without new URL(): tokens in the host or
// path must not break editing. The fragment (#...) is preserved on the base.
export function parseUrlQuery(url: string): { base: string; params: QueryParam[] } {
  const raw = String(url ?? "")
  const qIndex = raw.indexOf("?")
  if (qIndex === -1) return { base: raw, params: [] }
  const base = raw.slice(0, qIndex)
  let query = raw.slice(qIndex + 1)
  let fragment = ""
  const hashIndex = query.indexOf("#")
  if (hashIndex !== -1) {
    fragment = query.slice(hashIndex)
    query = query.slice(0, hashIndex)
  }
  const params = query
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const eq = pair.indexOf("=")
      if (eq === -1) return { key: decodeQueryPart(pair), value: "" }
      return { key: decodeQueryPart(pair.slice(0, eq)), value: decodeQueryPart(pair.slice(eq + 1)) }
    })
  return { base: base + fragment, params }
}

// Rebuild the URL from base + params. Empty-key rows are dropped; a fragment
// on the base stays at the end of the final URL.
export function setUrlQuery(base: string, params: QueryParam[]): string {
  let cleanBase = String(base ?? "")
  let fragment = ""
  const hashIndex = cleanBase.indexOf("#")
  if (hashIndex !== -1) {
    fragment = cleanBase.slice(hashIndex)
    cleanBase = cleanBase.slice(0, hashIndex)
  }
  const query = (params || [])
    .filter((p) => String(p.key ?? "").trim() !== "")
    .map((p) => `${encodeQueryPart(p.key)}=${encodeQueryPart(p.value)}`)
    .join("&")
  return cleanBase + (query ? `?${query}` : "") + fragment
}

// ---------------------------------------------------------------------------
// Auth <-> Authorization header. The runtime only knows headers, so auth is
// pure sugar over http_headers.Authorization — one source of truth.
// ---------------------------------------------------------------------------

function findAuthKey(headers: Record<string, string>): string | null {
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === "authorization") return key
  }
  return null
}

export function getAuthFromHeaders(headers: Record<string, string> = {}): HttpAuth {
  const key = findAuthKey(headers)
  if (!key) return { type: "none" }
  const value = String(headers[key] ?? "")
  const bearer = value.match(/^Bearer\s+(.*)$/i)
  if (bearer) return { type: "bearer", token: bearer[1] }
  const basic = value.match(/^Basic\s+(.*)$/i)
  if (basic) {
    try {
      const decoded = typeof atob === "function" ? atob(basic[1]) : Buffer.from(basic[1], "base64").toString("utf8")
      const colon = decoded.indexOf(":")
      if (colon !== -1) {
        return { type: "basic", username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
      }
    } catch { /* not base64 — fall through to custom */ }
  }
  return { type: "custom", raw: value }
}

export function applyAuthToHeaders(headers: Record<string, string> = {}, auth: HttpAuth): Record<string, string> {
  const next: Record<string, string> = { ...headers }
  const existingKey = findAuthKey(next)
  if (existingKey) delete next[existingKey]
  if (auth.type === "bearer" && String(auth.token ?? "") !== "") {
    next["Authorization"] = `Bearer ${auth.token}`
  } else if (auth.type === "basic" && (String(auth.username ?? "") !== "" || String(auth.password ?? "") !== "")) {
    const raw = `${auth.username ?? ""}:${auth.password ?? ""}`
    const encoded = typeof btoa === "function" ? btoa(raw) : Buffer.from(raw, "utf8").toString("base64")
    next["Authorization"] = `Basic ${encoded}`
  } else if (auth.type === "custom" && String(auth.raw ?? "") !== "") {
    next["Authorization"] = String(auth.raw)
  }
  return next
}

// ---------------------------------------------------------------------------
// Body linting: the runtime sends the body as JSON (pg_net). Validate the
// text as JSON after substituting merge tokens with a placeholder so
// {"email": "{{lead.email}}"} passes but {"email": } fails.
// ---------------------------------------------------------------------------

export function lintJsonBody(body: string): { valid: boolean; error?: string } {
  const text = String(body ?? "").trim()
  if (text === "") return { valid: true }
  // A bare token as the whole body resolves to arbitrary JSON at runtime.
  if (/^\{\{[^}]*\}\}$/.test(text)) return { valid: true }
  const substituted = text.replace(/"([^"]*\{\{[^}]*\}\}[^"]*)"/g, '"x"').replace(/\{\{[^}]*\}\}/g, "0")
  try {
    JSON.parse(substituted)
    return { valid: true }
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : "Invalid JSON" }
  }
}

export const HTTP_TIMEOUT_DEFAULT_MS = 10000
export const HTTP_TIMEOUT_MIN_MS = 1000
export const HTTP_TIMEOUT_MAX_MS = 30000

export function clampTimeoutMs(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return HTTP_TIMEOUT_DEFAULT_MS
  return Math.max(HTTP_TIMEOUT_MIN_MS, Math.min(HTTP_TIMEOUT_MAX_MS, Math.round(n)))
}
