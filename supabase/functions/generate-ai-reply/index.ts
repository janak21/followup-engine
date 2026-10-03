// generate-ai-reply
//
// Two modes:
//   1. Production: { action_id } — pulls the ai_reply action, loads agent
//      + KB + history + inbound, calls LLM, creates outbound or team_alert,
//      writes ai_reply_events audit row.
//   2. dry_run (Playground): { dry_run: true, agent_id, overrides?,
//      inbound, history? } — reuses the SAME prompt-building + LLM call
//      path but writes nothing. Returns the decision + tokens + cost so
//      the operator can tune prompts before any leads are exposed.
//
// Auth (both modes): Bearer SUPABASE_SERVICE_ROLE_KEY or INTERNAL_DISPATCH_KEY.
//
// Providers:
//   - openai      → https://api.openai.com/v1/chat/completions (json_schema strict)
//   - anthropic   → https://api.anthropic.com/v1/messages       (tool_use)
//   - openrouter  → https://openrouter.ai/api/v1/chat/completions
//                    OpenAI-compatible. Many models on OpenRouter (especially
//                    free ones: llama/mistral/deepseek/gemini-flash) do NOT
//                    support strict json_schema. We use json_object mode +
//                    an explicit prompt-side schema + defensive parsing
//                    (strip markdown fences, extract first {...}). Expect
//                    occasional intent parse failures on cheap free models.
//                    No cost estimation — OpenRouter pricing is per-model.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_DISPATCH_KEY     = Deno.env.get("INTERNAL_DISPATCH_KEY")  || "";

const ALLOWED_INTENTS = [
  "positive", "negative", "question", "objection",
  "out_of_office", "complex", "unsubscribe", "auto_reply",
  "meeting_request", "pricing_question", "other",
];

const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5":  { in: 1.00,  out: 5.00 },
  "claude-sonnet-4-6": { in: 3.00,  out: 15.00 },
  "claude-opus-4-8":   { in: 15.00, out: 75.00 },
  "gpt-4o-mini":       { in: 0.15,  out: 0.60 },
  "gpt-4o":            { in: 2.50,  out: 10.00 },
  "gpt-4.1":           { in: 2.00,  out: 8.00 },
};

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

function stripQuotedTail(s: string): string {
  if (!s) return "";
  const text = String(s);
  const patterns = [
    /On\s+.{1,200}?\bwrote:\s*/i,
    /-----\s*Original Message\s*-----/i,
    /Begin\s+forwarded\s+message:/i,
    /(^|\n)From:\s+\S.{0,200}?\n\s*(Sent|Date):\s/i,
  ];
  let earliest = text.length;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < earliest) earliest = m.index;
  }
  const gt = text.match(/(?:^|\n)\s*>/);
  if (gt && gt.index !== undefined) {
    const cut = gt.index === 0 ? 0 : gt.index + 1;
    if (cut < earliest) earliest = cut;
  }
  return text.slice(0, earliest).replace(/\s+$/g, "");
}

function estimateCost(model: string, inTokens: number, outTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return ((inTokens * p.in) + (outTokens * p.out)) / 1_000_000;
}

interface LLMResult {
  ok: true;
  intent: string;
  confidence: number;
  reasoning: string;
  reply: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  raw: any;
}
interface LLMError { ok: false; error: string; raw?: any; }
type LLMOutcome = LLMResult | LLMError;

