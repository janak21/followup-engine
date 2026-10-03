// Dispatch a Twilio SMS for a pending action.
//
// v3: error classification. Twilio permanent errors (invalid number, STOP
//   opt-out, carrier-blocked) now call advance_journey with the mapped
//   outcome so the SMS step's failure branch fires. Transient errors keep
//   the existing mark_action_failed retry backoff.
// v2: initial native path (MessagingService + StatusCallback wiring).
//
// SMS step outcomes the runtime can emit: sent, delivered, failed, replied,
// opt_out. Classification below maps Twilio error codes to those.
//
// Twilio error code refs (docs.twilio.com/api/errors):
//   21211  invalid To phone number         → failed
//   21212  invalid From phone number       → failed (config)
//   21214  invalid phone number — not mobile→ failed
//   21408  permission not enabled for region→ failed
//   21610  unsubscribed (STOP received)    → opt_out
//   21611  no international permissions    → failed
//   21612  cannot route to destination     → failed
//   21614  not a valid mobile              → failed
//   21617  message body too long           → failed (content)
//   30003  unreachable destination handset → transient (temporary carrier issue)
//   30004  message blocked by carrier      → failed
//   30005  unknown destination handset     → failed
//   30006  landline / unreachable          → failed
//   30007  carrier violation               → failed
//   30008  unknown error                   → transient
//   429    rate limited                    → transient
//   5xx    Twilio server                   → transient

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_DISPATCH_KEY     = Deno.env.get("INTERNAL_DISPATCH_KEY")  || "";

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

