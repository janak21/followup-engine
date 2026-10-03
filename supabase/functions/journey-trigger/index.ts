// Journey-trigger inbound webhook.
// URL: POST /functions/v1/journey-trigger/<token>
// Body: any JSON. Headers: optional Authorization: Bearer <secret> if the journey has webhook_auth_mode='bearer'.
//
// verify_jwt=false because external systems post here without Supabase JWTs.
// Per-journey auth is enforced inside process_journey_webhook RPC.
//
// Response policy: returns 200 for any captured request (lead created OR sample-only).
// 400 is reserved for malformed inputs. 401 is reserved for failed auth.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const lastSeg = parts[parts.length - 1];
  const token = lastSeg && lastSeg !== "journey-trigger" ? lastSeg : url.searchParams.get("token");

  if (!token) {
    return json(400, { ok: false, error: "Missing journey token. Append it to the URL: /journey-trigger/<token>." });
  }

  let payload: unknown = {};
  try {
    const text = await req.text();
    if (text && text.trim().length > 0) {
      payload = JSON.parse(text);
    }
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body." });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const authHeader = req.headers.get("authorization");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc("process_journey_webhook", {
    p_token: token,
    p_payload: payload,
    p_headers: headers,
    p_auth_header: authHeader,
  });

  if (error) {
    return json(500, { ok: false, error: error.message });
  }

  const result = (data as Record<string, unknown>) || {};
  const status = result.status as string | undefined;

  // Auth failures -> 401
  if (status === "auth_failed") {
    return json(401, { ok: false, error: "Unauthorized", reason: result.reason });
  }

  // Non-recoverable failures (e.g. journey_not_found_for_token) -> 400
  // We DO NOT return 400 for sample_captured_no_lead — that's intentional success.
  if (status === "failed") {
    return json(400, { ok: false, error: result.reason || "failed", message: result.message });
  }

  // Both 'success' and 'sample_captured_no_lead' -> 200, with the result body.
  return json(200, { ok: true, ...result });
});