async function callOpenAI(args: {
  apiKey: string; model: string; systemMsg: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature: number; maxTokens: number;
}): Promise<LLMOutcome> {
  const body = {
    model: args.model,
    messages: [{ role: "system", content: args.systemMsg }, ...args.messages],
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "reply_decision",
        strict: true,
        schema: {
          type: "object",
          properties: {
            intent:     { type: "string", enum: ALLOWED_INTENTS },
            confidence: { type: "number" },
            reasoning:  { type: "string" },
            reply:      { type: "string" },
          },
          required: ["intent", "confidence", "reasoning", "reply"],
          additionalProperties: false,
        },
      },
    },
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j: any;
  try { j = await res.json(); } catch { return { ok: false, error: `OpenAI non-JSON (${res.status})` }; }
  if (!res.ok) return { ok: false, error: j?.error?.message || `OpenAI HTTP ${res.status}`, raw: j };
  const content = j?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: "OpenAI returned empty content", raw: j };
  let parsed: any;
  try { parsed = JSON.parse(content); }
  catch (e) { return { ok: false, error: `OpenAI content not JSON: ${(e as Error).message}`, raw: j }; }
  const inT = j?.usage?.prompt_tokens || 0;
  const outT = j?.usage?.completion_tokens || 0;
  return {
    ok: true,
    intent:     String(parsed.intent || "other"),
    confidence: Number(parsed.confidence ?? 0),
    reasoning:  String(parsed.reasoning || ""),
    reply:      String(parsed.reply || ""),
    promptTokens: inT, completionTokens: outT,
    costUsd: estimateCost(args.model, inT, outT),
    raw: j,
  };
}

// Extract the first JSON object from a string. Handles the common failure modes
// on OpenRouter free models: markdown code fences, prose prefix like
// "Here's my response:", or trailing commentary. Best-effort — if we can't find
// any {...}, returns null and the caller surfaces the raw text as the error.
function extractJsonBlob(text: string): any | null {
  if (!text) return null;
  const s = text.trim();
  // Fast path — pure JSON.
  try { return JSON.parse(s); } catch { /* fall through */ }
  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  // Grab the first balanced {...} block. Naive brace-counting is fine for
  // our small reply shape; if the model nested objects we'll still capture
  // the outer one correctly.
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

async function callOpenRouter(args: {
  apiKey: string; model: string; systemMsg: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature: number; maxTokens: number;
}): Promise<LLMOutcome> {
  // Nudge the model toward JSON in-prompt because (a) json_object mode requires
  // the word "json" appear in the prompt and (b) free models often ignore
  // response_format entirely, so the prompt is the real enforcer.
  const systemMsgWithJsonNudge =
    args.systemMsg +
    `\n\nRespond ONLY with a single JSON object with exactly these keys: ` +
    `"intent" (string, one of the allowed values), "confidence" (number 0..1), ` +
    `"reasoning" (short string), "reply" (string). No prose before or after. No markdown code fences.`;

  const body = {
    model: args.model,
    messages: [{ role: "system", content: systemMsgWithJsonNudge }, ...args.messages],
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    response_format: { type: "json_object" },
  };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      // Optional but polite — helps OpenRouter attribute traffic in their dashboard.
      "HTTP-Referer": "https://example.com",
      "X-Title":      "Follow-Up Engine",
    },
    body: JSON.stringify(body),
  });
  let j: any;
  try { j = await res.json(); } catch { return { ok: false, error: `OpenRouter non-JSON (${res.status})` }; }
  if (!res.ok) return { ok: false, error: j?.error?.message || `OpenRouter HTTP ${res.status}`, raw: j };
  const content = j?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: "OpenRouter returned empty content", raw: j };
  const parsed = extractJsonBlob(content);
  if (!parsed) {
    return {
      ok: false,
      error: `OpenRouter content not parseable as JSON. First 200 chars: ${String(content).slice(0, 200)}`,
      raw: j,
    };
  }
  const inT  = j?.usage?.prompt_tokens     || 0;
  const outT = j?.usage?.completion_tokens || 0;
  // OpenRouter pricing varies per model and can be zero for free tier.
  // Some responses include a `usage.total_cost` field we can use directly.
  const usageCost = Number(j?.usage?.total_cost);
  const costUsd = Number.isFinite(usageCost) ? usageCost : estimateCost(args.model, inT, outT);
  return {
    ok: true,
    intent:     String(parsed.intent || "other"),
    confidence: Number(parsed.confidence ?? 0),
    reasoning:  String(parsed.reasoning || ""),
    reply:      String(parsed.reply || ""),
    promptTokens: inT, completionTokens: outT,
    costUsd,
    raw: j,
  };
}

