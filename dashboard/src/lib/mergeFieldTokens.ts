// Channel-aware merge-field vocabulary.
//
// Two server resolvers exist and they DO NOT share a token syntax:
//
//   • public.render_template(text, lead)  — email / sms / call / team_alert.
//     Resolves BARE tokens only: {{first_name}}, {{phone}}, {{lead_id}}, … and
//     each custom field as a BARE {{<key>}} (it iterates custom_fields via
//     jsonb_each_text). It has NO {{custom.*}} and NO webhook-payload support.
//
//   • public.resolve_workflow_expr(expr, …) — http_request / conditional_split
//     and anything else expression-resolved. Resolves NAMESPACED expressions
//     only: {{lead.<col>}}, {{custom.<key>}}, {{payload.<path>}}, {{context.*}},
//     {{steps.*}}. A bare token like {{first_name}} is returned literally.
//
// Emitting one fixed vocabulary is wrong for at least one channel, so the token
// syntax is derived from the channel. The lists below are transcribed from the
// LIVE function bodies on DEV (render_template's replace() list; the leads
// columns to_jsonb(lead) exposes to resolve_workflow_expr).

import { flattenPayloadScalars } from "./webhookPayloadMapping.js"

export type ResolverMode = "template" | "expr"

export interface MergeToken {
  token: string
  label: string
}

export interface MergeFieldGroup {
  label: string
  tokens: MergeToken[]
}

export interface CustomFieldDef {
  key: string
  label?: string | null
}

interface WebhookSample {
  payload?: unknown
}

// Create Lead field mapping shape ({ destination, source: { source } }) as
// produced by mergeWorkflowFieldMapping.
export interface WebhookLeadMapping {
  destination?: string | null
  source?: { source?: string | null } | string | null
}

interface LeadField {
  label: string
  template: string
  exprCol: string
}

// Channels whose free-text fields are resolved by render_template.
export const TEMPLATE_CHANNELS = new Set(["email", "sms", "call", "team_alert"])

// Map a channel to its resolver mode. Anything not template-resolved (http_request,
// conditional_split, …) is expression-resolved by resolve_workflow_expr.
export function resolverForChannel(channel: string): ResolverMode {
  return TEMPLATE_CHANNELS.has(channel) ? "template" : "expr"
}

// Standard lead fields. `template` is the bare token render_template replaces;
// `exprCol` is the real leads column resolve_workflow_expr reads via {{lead.<col>}}.
// Note the aliasing: render_template exposes {{phone}}/{{address}}/{{lead_id}}
// while the expr resolver only sees the actual columns (phone_e164, address_line1,
// id) — there is no lead.phone / lead.address / lead.lead_id column.
export const LEAD_FIELDS: LeadField[] = [
  { label: "First name",    template: "first_name",    exprCol: "first_name" },
  { label: "Last name",     template: "last_name",     exprCol: "last_name" },
  { label: "Email",         template: "email",         exprCol: "email" },
  { label: "Phone",         template: "phone",         exprCol: "phone_e164" },
  { label: "Phone (E.164)", template: "phone_e164",    exprCol: "phone_e164" },
  { label: "Phone (raw)",   template: "phone_raw",     exprCol: "phone_raw" },
  { label: "Source",        template: "source",        exprCol: "source" },
  { label: "Campaign type", template: "campaign_type", exprCol: "campaign_type" },
  { label: "ZIP code",      template: "zip_code",      exprCol: "zip_code" },
  { label: "Address",       template: "address",       exprCol: "address_line1" },
  { label: "Lead ID",       template: "lead_id",       exprCol: "id" },
]

