// Posts engine alerts to the ops Slack webhook. The SQL scanner passes the
// Vault webhook URL in the request body; this function stores no Slack secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_DISPATCH_KEY = Deno.env.get("INTERNAL_DISPATCH_KEY") || "";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false });

  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (
    token !== SUPABASE_SERVICE_ROLE_KEY &&
    (!INTERNAL_DISPATCH_KEY || token !== INTERNAL_DISPATCH_KEY)
  ) {
    return json(401, { ok: false });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "bad json" });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { ok: false, error: "body must be an object" });
  }

  const { webhook_url, text } = body as Record<string, unknown>;
  if (typeof webhook_url !== "string" || webhook_url.length === 0 ||
      typeof text !== "string" || text.length === 0) {
    return json(400, { ok: false, error: "webhook_url and text required" });
  }
  if (!/^https:\/\/hooks\.slack\.com\//.test(webhook_url)) {
    return json(400, { ok: false, error: "only hooks.slack.com webhooks allowed" });
  }

  const res = await fetch(webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 3500) }),
  });

  return json(res.ok ? 200 : 502, { ok: res.ok, slack_status: res.status });
});
