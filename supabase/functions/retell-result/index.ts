// Retell post-call webhook receiver.
// URL: POST /functions/v1/retell-result
//
// Native Retell result receiver. Retell's agent posts the call analysis JSON
// here when a call ends; we hand it straight to the Supabase
// RPC process_retell_call_result which:
//   - matches the event row by provider_id = call_id
//   - writes call_outcome, duration, recording_url, transcript, summary,
//     disconnection_reason onto the event
//   - splats call_analysis.custom_analysis_data into leads.custom_fields
//   - advances the journey on the resolved outcome
//
// ── Authenticity (mechanism: X-Retell-Signature) ───────────────────────────
// Retell signs every webhook with HMAC-SHA256 keyed by the ACCOUNT's Retell
// API Key, over (rawBody + timestampString). The header format is
//   X-Retell-Signature: v=<unix-millis>,d=<hex-sha256-digest>
// with a 5-minute replay window. Reference:
//   https://docs.retellai.com/features/secure-webhook  ("Verify Without SDK")
//
// ── Multi-tenant key resolution ────────────────────────────────────────────
// Outbound dispatch (dispatch-retell-call) reads the Retell API key PER TENANT
// from tenant_credentials(provider='retell').config.api_key. The verifier does
// the same so that a client bringing their own Retell account still validates.
//
// Resolution order at request time:
//   1. Parse the (untrusted) body for call.agent_id + call.from_number / to_number.
//   2. resolve_retell_credentials(agent_id, phone) → {tenant_id, api_key}.
//   3. If a per-tenant key is found, verify against THAT key only — fail-closed.
//      We do NOT fall through to the env key when a tenant hit exists, otherwise
//      an attacker claiming tenant A's agent_id could be validated against the
//      platform's own Retell key. The signature still proves authenticity.
//   4. If NO per-tenant key is found, fall back to the Edge Function env var
//      `RETELL_API_KEY` (single-account rollout — all webhooks signed by the
//      platform's one Retell account). `RETELL_WEBHOOK_SECRET` is honored as an
//      alias; if both are set, `RETELL_API_KEY` wins. Once every tenant carries
//      its own retell credential, the env var can be removed.
//
// Retell Console / Dashboard configuration (per Retell account / per tenant):
//   1. In the tenant's Retell account → API Keys, create a key with the
//      "Webhook" badge. Also create one WITHOUT the badge for outbound calls
//      and store it in tenant_credentials.config.api_key (provider='retell').
//      The webhook-badge key and the outbound key may be the same value.
//   2. In Retell → Webhooks (account-level) or per-agent `webhook_url`, point
//      the URL at:
//        https://<project-ref>.supabase.co/functions/v1/retell-result
//      Replace <project-ref> with your Supabase project ref.
//   3. Retell signs automatically — there is no "enable signing" toggle.
//   4. For the SINGLE-ACCOUNT platform during rollout, also set the Edge
//      Function secret `RETELL_API_KEY` (used only when no per-tenant cred is
//      found). Once all tenants bring their own Retell account, unset it.
//
// Rollout escape hatch (mirrors the Twilio ticket):
//   RETELL_SIGNATURE_ENFORCEMENT=log_only  -> log every violation to
//     error_logs (workflow_name='retell_result_signature', severity=warning)
//     and still process the RPC. Used for a safe rollout window.
//   unset / any other value -> enforce: reject unsigned/invalid requests
//     with 403 and DO NOT call the mutating RPC.
//
// verify_jwt=false is correct — Retell can't carry a Supabase JWT; the
// X-Retell-Signature is the real authn boundary.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyRetellWebhook } from "../_shared/retell-signature.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Signing secret: prefer RETELL_API_KEY (matches Retell docs/SDK samples);
// fall back to RETELL_WEBHOOK_SECRET for operators who prefer that name.
const RETELL_API_KEY = Deno.env.get("RETELL_API_KEY") ?? Deno.env.get("RETELL_WEBHOOK_SECRET") ?? "";

