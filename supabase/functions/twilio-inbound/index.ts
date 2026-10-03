// twilio-inbound
//
// Receives Twilio's 'A MESSAGE COMES IN' webhook — fires when a lead
// replies to one of our SMS sends. Twilio's format is
// application/x-www-form-urlencoded (NOT JSON) and it retries on non-2xx,
// so we normalize the input, hand it to process_inbound_sms, and always
// return 2xx TwiML (empty <Response/>) so Twilio stops retrying.
//
// Twilio Console configuration (per phone number):
//   Messaging → A MESSAGE COMES IN → Webhook → POST
//   URL: https://<project-ref>.supabase.co/functions/v1/twilio-inbound
//        (replace <project-ref> with your Supabase project ref)
//   Leave "POST" selected. Do NOT enable "Twilio Auth Token signing"
//   checkboxes inside Console — the auth token is read from
//   tenant_credentials here and validated server-side.
//
// Authenticity: every POST is validated against Twilio's
// X-Twilio-Signature (HMAC-SHA1 over URL + sorted POST params, keyed by
// the destination number's Twilio auth_token, resolved via
// resolve_twilio_credentials(p_phone)). On failure:
//   - default (no env / not "log_only"): 403 + error_logs row, RPC NOT called.
//   - TWILIO_SIGNATURE_ENFORCEMENT=log_only: logs violation, then proceeds
//     process_inbound_sms) for a safe rollout window.
// verify_jwt=false is correct — Twilio can't carry a Supabase JWT and the
// signature is the real authn boundary.
//
// Idempotency: `events` has a UNIQUE constraint on (tenant_id, channel,
// direction, provider_id) where channel='email' — SMS uses provider_id =
// MessageSid which Twilio guarantees unique. Duplicate delivery retries
// from Twilio would race on that insert; we tolerate the resulting error
// as a signal that we've already processed it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/twilio-signature.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Rollout escape hatch:
//   unset (default)               -> enforce: reject invalid/missing signatures with 403.
//   TWILIO_SIGNATURE_ENFORCEMENT=log_only -> log the violation but still process.
// Use log_only for a safe rollout window; remove once all inbound numbers validate cleanly.
const ENFORCEMENT = Deno.env.get("TWILIO_SIGNATURE_ENFORCEMENT") ?? "enforce";
const LOG_ONLY = ENFORCEMENT === "log_only";

// Return an empty TwiML <Response/>. Twilio will consider this a successful
// receipt and not retry. If we later want to auto-reply via TwiML instead of
// going through the queue, this is where we'd emit <Message>...</Message>.
function twimlOk(): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response/>`,
    { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function parseTwilioBody(req: Request): Promise<Record<string, string>> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }
  if (ct.includes("application/json")) {
    return (await req.json().catch(() => ({}))) as Record<string, string>;
  }
  // Some proxies (Zapier, custom relays) strip the content-type. Try both.
  const raw = await req.text();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

Deno.serve(async (req: Request) => {
  // Twilio does GET when configuring the webhook (validation ping); return 200.
  if (req.method === "GET") return twimlOk();
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Use POST (or GET for Twilio validation)." });
  }

  const body = await parseTwilioBody(req);
  const from       = body.From        || body.from;
  const to         = body.To          || body.to;
  const text       = body.Body        || body.body || "";
  const messageSid = body.MessageSid  || body.SmsMessageSid || body.sid;

  // Minimal validation. Missing fields probably means someone hit the URL
  // manually or a proxy stripped it — always return TwiML so Twilio doesn't
  // retry a broken payload.
  if (!from || !to || !messageSid) {
    console.warn("twilio-inbound: incomplete payload", { from, to, hasSid: !!messageSid });
    return twimlOk();
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Twilio signature validation ──────────────────────────────────────────
  // Resolve credentials from the destination number (Twilio signs with the
  // auth_token of the account that owns the inbound `To` number). Unknown `To`
  // → no credentials → cannot validate → reject.
  const sigHeader = req.headers.get("X-Twilio-Signature");
  const lowerProto = (req.headers.get("X-Forwarded-Proto") || new URL(req.url).protocol.replace(":", "")).toLowerCase();
  const lowerHost  = (req.headers.get("X-Forwarded-Host")  || new URL(req.url).host).toLowerCase();
  const requestUrl = `${lowerProto}://${lowerHost}/functions/v1/twilio-inbound`;

  const { data: creds, error: credsErr } = await supabase.rpc("resolve_twilio_credentials", {
    p_phone: String(to),
  });

  if (credsErr || !creds || !creds.auth_token) {
    const reason = credsErr ? `creds lookup error: ${credsErr.message}` : "no Twilio credential resolved for destination number";
    await supabase.from("error_logs").insert({
      workflow_name: "twilio_inbound_signature",
      error_message: `Signature validation failed: ${reason}`,
      raw_error: { to, message_sid: messageSid, request_url: requestUrl, has_sig: !!sigHeader },
      severity: "warning",
      status: "open",
    });
    if (LOG_ONLY) {
      console.warn("twilio-inbound: signature BLOCKED but LOG_ONLY — proceeding", { messageSid, reason });
    } else {
      if (credsErr) console.error("twilio-inbound: resolve_twilio_credentials error", credsErr);
      return json(403, { ok: false, error: "Cannot validate Twilio signature for destination number." });
    }
  } else if (creds?.auth_token) {
    const verified = await validateTwilioSignature({
      authToken: creds.auth_token,
      requestUrl,
      params: body,
      signatureHeader: sigHeader,
    });
    if (!verified.ok) {
      await supabase.from("error_logs").insert({
        workflow_name: "twilio_inbound_signature",
        error_message: `Twilio signature rejected: ${verified.reason}`,
        raw_error: { to, message_sid: messageSid, request_url: requestUrl, has_sig: !!sigHeader, tenant_id: creds.tenant_id },
        severity: "warning",
        status: "open",
      });
      if (LOG_ONLY) {
        console.warn("twilio-inbound: signature INVALID but LOG_ONLY — proceeding", { messageSid, reason: verified.reason });
      } else {
        return json(403, { ok: false, error: "Invalid Twilio signature." });
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  try {
    const { data, error } = await supabase.rpc("process_inbound_sms", {
      p_from:        String(from),
      p_to:          String(to),
      p_body:        String(text),
      p_message_sid: String(messageSid),
    });
    if (error) {
      // Duplicate insert from Twilio retry — already processed. Log + ok.
      if (/duplicate key value|unique constraint/i.test(error.message || "")) {
        console.log("twilio-inbound: duplicate delivery, already processed", { messageSid });
        return twimlOk();
      }
      // Anything else — log for observability, still return 2xx so Twilio
      // doesn't retry forever on a bug we need to fix on our side.
      console.error("twilio-inbound: RPC error", { messageSid, error: error.message });
      await supabase.from("error_logs").insert({
        workflow_name: "twilio_inbound_webhook",
        error_message: `process_inbound_sms failed: ${error.message}`,
        raw_error: { from, to, message_sid: messageSid, body: text.slice(0, 500) },
        severity: "error",
        status: "open",
      });
      return twimlOk();
    }
    console.log("twilio-inbound: processed", { messageSid, status: data?.status, lead_id: data?.lead_id });
    return twimlOk();
  } catch (err) {
    console.error("twilio-inbound: unhandled", err);
    return twimlOk();
  }
});