async function callAnthropic(args: {
  apiKey: string; model: string; systemMsg: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature: number; maxTokens: number;
}): Promise<LLMOutcome> {
  const body = {
    model: args.model,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    system: args.systemMsg,
    messages: args.messages,
    tools: [{
      name: "submit_decision",
      description: "Classify the inbound and propose a reply.",
      input_schema: {
        type: "object",
        properties: {
          intent:     { type: "string", enum: ALLOWED_INTENTS },
          confidence: { type: "number" },
          reasoning:  { type: "string" },
          reply:      { type: "string" },
        },
        required: ["intent", "confidence", "reasoning", "reply"],
      },
    }],
    tool_choice: { type: "tool", name: "submit_decision" },
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         args.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify(body),
  });
  let j: any;
  try { j = await res.json(); } catch { return { ok: false, error: `Anthropic non-JSON (${res.status})` }; }
  if (!res.ok) return { ok: false, error: j?.error?.message || `Anthropic HTTP ${res.status}`, raw: j };
  const toolUse = (j?.content || []).find((c: any) => c?.type === "tool_use");
  if (!toolUse) return { ok: false, error: "Anthropic returned no tool_use", raw: j };
  const p = toolUse.input || {};
  const inT = j?.usage?.input_tokens || 0;
  const outT = j?.usage?.output_tokens || 0;
  return {
    ok: true,
    intent:     String(p.intent || "other"),
    confidence: Number(p.confidence ?? 0),
    reasoning:  String(p.reasoning || ""),
    reply:      String(p.reply || ""),
    promptTokens: inT, completionTokens: outT,
    costUsd: estimateCost(args.model, inT, outT),
    raw: j,
  };
}

function buildPrompt(opts: {
  agent: any;
  kb: Array<{ title: string; content: string }>;
  lead: { first_name?: string | null; last_name?: string | null; email?: string | null; email_conversation_count?: number };
  history: Array<{ direction: string; body: string | null }>;
  inboundBody: string;
}): { systemMsg: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const kbBlock = opts.kb.length === 0 ? "" :
    "\n\n## Knowledge Base\n\n" + opts.kb.map((k) => `### ${k.title}\n${k.content}`).join("\n\n");

  const systemMsg =
    `${opts.agent.system_prompt}\n\n` +
    `## Output schema (mandatory)\n` +
    `Return EXACTLY these fields:\n` +
    `- intent (one of: ${ALLOWED_INTENTS.join(", ")})\n` +
    `- confidence (number 0..1, your certainty in the intent)\n` +
    `- reasoning (1–2 sentences explaining the intent)\n` +
    `- reply (the suggested reply body, plain text, no signature)\n` +
    `\n## Lead\n` +
    `Name: ${[opts.lead.first_name, opts.lead.last_name].filter(Boolean).join(" ") || "unknown"}\n` +
    `Email: ${opts.lead.email || "unknown"}\n` +
    `Prior reply count from us (AI): ${opts.lead.email_conversation_count ?? 0}\n` +
    kbBlock;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = (opts.history || []).map((e) => ({
    role: e.direction === "inbound" ? "user" : "assistant",
    content: e.direction === "inbound" ? stripQuotedTail(e.body || "") : (e.body || ""),
  }));
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: stripQuotedTail(opts.inboundBody || "") });
  }
  return { systemMsg, messages };
}

