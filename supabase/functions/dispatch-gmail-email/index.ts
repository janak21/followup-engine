// Dispatch a Gmail email for a pending action.
//
// v8: error classification. Gmail permanent recipient errors (invalid to,
//   message rejected as spam) now call advance_journey with outcome='bounced'
//   so the email step's bounce branch fires. OAuth/quota/5xx errors still
//   use mark_action_failed for retry backoff.
// v7: look up sender by ID (returned from get_email_payload as sender_id).
// v6: per-sender OAuth client.
// v5: plain→HTML auto-detect for the text/html MIME part.
// v4: ASCII-only MIME boundary.
//
// Email step outcomes the runtime can emit: sent, bounced, replied, opt_out.
// Deliverability failures at send-time map to 'bounced'. Actual mailer-daemon
// bounces still come via poll-gmail-inbox.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_DISPATCH_KEY     = Deno.env.get("INTERNAL_DISPATCH_KEY")  || "";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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

// Classify a Gmail API failure. Returns:
//   { permanent: true,  outcome: 'bounced' | 'opt_out' } → advance_journey
//   { permanent: false }                                 → mark_action_failed (retry)
// OAuth (invalid_grant, missing refresh token) is deliberately treated as
// a config error, not a journey outcome — those need human intervention
// (reconnect Google) and shouldn't mark every affected lead as bounced.
function classifyGmailFailure(status: number, message: string): { permanent: boolean; outcome?: string; isConfig?: boolean } {
  const msg = (message || "").toLowerCase();

  if (status === 0 || status >= 500)  return { permanent: false };
  if (status === 429)                  return { permanent: false };
  if (msg.includes("quota") || msg.includes("rate limit") || msg.includes("ratelimit")) return { permanent: false };

  // OAuth / config problems — don't advance journey. Human fixes it, then
  // the retry succeeds. Marking every lead as 'bounced' during an OAuth
  // outage would falsely burn engagement history.
  if (msg.includes("invalid_grant") ||
      msg.includes("refresh_token") ||
      msg.includes("invalid credentials") ||
      msg.includes("unauthorized") ||
      status === 401) {
    return { permanent: false, isConfig: true };
  }

  // Recipient invalid at send time — truly bounced.
  if (msg.includes("invalid to") ||
      msg.includes("invalid recipient") ||
      msg.includes("invalid header") ||
      msg.includes("malformed address") ||
      msg.includes("no recipients") ||
      msg.includes("invalidargument")) {
    return { permanent: true, outcome: "bounced" };
  }

  // Content rejected by Gmail — route to bounced so the journey exits the
  // send branch (Gmail won't deliver it anyway).
  if (msg.includes("message rejected") ||
      msg.includes("spam") ||
      msg.includes("policy violation") ||
      msg.includes("blocked")) {
    return { permanent: true, outcome: "bounced" };
  }

  // Unknown 4xx — treat as bounced (permanent) so journey advances. Better
  // an alert on the bounce branch than an infinite retry loop.
  if (status >= 400 && status < 500) return { permanent: true, outcome: "bounced" };

  return { permanent: false };
}

function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
function b64std(b: Uint8Array): string {
  let bin = ""; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}
