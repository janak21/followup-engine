// Twilio Message StatusCallback receiver.
// URL: POST /functions/v1/twilio-status
//
// Twilio Console configuration (per phone number / messaging service):
//   Phone Numbers → Active numbers → Messaging → A MESSAGE STATUS CHANGES
//     → Webhook → POST
//     URL: https://<project-ref>.supabase.co/functions/v1/twilio-status
//   (or "Messaging Services → Integration → Status Callback URL"
//     → POST the same URL — applies to all numbers in the service).
//   Replace <project-ref> with your Supabase project ref.
//
// Twilio fires this for every outbound SMS as the message moves through
// states (queued → sending → sent → delivered, OR → undelivered/failed).
// We hand it to update_sms_delivery_status which:
//   - finds the event by provider_id = MessageSid
//   - records the delivery_status, error_code, error_message
//   - on terminal failure (undelivered|failed) flips the action to 'failed'
//     and writes an error_logs row
//
// Authenticity: every POST is validated against Twilio's
// X-Twilio-Signature (HMAC-SHA1 over URL + sorted POST params, keyed by
// the auth_token of the From number). On failure:
//   - default (no env / not "log_only"): 403 + error_logs row, RPC NOT called.
//   - TWILIO_SIGNATURE_ENFORCEMENT=log_only: logs violation, then proceeds.
// verify_jwt=false is correct — Twilio can't carry a Supabase JWT.
//
// Body is application/x-www-form-urlencoded (NOT JSON). Twilio retries on
// non-2xx, so the RPC is idempotent and we return 2xx for anything that
// reaches Postgres successfully — including 'no matching event' cases
// where the SID isn't ours (otherwise Twilio retries forever).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/twilio-signature.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Rollout escape hatch — see twilio-inbound header for semantics.
const ENFORCEMENT = Deno.env.get("TWILIO_SIGNATURE_ENFORCEMENT") ?? "enforce";
const LOG_ONLY = ENFORCEMENT === "log_only";

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

  // Twilio sends application/x-www-form-urlencoded; rarely JSON in some
  // proxy setups. Handle both.
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  let fields: Record<string, string> = {};

  try {
    if (ctype.includes("application/json")) {
      const body = await req.json();
      if (body && typeof body === "object") {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          fields[k] = String(v ?? "");
        }
      }
    } else {
      const form = await req.formData();
      form.forEach((v, k) => { fields[k] = String(v); });
    }
  } catch {
    return json(400, { ok: false, error: "Could not parse request body." });
  }

  const sid     = fields.MessageSid || fields.SmsSid || fields.sid;
  const status  = fields.MessageStatus || fields.SmsStatus || fields.status;
  const errCode = fields.ErrorCode || null;
  const errMsg  = fields.ErrorMessage || null;

  if (!sid || !status) {
    return json(400, { ok: false, error: "Missing MessageSid or MessageStatus." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Twilio signature validation ──────────────────────────────────────────
  // The signing account owns the number we sent FROM. Resolve credentials from
  // the From field; fall back to To for proxies that swap sender/recipient.
  const fromNum = fields.From || "";
  const toNum   = fields.To   || "";
  const sigHeader = req.headers.get("X-Twilio-Signature");
  const lowerProto = (req.headers.get("X-Forwarded-Proto") || new URL(req.url).protocol.replace(":", "")).toLowerCase();
  const lowerHost  = (req.headers.get("X-Forwarded-Host")  || new URL(req.url).host).toLowerCase();
  const requestUrl = `${lowerProto}://${lowerHost}/functions/v1/twilio-status`;

  let creds: { tenant_id?: string; account_sid?: string; auth_token?: string } | null = null;
  for (const candidate of [fromNum, toNum]) {
    if (!candidate) continue;
    const { data, error } = await supabase.rpc("resolve_twilio_credentials", { p_phone: String(candidate) });
    if (!error && data && data.auth_token) {
      creds = data;
      break;
    }
  }

  if (!creds || !creds.auth_token) {
    await supabase.from("error_logs").insert({
      workflow_name: "twilio_status_signature",
      error_message: "Signature validation failed: no Twilio credential resolved for From/To number",
      raw_error: { from: fromNum, to: toNum, message_sid: sid, request_url: requestUrl, has_sig: !!sigHeader },
      severity: "warning",
      status: "open",
    });
    if (LOG_ONLY) {
      console.warn("twilio-status: signature BLOCKED but LOG_ONLY — proceeding", { sid });
    } else {
      return json(403, { ok: false, error: "Cannot validate Twilio signature for sender/recipient number." });
    }
  } else {
    const verified = await validateTwilioSignature({
      authToken: creds.auth_token,
      requestUrl,
      params: fields,
      signatureHeader: sigHeader,
    });
    if (!verified.ok) {
      await supabase.from("error_logs").insert({
        workflow_name: "twilio_status_signature",
        error_message: `Twilio signature rejected: ${verified.reason}`,
        raw_error: { from: fromNum, to: toNum, message_sid: sid, request_url: requestUrl, has_sig: !!sigHeader, tenant_id: creds.tenant_id },
        severity: "warning",
        status: "open",
      });
      if (LOG_ONLY) {
        console.warn("twilio-status: signature INVALID but LOG_ONLY — proceeding", { sid, reason: verified.reason });
      } else {
        return json(403, { ok: false, error: "Invalid Twilio signature." });
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  const { data, error } = await supabase.rpc("update_sms_delivery_status", {
    p_sid:           sid,
    p_status:        status,
    p_error_code:    errCode,
    p_error_message: errMsg,
    p_raw:           fields,
  });

  if (error) {
    // True 5xx so Twilio retries. Postgres-level failures only.
    console.error("update_sms_delivery_status error:", error);
    return json(500, { ok: false, error: error.message });
  }

  // Includes the 'no_matching_event' case as 2xx so Twilio stops retrying.
  return json(200, { ok: true, ...(data as Record<string, unknown> || {}) });
});