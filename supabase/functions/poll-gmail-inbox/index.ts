// poll-gmail-inbox
//
// v2 changes:
//   * Dedup by gmail_api_message_id (the Gmail API mid — stable per
//     message). Before calling process_inbound_email we check if an event
//     already exists with this mid in this tenant; if so, skip. Backstop:
//     the new UNIQUE partial index on events(tenant_id, channel, direction,
//     gmail_api_message_id) means duplicate inserts would no-op anyway.
//   * We pass gmail_api_message_id explicitly to process_inbound_email
//     (via a new RPC overload that stores it on the event row).
//
// Strategy unchanged:
//   * Bootstrap on first call (no cursor): grab profile.historyId, store,
//     skip fetching to avoid replaying historical inbox.
//   * Steady state: users.history.list(startHistoryId, historyTypes=messageAdded,
//     labelId=INBOX). For each new messageId, fetch users.messages.get(format=full),
//     parse headers + body, skip our own outbound (X-Example Co-Lead-Id header),
//     call process_inbound_email.
//   * Cursor invalidation → reset gmail_history_id and bootstrap next tick.
//
// Auth: Bearer service-role-key OR INTERNAL_DISPATCH_KEY.

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

function b64urlToStr(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  try {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
}

function extractBody(payload: any): { plain: string; html: string } {
  let plain = ""; let html = "";
  function walk(p: any) {
    if (!p) return;
    const mime = String(p.mimeType || "").toLowerCase();
    if (p.body?.data) {
      const s = b64urlToStr(p.body.data);
      if (mime === "text/plain" && !plain) plain = s;
      else if (mime === "text/html" && !html) html = s;
    }
    if (Array.isArray(p.parts)) p.parts.forEach(walk);
  }
  walk(payload);
  return { plain, html };
}

function getHeader(payload: any, name: string): string | null {
  const h = (payload?.headers || []).find((x: any) => String(x?.name || "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function extractEmail(addr: string | null): string | null {
  if (!addr) return null;
  const m = addr.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (m) return m[1].toLowerCase();
  const m2 = addr.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m2 ? m2[1].toLowerCase() : null;
}

async function getAccessToken(supabase: any, sender: any): Promise<{ token: string | null; error: string | null }> {
  // Sender secrets are stored in Vault, not plaintext columns.
  const [refreshToken, accessTokenFromVault, senderClientSecret] = await Promise.all([
    supabase.rpc("get_sender_secret", { p_sender_id: sender.id, p_key: "google_refresh_token" }).then((r: any) => r.data as string | null),
    supabase.rpc("get_sender_secret", { p_sender_id: sender.id, p_key: "google_access_token" }).then((r: any) => r.data as string | null),
    supabase.rpc("get_sender_secret", { p_sender_id: sender.id, p_key: "google_client_secret" }).then((r: any) => r.data as string | null),
  ]);

  let clientId     = sender.google_client_id;
  let clientSecret = senderClientSecret;
  if (!clientId || !clientSecret) {
    const { data: cred } = await supabase
      .from("tenant_credentials")
      .select("config").eq("tenant_id", sender.tenant_id).eq("provider", "gmail").eq("active", true).maybeSingle();
    clientId     = clientId     || cred?.config?.google_client_id;
    // google_client_secret is a SECRET — pull the tenant fallback from Vault.
    if (!clientSecret) {
      const { data: vaultSecret, error: secretErr } = await supabase.rpc("get_tenant_secret", {
        p_tenant_id: sender.tenant_id,
        p_provider:  "gmail",
        p_key:       "google_client_secret",
      });
      if (secretErr) console.error("poll-gmail-inbox: get_tenant_secret err", secretErr);
      clientSecret = vaultSecret;
    }
  }
  if (!clientId || !clientSecret) return { token: null, error: "oauth client missing" };
  if (!refreshToken) return { token: null, error: "sender refresh token missing" };

  const expiresAt = sender.google_token_expires_at ? new Date(sender.google_token_expires_at).getTime() : 0;
  if (accessTokenFromVault && expiresAt - Date.now() > 60_000) {
    return { token: accessTokenFromVault, error: null };
  }

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
    return { token: null, error: tokJson?.error_description || tokJson?.error || `HTTP ${tokRes.status}` };
  }
  const newExpiresAt = tokJson.expires_in
    ? new Date(Date.now() + (Number(tokJson.expires_in) - 60) * 1000).toISOString() : null;
  // Persist the refreshed access token back to Vault, NOT the plaintext column.
  const { error: vaultWriteErr } = await supabase.rpc("set_sender_secret", {
    p_sender_id: sender.id,
    p_key:       "google_access_token",
    p_value:     tokJson.access_token,
  });
  if (vaultWriteErr) {
    console.error("poll-gmail-inbox: set_sender_secret err", vaultWriteErr);
    return { token: null, error: `Vault write failed: ${vaultWriteErr.message}` };
  }
  await supabase.from("senders")
    .update({ google_token_expires_at: newExpiresAt })
    .eq("id", sender.id);
  return { token: tokJson.access_token, error: null };
}

async function gmailFetch(path: string, accessToken: string): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  let j: any;
  try { j = await res.json(); } catch { j = null; }
  return { ok: res.ok, status: res.status, json: j };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") return json(405, { ok: false, error: "Use POST or GET." });
  if (!isAuthorized(req)) return json(401, { ok: false, error: "Unauthorized" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: senders, error: sErr } = await supabase
    .from("senders")
    .select("id, tenant_id, sender_email, google_client_id, google_token_expires_at, gmail_history_id, gmail_readonly_granted")
    .eq("gmail_readonly_granted", true)
    .order("gmail_last_polled_at", { ascending: true, nullsFirst: true });
  if (sErr) return json(500, { ok: false, stage: "read_senders", error: sErr.message });

  const senderResults: any[] = [];

  for (const sender of senders || []) {
    const result: any = { sender_email: sender.sender_email, fetched: 0, processed: 0, skipped_dedup: 0, errors: [] as string[] };

    const { token: accessToken, error: tokErr } = await getAccessToken(supabase, sender);
    if (!accessToken) {
      await supabase.from("senders")
        .update({ gmail_poll_error: `token: ${tokErr}`, gmail_last_polled_at: new Date().toISOString() })
        .eq("id", sender.id);
      result.errors.push(`token: ${tokErr}`);
      senderResults.push(result);
      continue;
    }

    let cursor: string | null = sender.gmail_history_id;
    if (!cursor) {
      const prof = await gmailFetch("/profile", accessToken);
      if (!prof.ok) {
        const errMsg = prof.json?.error?.message || `HTTP ${prof.status}`;
        await supabase.from("senders")
          .update({ gmail_poll_error: `profile: ${errMsg}`, gmail_last_polled_at: new Date().toISOString() })
          .eq("id", sender.id);
        result.errors.push(`profile: ${errMsg}`);
        senderResults.push(result);
        continue;
      }
      cursor = String(prof.json?.historyId || "");
      await supabase.from("senders")
        .update({ gmail_history_id: cursor, gmail_last_polled_at: new Date().toISOString(), gmail_poll_error: null })
        .eq("id", sender.id);
      result.bootstrapped = true;
      senderResults.push(result);
      continue;
    }

    const newMessageIds = new Set<string>();
    let newCursor: string = cursor;
    let pageToken: string | undefined;
    let pageGuard = 0;
    while (pageGuard++ < 20) {
      const params = new URLSearchParams({
        startHistoryId: cursor,
        historyTypes:   "messageAdded",
        labelId:        "INBOX",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const hist = await gmailFetch(`/history?${params.toString()}`, accessToken);
      if (!hist.ok) {
        const reason = hist.json?.error?.errors?.[0]?.reason;
        const errMsg = hist.json?.error?.message || `HTTP ${hist.status}`;
        if (hist.status === 404 || reason === "failedPrecondition" || reason === "notFound") {
          await supabase.from("senders")
            .update({ gmail_history_id: null, gmail_poll_error: `cursor invalidated: ${errMsg}`, gmail_last_polled_at: new Date().toISOString() })
            .eq("id", sender.id);
          result.errors.push(`cursor invalidated: ${errMsg}`);
        } else {
          await supabase.from("senders")
            .update({ gmail_poll_error: `history: ${errMsg}`, gmail_last_polled_at: new Date().toISOString() })
            .eq("id", sender.id);
          result.errors.push(`history: ${errMsg}`);
        }
        break;
      }
      const histList = hist.json?.history || [];
      for (const h of histList) {
        for (const ma of (h.messagesAdded || [])) {
          const mid = ma?.message?.id;
          if (mid) newMessageIds.add(mid);
        }
      }
      if (hist.json?.historyId) newCursor = String(hist.json.historyId);
      pageToken = hist.json?.nextPageToken;
      if (!pageToken) break;
    }
    result.fetched = newMessageIds.size;

    if (newMessageIds.size > 0) {
      const midArray = Array.from(newMessageIds);
      const { data: existing } = await supabase
        .from("events")
        .select("gmail_api_message_id")
        .eq("tenant_id", sender.tenant_id)
        .eq("channel", "email")
        .in("gmail_api_message_id", midArray);
      const seen = new Set((existing || []).map((e: any) => e.gmail_api_message_id));
      for (const seenMid of seen) {
        if (seenMid) newMessageIds.delete(seenMid);
      }
      result.skipped_dedup = seen.size;
    }

    for (const mid of newMessageIds) {
      const mres = await gmailFetch(`/messages/${mid}?format=full`, accessToken);
      if (!mres.ok) {
        result.errors.push(`get(${mid}): ${mres.json?.error?.message || mres.status}`);
        continue;
      }
      const m = mres.json;
      const followupHeader = getHeader(m.payload, "X-Example Co-Lead-Id");
      if (followupHeader) { result.processed++; continue; }

      const fromHeader = getHeader(m.payload, "From");
      const toHeader   = getHeader(m.payload, "To")    || sender.sender_email;
      const subject    = getHeader(m.payload, "Subject") || "";
      const messageIdH = getHeader(m.payload, "Message-ID") || getHeader(m.payload, "Message-Id") || "";
      const fromEmail  = extractEmail(fromHeader) || "";
      const toEmail    = extractEmail(toHeader)   || sender.sender_email;
      const { plain, html } = extractBody(m.payload);
      const body = plain || html || "";
      const threadId = m.threadId || null;

      if (!fromEmail) {
        result.errors.push(`get(${mid}): no from address`);
        continue;
      }

      const { error: rpcErr } = await supabase.rpc("process_inbound_email", {
        p_from_email: fromEmail,
        p_to_email:   toEmail,
        p_subject:    subject,
        p_body:       body,
        p_message_id: messageIdH || mid,
        p_thread_id:  threadId,
      });
      if (rpcErr) {
        result.errors.push(`rpc(${mid}): ${rpcErr.message}`);
        continue;
      }

      await supabase
        .from("events")
        .update({ gmail_api_message_id: mid })
        .eq("tenant_id", sender.tenant_id)
        .eq("channel", "email")
        .eq("direction", "inbound")
        .eq("provider_id", messageIdH || mid)
        .is("gmail_api_message_id", null);

      result.processed++;
    }

    await supabase.from("senders")
      .update({
        gmail_history_id:     newCursor,
        gmail_last_polled_at: new Date().toISOString(),
        gmail_poll_error:     result.errors.length ? result.errors.slice(0, 3).join(" | ") : null,
      })
      .eq("id", sender.id);

    senderResults.push(result);
  }

  return json(200, { ok: true, polled: senderResults.length, senders: senderResults });
});