function b64url(b: Uint8Array): string {
  return b64std(b).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function wrap76(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join("\r\n");
}
function encodeHeaderWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s) && !/[?=]/.test(s)) return s;
  return `=?UTF-8?B?${b64std(utf8(s))}?=`;
}
function formatFromHeader(name: string | null, email: string): string {
  if (!name) return email;
  const encoded = encodeHeaderWord(name);
  return `"${encoded.replace(/"/g,'\\"')}" <${email}>`;
}
function looksLikeRfc822MessageId(s?: string | null): boolean {
  if (!s) return false;
  return /^<[^<>@\s]+@[^<>@\s]+>$/.test(s.trim());
}
function ensureRePrefix(subject: string): string {
  return /^\s*re:\s*/i.test(subject || "") ? subject : `Re: ${subject || ""}`;
}
function newRfc822MessageId(senderEmail: string): string {
  const domain = senderEmail.split("@")[1] || "followup.local";
  const id = crypto.randomUUID().replace(/-/g, "");
  return `<${id}.${Date.now()}@${domain}>`;
}
function newBoundary(): string {
  return `_followup_${crypto.randomUUID().replace(/-/g,"")}`;
}
function looksLikeHtml(s: string): boolean {
  if (!s) return false;
  return /<\/?[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/.test(s);
}
function plainToHtml(s: string): string {
  if (!s) return "";
  const escaped = s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const paragraphs = escaped.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g,"<br>")}</p>`);
  return paragraphs.join("\n");
}
function htmlToPlain(html: string): string {
  if (!html) return "";
  let t = html;
  t = t.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
                (_m, href, inner) => `${inner.replace(/<[^>]+>/g, "")} (${href})`);
  t = t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `- ${inner}\n`);
  t = t.replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|tr|table)>/gi, "\n\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "");
  t = t.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
       .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
       .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function buildMimeBody(opts: { rawBody: string; bodyPlainExplicit: string | null; format: "both"|"html"|"plain"; }):
  { contentTypeHeader: string; encodedBody: string } {
  const inputIsHtml = looksLikeHtml(opts.rawBody);
  const htmlOut  = inputIsHtml ? opts.rawBody : plainToHtml(opts.rawBody);
  const plainOut = opts.bodyPlainExplicit ?? (inputIsHtml ? htmlToPlain(opts.rawBody) : opts.rawBody);

  if (opts.format === "plain") {
    return { contentTypeHeader: "text/plain; charset=UTF-8",
             encodedBody: "Content-Transfer-Encoding: base64\r\n\r\n" + wrap76(b64std(utf8(plainOut))) };
  }
  if (opts.format === "html") {
    return { contentTypeHeader: "text/html; charset=UTF-8",
             encodedBody: "Content-Transfer-Encoding: base64\r\n\r\n" + wrap76(b64std(utf8(htmlOut))) };
  }
  const boundary = newBoundary();
  const parts: string[] = [
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64std(utf8(plainOut))),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64std(utf8(htmlOut))),
    `--${boundary}--`,
  ];
  return { contentTypeHeader: `multipart/alternative; boundary="${boundary}"`, encodedBody: parts.join("\r\n") };
}

function buildRfc822(opts: {
  fromHeader: string; to: string; subject: string;
  rawBody: string; bodyPlainExplicit: string | null; format: "both"|"html"|"plain";
  messageId: string; inReplyTo?: string | null; references?: string | null; leadId?: string | null;
}): string {
  const mime = buildMimeBody({ rawBody: opts.rawBody, bodyPlainExplicit: opts.bodyPlainExplicit, format: opts.format });
  const lines: string[] = [];
  lines.push(`From: ${opts.fromHeader}`);
  lines.push(`To: ${opts.to}`);
  lines.push(`Subject: ${encodeHeaderWord(opts.subject)}`);
  lines.push(`Message-ID: ${opts.messageId}`);
  if (opts.inReplyTo)  lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  if (opts.leadId)     lines.push(`X-Example Co-Lead-Id: ${opts.leadId}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: ${mime.contentTypeHeader}`);
  lines.push("");
  lines.push(mime.encodedBody);
  return lines.join("\r\n");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "Use POST." });
  if (!isAuthorized(req)) return json(401, { ok: false, error: "Unauthorized." });

  let body: { action_id?: string; id?: string };
  try { body = await req.json(); }
  catch { return json(400, { ok: false, error: "Invalid JSON." }); }
  const actionId = body.action_id || body.id;
  if (!actionId) return json(400, { ok: false, error: "Missing action_id." });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  async function terminateWithClassification(status: number, message: string) {
    const cls = classifyGmailFailure(status, message);
    if (cls.permanent && cls.outcome) {
      await supabase.from("actions").update({
        status:        "failed_permanent",
        error_message: message.slice(0, 2000),
        completed_at:  new Date().toISOString(),
        locked_until:  null,
        locked_by:     null,
        result: { gmail_permanent_failure: true, outcome: cls.outcome, message: message.slice(0, 500) },
      }).eq("id", actionId);
      const { error: advErr } = await supabase.rpc("advance_journey", {
        p_action_id: actionId, p_outcome: cls.outcome,
      });
      if (advErr) console.error("advance_journey failed after permanent Gmail error:", advErr);
      return { permanent: true, outcome: cls.outcome, advanced: !advErr };
    }
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: message });
    return { permanent: false, retry_queued: true, config_issue: cls.isConfig || false };
  }

  let payload: any;
  try {
    const { data, error } = await supabase.rpc("get_email_payload", { p_action_id: actionId });
    if (error) {
      const res = await terminateWithClassification(500, `get_email_payload: ${error.message}`);
      return json(500, { ok: false, stage: "get_email_payload", error: error.message, resolution: res });
    }
    payload = data;
  } catch (err) {
    return json(500, { ok: false, stage: "get_email_payload", error: (err as Error).message });
  }

  if (!payload || payload.outcome === "failed") {
    const reason = payload?.reason || "get_email_payload returned failure";
    const res = await terminateWithClassification(400, reason);
    return json(500, { ok: false, stage: "get_email_payload", error: reason, resolution: res });
  }
  if (payload.outcome === "no_sender") {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: payload.reason || "no sender available" });
    return json(409, { ok: false, stage: "sender_pool", error: payload.reason || "no sender available" });
  }
  if (payload.outcome === "throttled") {
    const next = payload.next_eligible_at || new Date(Date.now() + 15 * 60_000).toISOString();
    const { error: rerr } = await supabase.rpc("reschedule_action", {
      p_action_id: actionId, p_run_at: next, p_reason: payload.reason || "throttled",
    });
    if (rerr) return json(500, { ok: false, stage: "reschedule_action", error: rerr.message });
    return json(200, { ok: true, action_id: actionId, throttled: true, deferred_until: next, reason: payload.reason });
  }
  if (payload.provider_id) {
    return json(200, { ok: true, action_id: actionId, idempotent: true, provider_id: payload.provider_id });
  }

  const { data: actionRow, error: actErr } = await supabase
    .from("actions").select("tenant_id, lead_id").eq("id", actionId).single();
  if (actErr || !actionRow) {
    return json(500, { ok: false, stage: "read_action", error: actErr?.message || "action not found" });
  }

  if (!payload.sender_id) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: "get_email_payload returned no sender_id" });
    return json(500, { ok: false, stage: "read_sender", error: "no sender_id in payload" });
  }
  const { data: sender, error: senderErr } = await supabase
    .from("senders")
    .select("id, tenant_id, sender_email, sender_name, google_client_id, google_token_expires_at")
    .eq("id", payload.sender_id)
    .maybeSingle();
  if (senderErr) return json(500, { ok: false, stage: "read_sender", error: senderErr.message });
  if (!sender) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `Sender row not found for id ${payload.sender_id}` });
    return json(404, { ok: false, stage: "read_sender", error: "sender not found" });
  }

  // Pull sender secrets from Vault. These used to live as plaintext columns on
  // senders; after the migration they are encrypted and addressed by sender id.
  const [refreshToken, accessTokenFromVault, senderClientSecret] = await Promise.all([
    supabase.rpc("get_sender_secret", { p_sender_id: sender.id, p_key: "google_refresh_token" }).then(r => r.data as string | null),
    supabase.rpc("get_sender_secret", { p_sender_id: sender.id, p_key: "google_access_token" }).then(r => r.data as string | null),
    supabase.rpc("get_sender_secret", { p_sender_id: sender.id, p_key: "google_client_secret" }).then(r => r.data as string | null),
  ]);

  if (!refreshToken) {
    await supabase.rpc("mark_action_failed", {
      p_action_id: actionId,
      p_error_message: `Sender ${sender.sender_email} has no Google refresh_token. Connect Google in Settings → Senders.`,
    });
    return json(400, { ok: false, stage: "check_oauth", error: "sender not connected" });
  }

  let clientId     = sender.google_client_id;
  let clientSecret = senderClientSecret;
  if (!clientId || !clientSecret) {
    const { data: cred } = await supabase
      .from("tenant_credentials")
      .select("config")
      .eq("tenant_id", actionRow.tenant_id)
      .eq("provider", "gmail")
      .eq("active", true)
      .maybeSingle();
    clientId     = clientId     || cred?.config?.google_client_id;
    // google_client_secret is a SECRET — when the tenant fallback is needed,
    // pull it from Vault via the tenant secret helper.
    if (!clientSecret) {
      const { data: vaultSecret, error: secretErr } = await supabase.rpc("get_tenant_secret", {
        p_tenant_id: actionRow.tenant_id,
        p_provider:  "gmail",
        p_key:       "google_client_secret",
      });
      if (secretErr) {
        await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `Vault read failed: ${secretErr.message}` });
        return json(500, { ok: false, stage: "read_secret", error: secretErr.message });
      }
      clientSecret = vaultSecret;
    }
  }
  if (!clientId || !clientSecret) {
    await supabase.rpc("mark_action_failed", {
      p_action_id: actionId,
      p_error_message: "No Gmail OAuth client. Set it on the sender (Settings → Senders → Edit) or as a tenant default.",
    });
    return json(400, { ok: false, stage: "read_credentials", error: "oauth client missing" });
  }

  let accessToken = accessTokenFromVault;
  const expiresAt = sender.google_token_expires_at ? new Date(sender.google_token_expires_at).getTime() : 0;
  if (!accessToken || expiresAt - Date.now() < 60_000) {
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    "refresh_token",
      }).toString(),
    });
    const tokJson = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokJson.access_token) {
      const errMsg = tokJson?.error_description || tokJson?.error || `HTTP ${tokRes.status}`;
      const isInvalidGrant = tokJson?.error === "invalid_grant";
      await supabase.rpc("mark_action_failed", {
        p_action_id: actionId,
        p_error_message: isInvalidGrant
          ? `Google refresh_token invalid for ${sender.sender_email} (${errMsg}). Reconnect Google in Settings → Senders.`
          : `Token refresh failed: ${errMsg}`,
      });
      return json(401, { ok: false, stage: "refresh_token", error: errMsg });
    }
    accessToken = tokJson.access_token;
    const newExpiresAt = tokJson.expires_in
      ? new Date(Date.now() + (Number(tokJson.expires_in) - 60) * 1000).toISOString()
      : null;
    // Persist the refreshed access token back to Vault, NOT the plaintext column.
    const { error: vaultWriteErr } = await supabase.rpc("set_sender_secret", {
      p_sender_id: sender.id,
      p_key:       "google_access_token",
      p_value:     accessToken,
    });
    if (vaultWriteErr) {
      await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `Vault write failed: ${vaultWriteErr.message}` });
      return json(500, { ok: false, stage: "write_secret", error: vaultWriteErr.message });
    }
    await supabase.from("senders")
      .update({ google_token_expires_at: newExpiresAt })
      .eq("id", sender.id);
  }

  const format     = (payload.body_format === "plain" || payload.body_format === "html") ? payload.body_format : "both";
  // Per-step From-name override (inline composer). Address stays the sender's
  // authenticated Gmail address — Gmail only sends as the authenticated account.
  const fromDisplayName = (typeof payload.from_name === "string" && payload.from_name.trim())
    ? payload.from_name.trim()
    : sender.sender_name;
  const fromHeader = formatFromHeader(fromDisplayName, sender.sender_email);
  const messageId  = newRfc822MessageId(sender.sender_email);
  const isReply    = Boolean(payload.has_thread);
  const subject    = isReply ? ensureRePrefix(payload.subject || "") : (payload.subject || "");
  const inReplyTo  = looksLikeRfc822MessageId(payload.last_email_message_id) ? payload.last_email_message_id : null;
  const rawBody    = payload.body_html ?? payload.body ?? "";

  const rfc822 = buildRfc822({
    fromHeader,
    to: payload.email_to,
    subject,
    rawBody,
    bodyPlainExplicit: payload.body_plain ?? null,
    format,
    messageId,
    inReplyTo,
    references: inReplyTo,
    leadId: actionRow.lead_id,
  });

  const sendBody: Record<string, string> = { raw: b64url(utf8(rfc822)) };
  if (isReply && payload.email_thread_id) sendBody.threadId = payload.email_thread_id;

  let gRes: Response;
  try {
    gRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(sendBody),
    });
  } catch (err) {
    const res = await terminateWithClassification(0, `Gmail network error: ${(err as Error).message}`);
    return json(502, { ok: false, stage: "gmail_fetch", error: (err as Error).message, resolution: res });
  }
  let gJson: any;
  try { gJson = await gRes.json(); } catch { gJson = await gRes.text(); }
  if (!gRes.ok) {
    const msg = typeof gJson === "object" ? (gJson?.error?.message || JSON.stringify(gJson)) : String(gJson);
    const errMsg = `Gmail ${gRes.status}: ${msg.slice(0, 900)}`;
    const res = await terminateWithClassification(gRes.status, errMsg);
    return json(gRes.status, { ok: false, stage: "gmail_api", gmail: gJson, resolution: res });
  }
  const gmailId  = gJson?.id;
  const threadId = gJson?.threadId;
  if (!gmailId) {
    const res = await terminateWithClassification(502, "Gmail returned 2xx but no id");
    return json(502, { ok: false, stage: "gmail_api", error: "no id in response", gmail: gJson, resolution: res });
  }

  const { error: recErr } = await supabase.rpc("record_send_event", {
    p_action_id:   actionId,
    p_provider:    "gmail",
    p_provider_id: gmailId,
    p_outcome:     "sent",
    p_payload: {
      subject,
      body:        rawBody,
      body_plain:  payload.body_plain ?? null,
      body_format: format,
      to_address:  payload.email_to,
      gmail_id:    gmailId,
      thread_id:   threadId,
      message_id:  messageId,
      sender_email: sender.sender_email,
      sender_name:  sender.sender_name,
      is_reply:    isReply,
    },
  });
  if (recErr) return json(500, { ok: false, stage: "record_send_event", error: recErr.message, gmail_id: gmailId });

  return json(200, {
    ok: true, action_id: actionId, gmail_id: gmailId, thread_id: threadId,
    message_id: messageId, to: payload.email_to, via: sender.sender_email,
    is_reply: isReply, format,
  });
});