function classifyTwilioFailure(status: number, code: string | number, message: string): { permanent: boolean; outcome?: string } {
  const codeNum = Number(code) || 0;
  const msg = (message || "").toLowerCase();

  // Network + 5xx + rate limit + Twilio's own transient 30008. Retry.
  if (status === 0 || status >= 500 || status === 429) return { permanent: false };
  if (codeNum === 30003 || codeNum === 30008)           return { permanent: false };

  // Opt-out signals — map to the journey's opt_out outcome so downstream
  // suppression + status flip fire cleanly instead of looking like a fail.
  if (codeNum === 21610 ||
      msg.includes("unsubscribed") ||
      msg.includes("opted out") ||
      msg.includes("stop keyword")) {
    return { permanent: true, outcome: "opt_out" };
  }

  // Known permanent number-issue codes.
  const permanentFailedCodes = new Set([
    21211, 21212, 21214, 21408, 21611, 21612, 21614, 21617,
    30004, 30005, 30006, 30007,
  ]);
  if (permanentFailedCodes.has(codeNum)) return { permanent: true, outcome: "failed" };

  // String-match fallbacks for anything without a code.
  if (msg.includes("invalid 'to'") ||
      msg.includes("is not a valid phone number") ||
      msg.includes("invalid phone number") ||
      msg.includes("not a mobile") ||
      msg.includes("landline") ||
      msg.includes("unreachable") ||
      msg.includes("blocked")) {
    return { permanent: true, outcome: "failed" };
  }

  // Unknown 4xx — assume permanent so the journey moves forward instead
  // of looping retries. Better an alert on failure branch than a stall.
  if (status >= 400 && status < 500) return { permanent: true, outcome: "failed" };

  return { permanent: false };
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

  async function terminateWithClassification(status: number, code: string | number, message: string) {
    const cls = classifyTwilioFailure(status, code, message);
    if (cls.permanent && cls.outcome) {
      await supabase.from("actions").update({
        status:        "failed_permanent",
        error_message: message.slice(0, 2000),
        completed_at:  new Date().toISOString(),
        locked_until:  null,
        locked_by:     null,
        result: { twilio_permanent_failure: true, outcome: cls.outcome, code, message: message.slice(0, 500) },
      }).eq("id", actionId);

      const { error: advErr } = await supabase.rpc("advance_journey", {
        p_action_id: actionId, p_outcome: cls.outcome,
      });
      if (advErr) console.error("advance_journey failed after permanent Twilio error:", advErr);
      return { permanent: true, outcome: cls.outcome, advanced: !advErr };
    }
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: message });
    return { permanent: false, retry_queued: true };
  }

  // 1. SMS payload from the RPC.
  let payload: any;
  try {
    const { data, error } = await supabase.rpc("get_sms_payload", { p_action_id: actionId });
    if (error) {
      const res = await terminateWithClassification(400, "", `get_sms_payload: ${error.message}`);
      return json(500, { ok: false, stage: "get_sms_payload", error: error.message, resolution: res });
    }
    payload = data;
  } catch (err) {
    return json(500, { ok: false, stage: "get_sms_payload", error: (err as Error).message });
  }
  if (!payload || !payload.action_id) {
    const res = await terminateWithClassification(400, "", "get_sms_payload returned empty");
    return json(500, { ok: false, stage: "get_sms_payload", error: "empty payload", resolution: res });
  }

  if (payload.provider_id) {
    return json(200, { ok: true, action_id: actionId, idempotent: true, provider_id: payload.provider_id });
  }

  // 2. Tenant Twilio credentials — supports MS SID OR single From number.
  const { data: actionRow, error: actErr } = await supabase
    .from("actions").select("tenant_id").eq("id", actionId).single();
  if (actErr || !actionRow) {
    return json(500, { ok: false, stage: "read_action", error: actErr?.message || "action not found" });
  }
  const { data: cred, error: credErr } = await supabase
    .from("tenant_credentials")
    .select("config")
    .eq("tenant_id", actionRow.tenant_id)
    .eq("provider", "twilio")
    .eq("active", true)
    .maybeSingle();
  if (credErr) return json(500, { ok: false, stage: "read_credentials", error: credErr.message });
  const accountSid          = cred?.config?.account_sid;
  const messagingServiceSid = cred?.config?.messaging_service_sid;
  const fromNumber          = cred?.config?.from_number || payload.twilio_from_number;

  // auth_token is a SECRET — read from Vault via the SECURITY DEFINER helper.
  // (account_sid / messaging_service_sid / from_number are non-secret and stay
  // in tenant_credentials.config.)
  const { data: authToken, error: secretErr } = await supabase.rpc("get_tenant_secret", {
    p_tenant_id: actionRow.tenant_id,
    p_provider:  "twilio",
    p_key:       "auth_token",
  });
  if (secretErr) return json(500, { ok: false, stage: "read_secret", error: secretErr.message });

  if (!accountSid || !authToken) {
    const res = await terminateWithClassification(400, "", "Twilio account_sid / auth_token missing on tenant credentials. Set them in Settings → Credentials → Twilio.");
    return json(400, { ok: false, stage: "read_credentials", error: "Twilio account_sid or auth_token missing", resolution: res });
  }
  if (!messagingServiceSid && !fromNumber) {
    const res = await terminateWithClassification(400, "", "Neither messaging_service_sid nor from_number configured on Twilio credentials.");
    return json(400, { ok: false, stage: "read_credentials", error: "No sender (MessagingService or From) configured", resolution: res });
  }

  // 3. POST to Twilio /Messages.json.
  const statusCallbackUrl = `${SUPABASE_URL}/functions/v1/twilio-status`;
  const form = new URLSearchParams();
  form.set("To",   payload.phone_to);
  form.set("Body", payload.body);
  form.set("StatusCallback", statusCallbackUrl);
  form.set("SmartEncoded", "true");
  if (messagingServiceSid) {
    form.set("MessagingServiceSid", messagingServiceSid);
    if (fromNumber) form.set("From", fromNumber);
  } else {
    form.set("From", fromNumber);
  }

  const twAuth = btoa(`${accountSid}:${authToken}`);
  const twUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  let twRes: Response;
  try {
    twRes = await fetch(twUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${twAuth}`,
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    const res = await terminateWithClassification(0, "", `Twilio network error: ${(err as Error).message}`);
    return json(502, { ok: false, stage: "twilio_fetch", error: (err as Error).message, resolution: res });
  }

  let twJson: any;
  try { twJson = await twRes.json(); } catch { twJson = await twRes.text(); }

  if (!twRes.ok) {
    const msg  = typeof twJson === "object" ? (twJson?.message     || JSON.stringify(twJson)) : String(twJson);
    const code = typeof twJson === "object" ? (twJson?.code         || "") : "";
    const more = typeof twJson === "object" ?  twJson?.more_info     : null;
    const errMsg = `Twilio ${twRes.status}${code ? ` (${code})` : ""}: ${msg.slice(0, 900)}${more ? ` | ${more}` : ""}`;
    const res = await terminateWithClassification(twRes.status, code, errMsg);
    return json(twRes.status, { ok: false, stage: "twilio_api", twilio: twJson, resolution: res });
  }

  const sid = twJson?.sid;
  if (!sid) {
    const res = await terminateWithClassification(502, "", "Twilio returned 2xx but no sid");
    return json(502, { ok: false, stage: "twilio_api", error: "no sid in response", twilio: twJson, resolution: res });
  }

  // 4. record_send_event flips the action to completed.
  const { error: recErr } = await supabase.rpc("record_send_event", {
    p_action_id:   actionId,
    p_provider:    "twilio",
    p_provider_id: sid,
    p_outcome:     "sent",
    p_payload:     {
      body:                  payload.body,
      to_address:            payload.phone_to,
      sid,
      messaging_service_sid: messagingServiceSid || null,
      initial_status:        twJson?.status || null,
    },
  });
  if (recErr) return json(500, { ok: false, stage: "record_send_event", error: recErr.message, sid });

  return json(200, {
    ok:                    true,
    action_id:             actionId,
    sid,
    to:                    payload.phone_to,
    via:                   messagingServiceSid ? "messaging_service" : "from_number",
    initial_status:        twJson?.status,
  });
});
