// Dispatch a Retell phone call for a pending action. Self-contained native path:
//   1. Resolve call payload via get_call_payload (agent, from, to, dynamic
//      vars, metadata).
//   2. Look up the tenant's Retell API key from tenant_credentials.
//   3. POST to Retell /v2/create-phone-call.
//   4. On success, record_send_event with the returned call_id.
//   5. On Retell error, mark_action_failed so the dispatcher's retry/backoff
//      policy takes over.
//
// Auth: shared Bearer secret. Accepts either:
//   - SUPABASE_SERVICE_ROLE_KEY  (full service role; for ops/admin use)
//   - INTERNAL_DISPATCH_KEY      (rotated internal secret; what Postgres
//                                  uses via pg_net to fire dispatches)
// Either works. verify_jwt=false because callers are our own internals,
// not Supabase users.
//
// Idempotent: get_call_payload's already_completed short-circuit prevents
// double-dispatch when the same action gets re-triggered.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_DISPATCH_KEY     = Deno.env.get("INTERNAL_DISPATCH_KEY")  || "";
const RETELL_BASE               = "https://api.retellai.com";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (token === SUPABASE_SERVICE_ROLE_KEY) return true;
  if (INTERNAL_DISPATCH_KEY && token === INTERNAL_DISPATCH_KEY) return true;
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "Use POST." });
  if (!isAuthorized(req)) {
    return json(401, { ok: false, error: "Unauthorized — pass service role key or INTERNAL_DISPATCH_KEY in Authorization: Bearer." });
  }

  let body: { action_id?: string; id?: string };
  try { body = await req.json(); }
  catch { return json(400, { ok: false, error: "Invalid JSON body. Expected { action_id }." }); }

  const actionId = body.action_id || body.id;
  if (!actionId) return json(400, { ok: false, error: "Missing action_id in body." });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1. Call payload.
  const { data: payload, error: payloadErr } = await supabase.rpc("get_call_payload", { p_action_id: actionId });
  if (payloadErr) return json(500, { ok: false, stage: "get_call_payload", error: payloadErr.message });
  if (!payload || typeof payload !== "object") {
    return json(500, { ok: false, stage: "get_call_payload", error: "empty payload" });
  }
  if (payload.outcome === "already_completed") {
    return json(200, { ok: true, action_id: actionId, idempotent: true, provider_id: payload.provider_id });
  }
  if (payload.outcome !== "success") {
    await supabase.rpc("mark_action_failed", {
      p_action_id: actionId,
      p_error_message: `get_call_payload: ${payload.reason || "failed"}`,
    });
    return json(422, { ok: false, stage: "get_call_payload", reason: payload.reason });
  }

  // 2. Tenant Retell credentials.
  const { data: actionRow, error: actErr } = await supabase
    .from("actions").select("tenant_id").eq("id", actionId).single();
  if (actErr || !actionRow) {
    return json(500, { ok: false, stage: "read_action", error: actErr?.message || "action not found" });
  }
  const { data: cred, error: credErr } = await supabase
    .from("tenant_credentials")
    .select("config")
    .eq("tenant_id", actionRow.tenant_id)
    .eq("provider", "retell")
    .eq("active", true)
    .maybeSingle();
  if (credErr) return json(500, { ok: false, stage: "read_credentials", error: credErr.message });

  // api_key is a SECRET — read from Vault via the SECURITY DEFINER helper.
  // (Non-secret from_number / agent_id stay in tenant_credentials.config.)
  const { data: apiKey, error: secretErr } = await supabase.rpc("get_tenant_secret", {
    p_tenant_id: actionRow.tenant_id,
    p_provider:  "retell",
    p_key:       "api_key",
  });
  if (secretErr) return json(500, { ok: false, stage: "read_secret", error: secretErr.message });

  if (!apiKey) {
    await supabase.rpc("mark_action_failed", {
      p_action_id: actionId,
      p_error_message: "Retell API key missing on tenant credentials.",
    });
    return json(400, { ok: false, stage: "read_credentials", error: "Retell api_key missing" });
  }

  // 3. Retell.
  const retellBody = {
    from_number: payload.retell_from_number,
    to_number:   payload.phone_to,
    override_agent_id:            payload.retell_agent_id,
    metadata:                     payload.metadata || {},
    retell_llm_dynamic_variables: payload.retell_dynamic_variables || {},
  };

  let retellRes: Response;
  try {
    retellRes = await fetch(`${RETELL_BASE}/v2/create-phone-call`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(retellBody),
    });
  } catch (err) {
    await supabase.rpc("mark_action_failed", {
      p_action_id: actionId,
      p_error_message: `Retell network error: ${err.message}`,
    });
    return json(502, { ok: false, stage: "retell_fetch", error: err.message });
  }

  let retellJson: any;
  try { retellJson = await retellRes.json(); } catch { retellJson = await retellRes.text(); }

  if (!retellRes.ok) {
    const msg = typeof retellJson === "object" ? (retellJson?.message || JSON.stringify(retellJson)) : String(retellJson);
    await supabase.rpc("mark_action_failed", {
      p_action_id: actionId,
      p_error_message: `Retell ${retellRes.status}: ${msg.slice(0, 1000)}`,
    });
    return json(retellRes.status, { ok: false, stage: "retell_api", retell: retellJson });
  }

  const callId = retellJson?.call_id;
  if (!callId) {
    await supabase.rpc("mark_action_failed", {
      p_action_id: actionId,
      p_error_message: "Retell returned 2xx but no call_id",
    });
    return json(502, { ok: false, stage: "retell_api", error: "no call_id in response", retell: retellJson });
  }

  // 4. Record send event.
  const { error: recErr } = await supabase.rpc("record_send_event", {
    p_action_id:   actionId,
    p_provider:    "retell",
    p_provider_id: callId,
    p_outcome:     "initiated",
    p_payload:     {
      to_address: payload.phone_to,
      call_id:    callId,
      agent_id:   payload.retell_agent_id,
    },
  });
  if (recErr) return json(500, { ok: false, stage: "record_send_event", error: recErr.message, call_id: callId });

  return json(200, {
    ok:           true,
    action_id:    actionId,
    call_id:      callId,
    to:           payload.phone_to,
    agent_id:     payload.retell_agent_id,
    dynamic_vars: payload.retell_dynamic_variables,
  });
});