// Rollout escape hatch — see header comment.
const ENFORCEMENT = Deno.env.get("RETELL_SIGNATURE_ENFORCEMENT") ?? "enforce";
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

  // Read the raw body ONCE — Retell signs the exact bytes, so we must not
  // re-serialize. We pass `rawText` to the verifier and parse JSON ourselves.
  let rawText = "";
  try {
    rawText = await req.text();
  } catch {
    return json(400, { ok: false, error: "Could not read request body." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Retell signature validation (multi-tenant) ───────────────────────────
  const sigHeader = req.headers.get("X-Retell-Signature");

  // Parse the (untrusted) body just to pick the resolver inputs — the
  // signature itself is computed over `rawText`, NOT re-serialized JSON, so
  // reading these fields for key selection is safe.
  let resolverAgentId: string | null = null;
  let resolverPhone: string | null = null;
  let preParsed: any = null;
  try {
    preParsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    preParsed = null; // signature will fail naturally
  }
  if (preParsed && typeof preParsed === "object") {
    const callObj = (preParsed as any).call ?? {};
    resolverAgentId = String(callObj.agent_id ?? preParsed.agent_id ?? "") || null;
    resolverPhone = String(callObj.from_number ?? preParsed.from_number ?? callObj.to_number ?? "") || null;
  }

  let resolvedTenantId: string | null = null;
  let verifyKey: string | null = null;
  let keySource: "tenant" | "env" | "none" = "none";

  if (resolverAgentId || resolverPhone) {
    const { data: resolved, error: resErr } = await supabase.rpc("resolve_retell_credentials", {
      p_agent_id: resolverAgentId ?? "",
      p_phone: resolverPhone ?? "",
    });
    if (resErr) {
      console.error("retell-result: resolve_retell_credentials error", resErr);
    } else if (resolved && resolved.api_key) {
      resolvedTenantId = resolved.tenant_id ?? null;
      verifyKey = resolved.api_key;
      keySource = "tenant";
    }
  }

  // Fallback to env only when NO per-tenant credential matched. Fail-closed:
  // if the resolver found a tenant but no key, we do NOT silently env-fallback.
  if (keySource === "none") {
    if (RETELL_API_KEY) {
      verifyKey = RETELL_API_KEY;
      keySource = "env";
    } else {
      await supabase.from("error_logs").insert({
        workflow_name: "retell_result_signature",
        error_message: "Retell signature validation failed: no signing key (neither per-tenant credential nor env RETELL_API_KEY)",
        raw_error: { has_sig: !!sigHeader, body_len: rawText.length, agent_id: resolverAgentId, phone: resolverPhone, key_source: keySource },
        severity: "error",
        status: "open",
      });
      if (LOG_ONLY) {
        console.warn("retell-result: no signing key anywhere but LOG_ONLY — proceeding");
      } else {
        return json(500, { ok: false, error: "Retell signing key not configured for this request." });
      }
    }
  }

  if (verifyKey && keySource !== "none") {
    const verified = await verifyRetellWebhook({
      apiKey: verifyKey,
      rawBody: rawText,
      signatureHeader: sigHeader,
    });
    if (!verified.ok) {
      await supabase.from("error_logs").insert({
        workflow_name: "retell_result_signature",
        error_message: `Retell signature rejected: ${verified.reason}`,
        raw_error: {
          has_sig: !!sigHeader,
          body_len: rawText.length,
          body_preview: rawText.slice(0, 200),
          tenant_id: resolvedTenantId,
          agent_id: resolverAgentId,
          phone: resolverPhone,
          key_source: keySource,
        },
        severity: "warning",
        status: "open",
      });
      if (LOG_ONLY) {
        console.warn("retell-result: signature INVALID but LOG_ONLY — proceeding", { reason: verified.reason, key_source: keySource });
      } else {
        return json(403, { ok: false, error: "Invalid Retell signature." });
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  let payload: unknown = preParsed;
  // Reject garbage JSON after the signature gate (a real Retell webhook is
  // always JSON; non-JSON would have failed signature verification too).
  if (!payload || typeof payload !== "object") {
    return json(400, { ok: false, error: "Invalid JSON body." });
  }

  const { data, error } = await supabase.rpc("process_retell_call_result", {
    p_payload: payload,
  });

  if (error) {
    // Surface the RPC error in the response and the function logs so the
    // operator can find it without diffing Postgres logs. Retell will retry
    // on 5xx so we want real failures to be 5xx, not silent 2xx.
    console.error("process_retell_call_result error:", error);
    return json(500, { ok: false, error: error.message, hint: error.hint });
  }

  return json(200, { ok: true, ...(data as Record<string, unknown> || {}) });
});