// Build the grouped field list for a channel. Each token entry is { token, label }
// where `token` is the merge tag inserted and `label` is what the operator sees.
// Pure (no React) so the per-channel vocabulary can be unit-tested directly.
export function buildMergeFieldGroups(customFields: CustomFieldDef[] = [], samples: WebhookSample[] = [], channel = "email", webhookMappings: WebhookLeadMapping[] = []): MergeFieldGroup[] {
  const mode = resolverForChannel(channel)

  const leadTokens: MergeToken[] = []
  const seen = new Set<string>()
  for (const f of LEAD_FIELDS) {
    const token = mode === "expr" ? `{{lead.${f.exprCol}}}` : `{{${f.template}}}`
    // In expr mode the {{phone}} alias collapses onto {{lead.phone_e164}}; keep the
    // first occurrence so we never emit a duplicate token (also a duplicate React key).
    if (seen.has(token)) continue
    seen.add(token)
    leadTokens.push({ token, label: f.label })
  }
  const groups: MergeFieldGroup[] = [{ label: "Lead", tokens: leadTokens }]

  if (customFields.length > 0) {
    groups.push({
      label: "Custom fields",
      tokens: customFields.map((f) => ({
        token: mode === "expr" ? `{{custom.${f.key}}}` : `{{${f.key}}}`,
        label: f.label || f.key,
      })),
    })
  }

  // Template channels can't read raw payloads (render_template has no payload
  // support) — but payload fields that Create Lead maps onto the lead ARE
  // usable, as the lead-side token. Surface those as "Webhook data" so
  // operators can insert their webhook fields into SMS/email copy directly.
  if (mode === "template" && webhookMappings.length > 0) {
    const tokens: MergeToken[] = []
    const seenTokens = new Set<string>()
    for (const m of webhookMappings) {
      const destination = String(m?.destination || "").trim()
      if (!destination) continue
      const rawSource = typeof m?.source === "string" ? m.source : m?.source?.source
      const path = String(rawSource || "").replace(/^payload\./, "")
      const key = destination.startsWith("custom.") ? destination.slice(7) : destination
      // Skip destinations render_template can't resolve as a bare token.
      const isStandard = LEAD_FIELDS.some((f) => f.template === key)
      if (!isStandard && !destination.startsWith("custom.")) continue
      const token = `{{${key}}}`
      if (seenTokens.has(token)) continue
      seenTokens.add(token)
      const pretty = key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())
      tokens.push({ token, label: path ? `${pretty} — ${path}` : pretty })
    }
    if (tokens.length > 0) groups.push({ label: "Webhook data", tokens })
  }

  // Webhook payload paths only resolve under resolve_workflow_expr ({{payload.<path>}}).
  // render_template has no payload support, so template channels omit this group
  // entirely rather than offering tokens that would send literally.
  if (mode === "expr") {
    const sample = samples[0]
    if (sample?.payload) {
      const rows: Array<{ path: string }> = flattenPayloadScalars(sample.payload).filter((r: { path?: string }) => r.path)
      if (rows.length > 0) {
        groups.push({
          label: "Webhook payload",
          tokens: rows.slice(0, 40).map((r) => ({ token: `{{payload.${r.path}}}`, label: r.path })),
        })
      }
    }
  }

  return groups
}

// Client-side preview renderer for the TEMPLATE channels. Mirrors render_template
// exactly: literal replacement of the bare standard tokens (standard first), then
// each bare custom-field key. It deliberately resolves neither {{custom.*}} nor
// {{payload.*}} so the preview never shows a value the real send won't produce.
export function renderTemplatePreview(text: unknown, sample: Record<string, unknown> = {}): string {
  const s = sample || {}
  const bare: Record<string, unknown> = {
    lead_id:       s.lead_id ?? s.id ?? "",
    first_name:    s.first_name || "Alex",
    last_name:     s.last_name || "Sample",
    email:         s.email || "sample.lead@example.com",
    phone_raw:     s.phone_raw || s.phone || "+15555550123",
    phone_e164:    s.phone_e164 || s.phone || "+15555550123",
    campaign_type: s.campaign_type || "",
    source:        s.source || "",
    zip_code:      s.zip_code || "",
    address:       s.address_line1 || s.address || "",
  }
  bare.phone = bare.phone_e164 || bare.phone_raw

  let out = String(text ?? "")
  // Standard bare tokens (render_template replaces these first, all occurrences).
  for (const [k, v] of Object.entries(bare)) out = out.split(`{{${k}}}`).join(String(v ?? ""))
  // …then bare custom-field keys, exactly as render_template iterates custom_fields.
  const custom = (s.custom_fields || {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(custom)) out = out.split(`{{${k}}}`).join(v == null ? "" : String(v))
  return out
}