async function callLLM(args: { agent: any; apiKey: string; systemMsg: string;
                                messages: Array<{ role: "user"|"assistant"; content: string }> }): Promise<LLMOutcome> {
  if (args.agent.provider === "openai") {
    return await callOpenAI({
      apiKey: args.apiKey, model: args.agent.model,
      systemMsg: args.systemMsg, messages: args.messages,
      temperature: Number(args.agent.temperature), maxTokens: Number(args.agent.max_tokens),
    });
  }
  if (args.agent.provider === "openrouter") {
    return await callOpenRouter({
      apiKey: args.apiKey, model: args.agent.model,
      systemMsg: args.systemMsg, messages: args.messages,
      temperature: Number(args.agent.temperature), maxTokens: Number(args.agent.max_tokens),
    });
  }
  return await callAnthropic({
    apiKey: args.apiKey, model: args.agent.model,
    systemMsg: args.systemMsg, messages: args.messages,
    temperature: Number(args.agent.temperature), maxTokens: Number(args.agent.max_tokens),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "Use POST." });
  if (!isAuthorized(req)) return json(401, { ok: false, error: "Unauthorized" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (body?.dry_run) {
    const agentId = body?.agent_id;
    if (!agentId) return json(400, { ok: false, stage: "dry_run", error: "agent_id required" });

    const { data: agent } = await supabase.from("ai_agents").select("*").eq("id", agentId).maybeSingle();
    if (!agent) return json(404, { ok: false, stage: "dry_run", error: "agent not found" });

    const o = body?.overrides || {};
    const effective = {
      ...agent,
      provider:              o.provider             ?? agent.provider,
      model:                 o.model                ?? agent.model,
      system_prompt:         o.system_prompt        ?? agent.system_prompt,
      temperature:           o.temperature          ?? agent.temperature,
      max_tokens:            o.max_tokens           ?? agent.max_tokens,
      escalate_on_intents:   o.escalate_on_intents  ?? agent.escalate_on_intents,
      confidence_threshold:  o.confidence_threshold ?? agent.confidence_threshold,
    };

    const { data: kb } = await supabase.from("ai_agent_knowledge")
      .select("title, content").eq("agent_id", agentId).eq("active", true)
      .order("sort_order", { ascending: true });

    const { data: apiKey, error: secretErr } = await supabase.rpc("get_tenant_secret", {
      p_tenant_id: agent.tenant_id,
      p_provider:  effective.provider,
      p_key:       "api_key",
    });
    if (secretErr) {
      return json(500, { ok: false, stage: "dry_run", error: `Vault read failed: ${secretErr.message}` });
    }
    if (!apiKey) {
      return json(400, { ok: false, stage: "dry_run", error: `Missing ${effective.provider} API key in tenant secrets.` });
    }

    const inboundBody = body?.inbound?.body || "";
    if (!inboundBody.trim()) return json(400, { ok: false, stage: "dry_run", error: "inbound.body required" });

    const fakeLead = {
      first_name: body?.lead?.first_name || "Test Lead",
      last_name:  body?.lead?.last_name  || null,
      email:      body?.lead?.email      || "test@example.com",
      email_conversation_count: body?.lead?.email_conversation_count || 0,
    };
    const history = Array.isArray(body?.history) ? body.history : [];

    const { systemMsg, messages } = buildPrompt({ agent: effective, kb: kb || [], lead: fakeLead, history, inboundBody });
    const llm = await callLLM({ agent: effective, apiKey, systemMsg, messages });

    if (!llm.ok) return json(502, { ok: false, stage: "dry_run_llm", error: llm.error, raw: llm.raw });

    const escalateOnIntent = Array.isArray(effective.escalate_on_intents) && effective.escalate_on_intents.includes(llm.intent);
    const lowConfidence    = llm.confidence < Number(effective.confidence_threshold);
    const shouldEscalate   = escalateOnIntent || lowConfidence;
    const escalationReason = !shouldEscalate ? null :
        escalateOnIntent ? `intent=${llm.intent} matches escalation list`
                         : `confidence=${llm.confidence} below threshold ${effective.confidence_threshold}`;

    return json(200, {
      ok: true,
      dry_run: true,
      decision:           shouldEscalate ? "escalated" : "replied",
      intent:             llm.intent,
      confidence:         llm.confidence,
      reasoning:          llm.reasoning,
      reply:              llm.reply,
      escalation_reason:  escalationReason,
      prompt_tokens:      llm.promptTokens,
      completion_tokens:  llm.completionTokens,
      cost_estimate_usd:  llm.costUsd,
      effective_agent: {
        provider:             effective.provider,
        model:                effective.model,
        temperature:          effective.temperature,
        max_tokens:           effective.max_tokens,
        confidence_threshold: effective.confidence_threshold,
        escalate_on_intents:  effective.escalate_on_intents,
        kb_items_used:        (kb || []).length,
      },
    });
  }

  // PRODUCTION MODE
  const actionId = body?.action_id;
  if (!actionId) return json(400, { ok: false, error: "Missing action_id" });

  const { data: action, error: actErr } = await supabase
    .from("actions").select("*").eq("id", actionId).maybeSingle();
  if (actErr || !action) return json(404, { ok: false, stage: "load_action", error: actErr?.message || "action not found" });
  if (action.action_type !== "ai_reply") {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `wrong action_type: ${action.action_type}` });
    return json(400, { ok: false, stage: "load_action", error: "action is not ai_reply" });
  }
  if (action.status === "completed") return json(200, { ok: true, idempotent: true });

  const agentId        = action.payload?.agent_id;
  const inboundEventId = action.payload?.inbound_event_id;
  if (!agentId || !inboundEventId) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: "payload missing agent_id or inbound_event_id" });
    return json(400, { ok: false, stage: "load_action", error: "payload missing keys" });
  }

  const { data: tenant } = await supabase.from("tenants")
    .select("id, ai_replies_enabled").eq("id", action.tenant_id).maybeSingle();
  if (!tenant?.ai_replies_enabled) {
    await supabase.from("actions").update({ status: "cancelled", error_message: "Tenant AI replies disabled" }).eq("id", actionId);
    return json(200, { ok: true, skipped: true, reason: "tenant_disabled" });
  }

  const { data: agent } = await supabase.from("ai_agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: "Agent not found" });
    return json(404, { ok: false, stage: "load_agent", error: "agent not found" });
  }
  if (!agent.enabled) {
    await supabase.from("actions").update({ status: "cancelled", error_message: `Agent "${agent.name}" is disabled` }).eq("id", actionId);
    return json(200, { ok: true, skipped: true, reason: "agent_disabled" });
  }

  const { data: apiKey, error: secretErr } = await supabase.rpc("get_tenant_secret", {
    p_tenant_id: action.tenant_id,
    p_provider:  agent.provider,
    p_key:       "api_key",
  });
  if (secretErr) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `Vault read failed: ${secretErr.message}` });
    return json(500, { ok: false, stage: "load_credentials", error: secretErr.message });
  }
  if (!apiKey) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `Missing ${agent.provider} API key.` });
    return json(400, { ok: false, stage: "load_credentials", error: "api key missing" });
  }

  const [leadRes, kbRes, histRes, inboundRes] = await Promise.all([
    supabase.from("leads").select("id, first_name, last_name, email, journey_template, email_conversation_count").eq("id", action.lead_id).maybeSingle(),
    supabase.from("ai_agent_knowledge").select("title, content").eq("agent_id", agent.id).eq("active", true).order("sort_order", { ascending: true }),
    supabase.from("events").select("direction, body, subject, created_at").eq("lead_id", action.lead_id).eq("channel", "email").order("created_at", { ascending: true }).limit(20),
    supabase.from("events").select("subject, body, from_address, raw_payload, created_at").eq("id", inboundEventId).maybeSingle(),
  ]);
  if (!leadRes.data || !inboundRes.data) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: "Lead or inbound event missing" });
    return json(404, { ok: false, stage: "load_context", error: "missing context" });
  }

  const { systemMsg, messages } = buildPrompt({
    agent, kb: kbRes.data || [], lead: leadRes.data,
    history: histRes.data || [], inboundBody: inboundRes.data.body || "",
  });

  const llm = await callLLM({ agent, apiKey, systemMsg, messages });
  if (!llm.ok) {
    await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `LLM: ${llm.error}` });
    await supabase.from("ai_reply_events").insert({
      tenant_id: action.tenant_id, lead_id: action.lead_id, agent_id: agent.id,
      inbound_event_id: inboundEventId, escalation_reason: `llm_error: ${llm.error}`,
      raw_response: llm.raw || null,
    });
    return json(502, { ok: false, stage: "llm", error: llm.error });
  }

  const escalateOnIntent = Array.isArray(agent.escalate_on_intents) && agent.escalate_on_intents.includes(llm.intent);
  const lowConfidence    = llm.confidence < Number(agent.confidence_threshold);
  const shouldEscalate   = escalateOnIntent || lowConfidence;
  const escalationReason = !shouldEscalate ? null :
      escalateOnIntent ? `intent=${llm.intent} matches escalation list`
                       : `confidence=${llm.confidence} below threshold ${agent.confidence_threshold}`;

  let outboundActionId: string | null = null;
  if (shouldEscalate) {
    const { data: alertAction, error: alertErr } = await supabase.from("actions").insert({
      tenant_id: action.tenant_id, lead_id: action.lead_id, action_type: "team_alert",
      step_index: action.step_index, run_at: new Date().toISOString(), status: "pending",
      template_key: "__ai_escalation__", idempotency_key: `ai_escalation:${actionId}`,
      payload: {
        source: "ai_reply_escalation", reason: escalationReason, agent_id: agent.id, agent_name: agent.name,
        inbound_event_id: inboundEventId, intent: llm.intent, confidence: llm.confidence,
        reasoning: llm.reasoning, ai_suggested_reply: llm.reply,
      },
    }).select("id").single();
    if (alertErr && !alertErr.message?.includes("duplicate")) {
      await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `team_alert insert: ${alertErr.message}` });
      return json(500, { ok: false, stage: "create_team_alert", error: alertErr.message });
    }
    outboundActionId = alertAction?.id || null;
  } else {
    const { data: outAction, error: outErr } = await supabase.from("actions").insert({
      tenant_id: action.tenant_id, lead_id: action.lead_id, action_type: "email",
      step_index: action.step_index, run_at: new Date().toISOString(), status: "pending",
      template_key: "__ai_reply__", idempotency_key: `ai_outbound:${actionId}`,
      payload: {
        source: "ai_reply", agent_id: agent.id, agent_name: agent.name,
        inbound_event_id: inboundEventId, ai_intent: llm.intent, ai_confidence: llm.confidence, ai_reasoning: llm.reasoning,
        inline: { subject: "", body: llm.reply },
      },
    }).select("id").single();
    if (outErr && !outErr.message?.includes("duplicate")) {
      await supabase.rpc("mark_action_failed", { p_action_id: actionId, p_error_message: `outbound insert: ${outErr.message}` });
      return json(500, { ok: false, stage: "create_outbound", error: outErr.message });
    }
    outboundActionId = outAction?.id || null;
  }

  await supabase.from("ai_reply_events").insert({
    tenant_id: action.tenant_id, lead_id: action.lead_id, agent_id: agent.id,
    inbound_event_id: inboundEventId, intent: llm.intent, confidence: llm.confidence,
    reasoning: llm.reasoning,
    outbound_action_id: shouldEscalate ? null : outboundActionId,
    escalation_reason: escalationReason,
    prompt_tokens: llm.promptTokens, completion_tokens: llm.completionTokens,
    cost_estimate_usd: llm.costUsd,
    raw_response: {
      reply: llm.reply, provider: agent.provider, model: agent.model,
      raw_excerpt: typeof llm.raw === "object" ? { id: llm.raw?.id, usage: llm.raw?.usage } : null,
    },
  });

  await supabase.from("actions").update({
    status: "completed", completed_at: new Date().toISOString(),
    result: {
      ai_decision: shouldEscalate ? "escalated" : "replied",
      intent: llm.intent, confidence: llm.confidence,
      escalation_reason: escalationReason, outbound_action_id: outboundActionId,
      cost_estimate_usd: llm.costUsd,
    },
    error_message: null,
  }).eq("id", actionId);

  return json(200, {
    ok: true, action_id: actionId,
    decision: shouldEscalate ? "escalated" : "replied",
    intent: llm.intent, confidence: llm.confidence,
    outbound_action_id: outboundActionId, cost_estimate_usd: llm.costUsd,
  });
});