// Thin wrapper around fetch for the dashboard's own /api routes.
//
// Eliminates the recurring hand-rolled pattern that caused the analytics
// white-screen bug: fetch → res.json() → use data, with no res.ok check.
//
//   import { apiFetch, ApiError } from "@/utils/apiFetch"
//
//   const { data } = await apiFetch("/api/analytics")          // throws ApiError on failure
//   await apiFetch("/api/leads", { method: "POST", json: {…} }) // JSON body shorthand
//
// Guarantees:
// - Non-2xx → throws ApiError with the server's `error` message when present,
//   plus .status and .body for callers that need details.
// - Malformed/empty JSON on an OK response → resolves to {} instead of throwing.
// - Network failure → the native TypeError propagates (callers catch (e) and
//   show e.message either way).

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, { status, body }: { status?: number; body?: unknown } = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status ?? 0
    this.body = body ?? null
  }
}

export interface ApiFetchInit extends Omit<RequestInit, "headers"> {
  json?: unknown;
  headers?: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch(url: string, { json, headers, ...init }: ApiFetchInit = {}): Promise<any> {
  const opts: RequestInit & { headers: Record<string, string> } = { ...init, headers: { ...(headers || {}) } }
  if (json !== undefined) {
    opts.method = opts.method || "POST"
    opts.headers["Content-Type"] = "application/json"
    opts.body = JSON.stringify(json)
  }

  const res = await fetch(url, opts)
  const body = await res.json().catch(() => null)

  if (!res.ok) {
    const message =
      (body && typeof body === "object" && ((body as Record<string, unknown>).error || (body as Record<string, unknown>).message)) ||
      `Request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`
    throw new ApiError(message, { status: res.status, body })
  }
  return body ?? {}
}
