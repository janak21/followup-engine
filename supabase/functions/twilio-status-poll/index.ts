// Twilio status poller — multi-tenant.
//
// For each outbound SMS event with delivery_status=null, looks up the
// originating tenant's Twilio account_sid + auth_token from tenant_credentials
// (NOT from edge-function env vars), calls Twilio's REST API for the message
// resource, and writes the result via update_sms_delivery_status.
//
// Onboarding a new client = add their Twilio credentials in
// Settings → Credentials → Twilio (account_sid, auth_token, from_number).
// Nothing on the function side changes per-client.
//
// Two modes:
//   POST /functions/v1/twilio-status-poll               — sweep stale rows
//   POST /functions/v1/twilio-status-poll?sid=SMxxxx    — refresh one
//
// Idempotent. Safe to run on a schedule.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function fetchTwilioStatus(
  sid: string,
  account_sid: string,
  auth_token: string,
) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages/${sid}.json`;
  const auth = btoa(`${account_sid}:${auth_token}`);
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) {
    const text = await r.text();
    return { ok: false, status: r.status, error: text };
  }
  const body = await r.json();
  return {
    ok: true,
    status: body.status as string,
    error_code: body.error_code,
    error_message: body.error_message,
    body,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json(405, { ok: false, error: "Use POST or GET." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const url = new URL(req.url);
  const oneSid = url.searchParams.get("sid");

  // Pull the SIDs to check.
  let sids: string[] = [];
  if (oneSid) {
    sids = [oneSid];
  } else {
    const { data, error } = await supabase.rpc("list_stale_twilio_sids", { p_max: 200 });
    if (error) return json(500, { ok: false, error: error.message });
    sids = (data || []).map((r: { provider_id: string }) => r.provider_id);
  }

  // Cache creds per tenant so we don't refetch for batches from the same tenant.
  const credsCache = new Map<string, { account_sid: string; auth_token: string } | null>();

  const results: Array<Record<string, unknown>> = [];
  for (const sid of sids) {
    // Resolve the tenant + creds for THIS sid. Per-tenant lookup means we
    // hit Twilio with the account that actually sent the message, even if
    // the system runs many tenants in parallel.
    const { data: credsRows, error: credsErr } = await supabase
      .rpc("resolve_twilio_creds_for_sid", { p_sid: sid });
    if (credsErr) {
      results.push({ sid, error: `resolve_twilio_creds_for_sid: ${credsErr.message}` });
      continue;
    }
    const cred = (credsRows && credsRows[0]) || null;
    if (!cred || !cred.tenant_id) {
      results.push({ sid, skipped: "no matching event row" });
      continue;
    }
    if (!cred.has_creds) {
      results.push({
        sid,
        tenant_id: cred.tenant_id,
        skipped: "tenant has no Twilio account_sid/auth_token configured. Add them in Settings → Credentials → Twilio.",
      });
      continue;
    }

    const tw = await fetchTwilioStatus(sid, cred.account_sid, cred.auth_token);
    if (!tw.ok) {
      results.push({ sid, tenant_id: cred.tenant_id, twilio_http: tw.status, error: tw.error });
      continue;
    }

    const { data: rpcRes, error: rpcErr } = await supabase.rpc("update_sms_delivery_status", {
      p_sid:           sid,
      p_status:        tw.status,
      p_error_code:    tw.error_code ? String(tw.error_code) : null,
      p_error_message: tw.error_message || null,
      p_raw:           { source: "twilio-status-poll", tenant_id: cred.tenant_id, ...(tw.body || {}) },
    });
    if (rpcErr) {
      results.push({ sid, tenant_id: cred.tenant_id, twilio_status: tw.status, rpc_error: rpcErr.message });
    } else {
      results.push({ sid, tenant_id: cred.tenant_id, twilio_status: tw.status, rpc: rpcRes });
    }
  }

  return json(200, { ok: true, checked: sids.length, results });
});