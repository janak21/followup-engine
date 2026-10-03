"use client"

import React, { useState, useMemo } from "react"
import {
  Search, BookOpen, GitFork, Database, AlertTriangle,
  HelpCircle, Code, Play, Check, Copy, Sparkles,
  ExternalLink, ChevronDown, ChevronUp, RefreshCw,
  AlertCircle, Mail, MessageSquare, Bot, Users, Zap, Phone, Rocket
} from "lucide-react"
import { AppIcon } from "@/components/AppIcon"

// Complete array of static documentation articles
const ARTICLES = [
  {
    id: "whats-new-2026-06",
    category: "updates",
    title: "What's New — Major System Updates",
    subtitle: "Recent capabilities, what changed in the daily journey, and what you need to configure once.",
    icon: Sparkles,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          A batch of upgrades landed across the engine, the journey builder, and the integrations. Most of it is automatic — you don't have to change how you build journeys. A few things need a one-time setup; those are flagged with <strong className="text-amber-600 dark:text-amber-400">Action required</strong>.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Native Retell call dispatch
        </h4>
        <p>
          Calls now fire directly from the engine to Retell — no intermediary journey. The dispatcher locks each pending call and triggers the dispatch over a direct HTTPS call to Retell. Faster (fewer hops), more reliable (fewer moving parts), and tenant-scoped (each client's API key is used for their own calls automatically).
        </p>
        <p className="text-[11px] text-zinc-500 italic">
          You don't change anything in your journeys. Existing call steps work as-is.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Dynamic Variables on call nodes
        </h4>
        <p>
          Each call step now has a <strong>Dynamic Variables (to agent)</strong> section. Declare <code>{`{key: value}`}</code> pairs that get passed to your Retell agent at call time. Values support merge tags — <code>{`{{first_name}}`}</code>, <code>{`{{custom.coverage_type}}`}</code>, <code>{`{{raw_payload.x.y}}`}</code> — and resolve against the lead being called.
        </p>
        <p>
          <strong>Why this matters:</strong> one Retell agent → many use cases. Same agent prompt, different runtime context per journey. See the dedicated <em>"Dynamic Variables on Call Nodes"</em> article for examples.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Retell agent + phone number sync
        </h4>
        <p>
          Settings → Credentials → Retell now takes an <strong>API key</strong>. After saving, hit <strong>Sync from Retell</strong> on the Retell Voice Agents card — every agent and phone number you've created in Retell auto-populates. The call node's agent dropdown reads from this list, so adding a new agent in Retell = it appears in your dropdown after the next sync. No copy-pasting agent IDs ever again.
        </p>
        <p className="text-[11px] text-zinc-500 italic">
          Onboarding a new client: paste their API key → click Sync → done. No further per-client setup.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Email bounce processing
        </h4>
        <p>
          Bounce emails (mailer-daemon, postmaster, DSN notifications) are now detected, the failed recipient and SMTP code are extracted, and the original outbound action is marked <code>failed</code> with the bounce reason. Hard bounces (5xx codes like 550/552) opt the lead out automatically and cancel any other pending actions for that lead. Soft bounces are recorded but the lead stays reachable. Everything shows up on the Errors page.
        </p>
        <p>
          Net effect: when an email doesn't actually deliver, the lead's record reflects the truth instead of staying "completed."
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          SMS delivery confirmation
        </h4>
        <p>
          Twilio's per-message status callbacks now flow into the events table. You'll see <code>delivery_status</code> populate as the SMS moves through <code>queued → sent → delivered</code>, or land on <code>failed</code> / <code>undelivered</code> with the SMTP error code. A REST poll fallback catches any callbacks Twilio doesn't fire for whatever reason. Same shape as the Retell post-call setup.
        </p>
        <p>
          <strong className="text-amber-600 dark:text-amber-400">Action required (once per Twilio number / messaging service):</strong> in the Twilio Console, set the <em>"A MESSAGE STATUS CHANGES"</em> webhook URL on each phone number (or on the Messaging Service if you use one) to:
        </p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-2.5 rounded-xl font-mono text-[11px] border border-black/10 dark:border-white/10 break-all">
          https://your-project-ref.supabase.co/functions/v1/twilio-status
        </div>
        <p className="text-[11px] text-zinc-500 italic">
          Method: POST. Note: this is the <em>status</em> webhook, not the "A MESSAGE COMES IN" inbound webhook. Two different fields on the same page.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Per-tenant Twilio credentials
        </h4>
        <p>
          Twilio account SID and auth token now live on the tenant credential row (Settings → Credentials → Twilio). The status poller reads them per-tenant — no shared keys, no global env vars, no per-client deploy. Adding a new client means pasting their three values (From Number, Account SID, Auth Token) once.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Lead identity convention
        </h4>
        <p>
          The system now stamps a canonical <code>followup_lead_id</code> on every outbound call (Retell metadata) and reads it back from common webhook payload paths. Same lead, every channel, every system. See the <em>"Lead ID Convention"</em> article for usage. The <code>{`{{lead_id}}`}</code> merge tag is available anywhere merge tags work.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Auto-registered custom fields from Retell
        </h4>
        <p>
          Every key your Retell agent emits in <code>call_analysis.custom_analysis_data</code> automatically becomes a tenant custom field on first sight, under the <em>Auto from Retell</em> folder. Standard call-history fields (<code>last_call_summary</code>, <code>last_call_recording_url</code>, <code>last_call_duration_seconds</code>, <code>last_call_outcome</code>, <code>last_call_at</code>) are auto-registered too. No manual setup; the data starts flowing to the lead the moment the agent emits it.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Smarter re-enrollment
        </h4>
        <p>
          Previously, a lead who answered a call in one journey was blocked from receiving messages in any future journey (the <code>responded</code> flag was sticky forever). Now, when a lead's <code>journey_template</code> changes — re-enroll, bulk re-enroll, or moved into a different journey — the <code>responded</code> / <code>callback_requested</code> / <code>callback_at</code> flags reset. Each enrollment is a fresh interaction.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Self-healing dispatcher
        </h4>
        <p>
          When a dispatch worker crashes or a provider rejects an API call silently, the action used to sit stuck in <code>in_progress</code> forever. The dispatcher now scans for stuck rows (locked &gt; 60 seconds past lock expiry) at every tick and routes them through retry/backoff (1 min → 5 min → 30 min → 2 hr → <code>failed_permanent</code>). Nothing silently disappears.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          Builder cleanups
        </h4>
        <ul className="list-disc pl-5 space-y-1 text-xs">
          <li>The "Call Script / Voice Agent Template" binding is gone from the call node. The Retell agent dropdown is the single source of truth; the prompt lives in Retell itself.</li>
          <li>"Restrict to business hours only" is removed from every non-Wait step. Use the Wait node's <code>advance_window</code> config to clamp downstream actions to a window.</li>
          <li>The Sync from Retell button no longer reloads the whole Settings page — only the two Retell tables update, and a toast confirms the result.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4 text-amber-500" />
          Setup checklist
        </h4>
        <p>Things you should do once per tenant after these updates:</p>
        <ol className="list-decimal pl-5 space-y-1 text-xs">
          <li>Settings → Credentials → Retell: paste your <strong>API key</strong> → click Sync from Retell.</li>
          <li>Settings → Credentials → Twilio: paste <strong>Account SID</strong> + <strong>Auth Token</strong> (in addition to the existing From Number).</li>
          <li>Twilio Console → Phone Numbers (or Messaging Service): set <em>"A MESSAGE STATUS CHANGES"</em> to <code className="font-mono">{`/functions/v1/twilio-status`}</code>.</li>
          <li>Retell Dashboard → your agents → Post-Call Webhook URL: <code className="font-mono">{`/functions/v1/retell-result`}</code> (one URL covers all agents in your tenant).</li>
        </ol>
      </div>
    )
  },
  {
    id: "dynamic-variables-call",
    category: "workflows",
    title: "Dynamic Variables on Call Nodes",
    subtitle: "Pass per-step context to your Retell agent so one agent can be reused across many journeys.",
    icon: Code,
    content: (
      <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          Every call step in the journey builder has a <strong>Dynamic Variables (to agent)</strong> section. Each row is a <code>{`{key, value}`}</code> pair. At call time, the engine renders each value against the current lead (merge tags resolve) and passes the result to Retell as <code>retell_llm_dynamic_variables</code>. Your agent's prompt can then reference <code>{`{{key}}`}</code> directly.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Always sent automatically</h4>
        <p>
          You don't have to declare these — they're injected on every call:
        </p>
        <ul className="list-disc pl-5 space-y-0.5 text-xs">
          <li><code>followup_lead_id</code> — the lead's UUID. Carries through Retell metadata + dynamic vars so post-call webhooks always match.</li>
          <li><code>lead_id</code> — alias for the above, easier to reference in agent prompts.</li>
          <li><code>first_name</code> — the lead's first name (or empty string if unset).</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Adding custom variables</h4>
        <p>Open the call step in the side panel. Below the Retell Voice Agent dropdown, click <strong>+ Add variable</strong>. Type a key name (snake_case is enforced — spaces become underscores) and a value template:</p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-3 rounded-xl font-mono text-xs border border-black/10 dark:border-white/10 space-y-1">
          <div>coverage_type        →  {`{{custom.coverage_type}}`}</div>
          <div>current_insurer      →  {`{{custom.previous_insurer}}`}</div>
          <div>callback_at          →  {`{{custom.preferred_callback_time}}`}</div>
          <div>quote_amount         →  {`{{custom.last_quoted_amount}}`}</div>
        </div>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Reference them in the Retell agent prompt</h4>
        <p>
          In the Retell Dashboard, edit your agent's prompt and use the same key names with double braces:
        </p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-3 rounded-xl text-xs border border-black/10 dark:border-white/10 leading-relaxed">
          Hi <span className="font-mono text-emerald-500">{`{{first_name}}`}</span>, I'm calling about your <span className="font-mono text-emerald-500">{`{{coverage_type}}`}</span> insurance. I see you're currently with <span className="font-mono text-emerald-500">{`{{current_insurer}}`}</span> — is that still right? Best time to follow up: <span className="font-mono text-emerald-500">{`{{callback_at}}`}</span>.
        </div>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">One agent, many use cases</h4>
        <p>
          This is the key unlock. The SAME Retell agent can be used in three different journeys (speed-to-lead, reactivation, win-back) by passing different dynamic variables per journey:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-xs">
          <li><strong>Speed-to-lead:</strong> <code>coverage_type = {`{{custom.coverage_type}}`}</code>, <code>current_insurer = "none yet"</code></li>
          <li><strong>Reactivation:</strong> <code>coverage_type = {`{{custom.coverage_type}}`}</code>, <code>current_insurer = {`{{custom.previous_insurer}}`}</code></li>
          <li><strong>Win-back:</strong> <code>coverage_type = {`{{custom.coverage_type}}`}</code>, <code>current_insurer = {`{{custom.competitor_name}}`}</code></li>
        </ul>
        <p>
          The agent's prompt stays the same. Only the runtime context differs.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">What you can put in the value field</h4>
        <ul className="list-disc pl-5 space-y-1 text-xs">
          <li>Plain strings: <code>"motivated"</code></li>
          <li>Lead standard fields: <code>{`{{first_name}}`}</code>, <code>{`{{email}}`}</code>, <code>{`{{phone_e164}}`}</code></li>
          <li>Lead custom fields: <code>{`{{custom.coverage_type}}`}</code> (or just <code>{`{{coverage_type}}`}</code> — both work)</li>
          <li>Webhook payload paths: <code>{`{{raw_payload.data.fields.0.value}}`}</code></li>
          <li>The canonical lead id: <code>{`{{lead_id}}`}</code></li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Verifying it landed</h4>
        <p>
          After a test call, open it in the Retell Dashboard. The "Dynamic Variables" section in the call's details should show every key you declared, with the resolved value for that specific lead. If you see an empty value, the merge tag didn't resolve — check that the lead actually has that field populated.
        </p>
      </div>
    )
  },
  {
    id: "webhook-mapping",
    category: "webhooks",
    title: "Webhook Field Mapping & Dot Notation",
    subtitle: "Learn how to map nested JSON payloads from forms and external platforms to lead fields.",
    icon: Code,
    content: (
      <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          When your system receives an inbound webhook, the full payload is snapshotted onto the lead row as
          <code>raw_payload</code>. That snapshot is what powers <code>{`{{raw_payload.path}}`}</code> merge tags
          downstream — every step in the journey can reference fields from the webhook body without you carrying
          them through manually.
        </p>
        <p>
          In subsequent nodes (like <strong>Create Lead</strong> or <strong>Update Lead</strong>), you can dynamically map 
          properties of this webhook payload into standard lead fields or your tenant's custom fields.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-500" />
          The Merge Tag Format
        </h4>
        <p>
          All dynamic values are mapped using double curly braces. The general prefix for inbound webhook payloads is <code>{`{{raw_payload.path_here}}`}</code>:
        </p>
        <ul className="list-disc pl-5 space-y-1 bg-zinc-950/5 dark:bg-white/[0.02] p-3 rounded-xl border border-black/5 dark:border-white/5">
          <li><code>{`{{raw_payload.email}}`}</code> — extracts a flat property key named "email".</li>
          <li><code>{`{{raw_payload.data.first_name}}`}</code> — extracts a nested property inside a "data" object.</li>
          <li><code>{`{{raw_payload.data.fields.0.value}}`}</code> — extracts the value of the <strong>first element (index 0)</strong> inside a "fields" array.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Handling array-based fields (e.g. multiple choice)</h4>
        <p>
          Many form builders like Tally return multiple choice answers as JSON arrays (e.g., <code>["Auto/Car"]</code>). 
          To extract the text string out of the array for a text field, append the index `.0` to the path:
        </p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-3 rounded-xl font-mono text-xs border border-black/10 dark:border-white/10">
          <span className="text-zinc-500">// Payload: {"{"}"data": {"{"}"coverage": ["Auto/Car"]{"}"}{"}"}</span><br />
          <span className="text-emerald-500">Mapping path:</span> {`{{raw_payload.data.coverage.0}}`} <span className="text-zinc-400">→ resolves to "Auto/Car"</span>
        </div>
      </div>
    )
  },
  {
    id: "node-reference",
    category: "workflows",
    title: "Journey Builder Node Reference",
    subtitle: "A detailed reference on what each journey builder node does and how it behaves.",
    icon: GitFork,
    content: (
      <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>Journeys are built using sequences of nodes. Each node represents a specific decision point, communication trigger, or state update:</p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <h5 className="font-semibold text-zinc-900 dark:text-white text-xs">Webhook (Trigger)</h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Accepts payload data from external services and enrolls the lead in the journey.</p>
          </div>
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <h5 className="font-semibold text-zinc-900 dark:text-white text-xs">Create Lead / Update Lead</h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Applies standard or custom field mappings dynamically using webhook values.</p>
          </div>
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <h5 className="font-semibold text-zinc-900 dark:text-white text-xs">Send Email / Send SMS</h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Dispatches communication using configured templates. Replaces merge tags like {`{{first_name}}`} inline.</p>
          </div>
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <h5 className="font-semibold text-zinc-900 dark:text-white text-xs">Wait for Reply</h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Pauses the lead's progression until they reply, or until a configurable timeout limit is reached.</p>
          </div>
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <h5 className="font-semibold text-zinc-900 dark:text-white text-xs">Add Tag / Remove Tag</h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Attaches tags to the lead's custom tag array for filtering, tracking, or trigger journeys.</p>
          </div>
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <h5 className="font-semibold text-zinc-900 dark:text-white text-xs">Find Lead</h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Searches the system for an existing lead (by phone/email) to avoid creating duplicates.</p>
          </div>
        </div>
      </div>
    )
  },
  {
    id: "custom-fields",
    category: "fields",
    title: "Managing Custom Fields & Tags",
    subtitle: "How to extend your lead model and query custom properties within templates.",
    icon: Database,
    content: (
      <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          Standard lead models have pre-configured columns (like First Name, Phone, Email, source, etc.). 
          However, every business needs custom metadata.
        </p>
        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Creating a custom field</h4>
        <p>
          Go to the <strong>Custom Fields</strong> page in the sidebar and click <strong>Create Custom Field</strong>. 
          Provide a key (which acts as the database identifier, e.g. <code>coverage_type</code>) and a human-readable label.
        </p>
        
        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Accessing custom fields in email/SMS templates</h4>
        <p>
          To insert custom properties directly into templates, wrap the custom field <strong>key</strong> in braces.
          Every key in <code>custom_fields</code> is exposed at the top level — no prefix needed:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><code>{`{{coverage_type}}`}</code> — merges the lead's specific coverage choice.</li>
          <li><code>{`{{tags}}`}</code> — outputs the value stored under the <code>tags</code> custom field (string form).</li>
        </ul>
        <p className="text-[11px] text-zinc-500 italic">
          Common mistake: writing <code>{`{{custom_fields.tags}}`}</code>. That won't resolve — the engine does flat-key
          substitution from custom_fields, not dotted-namespace lookup. Use the bare key.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Built-in merge tags</h4>
        <p>
          A handful of merge tags always work without configuring a custom field. The most useful one for cross-system
          integration is the lead's canonical identifier:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><code>{`{{lead_id}}`}</code> — the lead's UUID. Pass it to any external system; when they call back, the
            engine matches the lead by it automatically.</li>
          <li><code>{`{{first_name}}`}</code>, <code>{`{{last_name}}`}</code>, <code>{`{{email}}`}</code>,
            <code>{`{{phone_e164}}`}</code>, <code>{`{{phone_raw}}`}</code>, <code>{`{{address}}`}</code>,
            <code>{`{{zip_code}}`}</code>, <code>{`{{source}}`}</code>, <code>{`{{campaign_type}}`}</code>.</li>
        </ul>
      </div>
    )
  },
  {
    id: "retell-setup",
    category: "webhooks",
    title: "Retell Voice Agent — Complete Setup Guide",
    subtitle: "Wire up post-call data so every conversation enriches the lead automatically.",
    icon: Play,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          End-to-end: configure one webhook URL in your Retell agent, and every call your engine
          dispatches will write standard call metadata + every custom analysis field straight onto
          the lead — no per-agent mapping, no per-journey config.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">1. The webhook URL</h4>
        <p>
          In your Retell dashboard, open the agent → settings → <strong>Post-Call Webhook URL</strong>.
          Paste this URL exactly (one URL covers every agent in your tenant):
        </p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-3 rounded-xl font-mono text-xs border border-black/10 dark:border-white/10 break-all">
          https://your-project-ref.supabase.co/functions/v1/retell-result
        </div>
        <p>
          Save. That's the entire wiring. Every call this agent (or any other agent in your tenant
          using the same URL) makes will POST its analysis here when it ends.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">2. What lands on the lead — automatically</h4>
        <p>
          When a call ends, the engine writes two groups of values onto <code>lead.custom_fields</code>:
        </p>
        <div className="space-y-2">
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <div className="font-semibold text-zinc-800 dark:text-zinc-100 mb-1">A. Standard call metadata (always)</div>
            <ul className="list-disc pl-5 space-y-0.5 text-xs">
              <li><code>last_call_summary</code> — what the agent extracted as the summary</li>
              <li><code>last_call_recording_url</code> — the audio recording link</li>
              <li><code>last_call_duration_seconds</code> — call length</li>
              <li><code>last_call_outcome</code> — answered / no_answer / voicemail / etc.</li>
              <li><code>last_call_at</code> — timestamp</li>
            </ul>
          </div>
          <div className="p-3 border border-black/5 dark:border-white/5 rounded-xl bg-zinc-950/5 dark:bg-white/[0.02]">
            <div className="font-semibold text-zinc-800 dark:text-zinc-100 mb-1">B. Custom analysis fields (whatever your agent emits)</div>
            <p className="text-xs">
              Every key inside <code>call_analysis.custom_analysis_data</code> gets splatted onto the lead
              with the same name. If your agent emits <code>urgency_level: "immediate"</code>,
              the lead gets a custom field <code>urgency_level</code> with value <code>"immediate"</code>.
              No mapping table, no per-agent config. The agent's keys ARE the lead's keys.
            </p>
          </div>
        </div>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">3. Custom fields appear in the UI automatically</h4>
        <p>
          The first time a Retell agent emits a new <code>custom_analysis_data</code> key, the engine
          auto-registers a tenant custom field for it. You'll find it in <strong>Settings → Custom Fields</strong>
          under the folder <strong>Auto from Retell</strong>, ready to use immediately.
        </p>
        <p className="text-[11px] text-zinc-500 italic">
          You can rename labels, change types, move folders, or hide auto-registered fields at any time —
          the underlying data on the lead is unaffected. Type is inferred from the value shape (boolean,
          number, date, URL, text) but you can override it.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">4. Use the data in the next step of the same journey</h4>
        <p>
          After the call step completes, the next step runs with the lead already enriched. Reference
          any custom analysis field by name in templates, Update Lead values, HTTP bodies, or anywhere
          merge tags work:
        </p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-3 rounded-xl font-mono text-xs border border-black/10 dark:border-white/10 space-y-1">
          <div><span className="text-zinc-500">// In a Send Email body, right after the call step:</span></div>
          <div>Hi {`{{first_name}}`},</div>
          <div className="opacity-50">{`<br />`}</div>
          <div>Thanks for chatting about {`{{coverage_type}}`} insurance.</div>
          <div>We heard you're {`{{lead_motivation}}`} — quotes ready by {`{{callback_date_time}}`}.</div>
          <div>Recording for your reference: {`{{last_call_recording_url}}`}</div>
        </div>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">5. Branch the journey on extracted data</h4>
        <p>
          Drop a <strong>Condition Split</strong> node after the call. In the field picker, choose any
          custom field — the dropdown is populated from your Custom Fields list (including auto-registered
          ones). Pick an operator and value, draw the Yes/No branches.
        </p>
        <ul className="list-disc pl-5 space-y-1 bg-zinc-950/5 dark:bg-white/[0.02] p-3 rounded-xl border border-black/5 dark:border-white/5 text-xs">
          <li><code>custom.lead_sentiment</code> <code>equals</code> <code>"motivated"</code> → Yes branch: Wait 2 min → SMS → Wait For Reply 48h → Email on timeout</li>
          <li><code>custom.urgency_level</code> <code>equals</code> <code>"immediate"</code> → Yes branch: Team Alert → Add Tag <code>hot_lead</code></li>
          <li><code>custom.current_coverage_status</code> <code>contains</code> <code>"competitor"</code> → Yes branch: send the win-back email template</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">6. Use the data in a different journey</h4>
        <p>
          The lead is the source of truth. Anything written to <code>custom_fields</code> persists
          across journeys. Two clean ways to chain:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-xs">
          <li>
            <strong>Tag and trigger:</strong> at the end of the call journey, add an <strong>Add Tag</strong> node
            (e.g. <code>hot_lead_intake</code>). Create a second journey with trigger = <strong>Lead Tag Added</strong>,
            tag = <code>hot_lead_intake</code>. When the first journey tags the lead, the second one runs against
            the same lead with the same custom_fields data.
          </li>
          <li>
            <strong>Webhook with followup_lead_id:</strong> for external systems calling back later, include
            <code>{`{{lead_id}}`}</code> in your outbound metadata. When they POST to a webhook-triggered journey,
            the engine matches the lead by UUID and enrolls them. See the
            "Lead ID Convention" article for details.
          </li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">7. Multiple agents, different use cases</h4>
        <p>
          Speed-to-lead, reactivation, cold follow-up — each agent emits different
          <code>custom_analysis_data</code> keys. They all post to the same webhook URL. Their distinct
          field sets all land on whatever lead the call was about, all auto-register into "Auto from Retell".
          No per-agent setup beyond pointing the webhook URL.
        </p>
        <p className="text-[11px] text-zinc-500 italic">
          Tip: keep agent-emitted key names consistent across agents where the meaning is the same
          (e.g. always use <code>lead_sentiment</code>, not <code>sentiment_score</code> in one agent and
          <code>mood</code> in another). Otherwise you'll end up with three custom fields that mean the
          same thing.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">8. Troubleshooting</h4>
        <ul className="list-disc pl-5 space-y-1 text-xs">
          <li>
            <strong>Call happened, no data on lead.</strong> Check the Retell agent's Post-Call Webhook URL is
            set exactly as shown above. Re-run the call.
          </li>
          <li>
            <strong>Data is on the lead but not in the UI.</strong> Refresh the Custom Fields settings page —
            auto-registered fields appear on the next call. The data is already on the lead row regardless.
          </li>
          <li>
            <strong>"Last call outcome" is wrong.</strong> The outcome is mapped from Retell's
            <code>disconnection_reason</code>. Your agent can override it by setting
            <code>call_outcome</code> inside <code>custom_analysis_data</code> to one of:
            <code>answered</code>, <code>no_answer</code>, <code>voicemail</code>, <code>invalid_number</code>,
            <code>wrong_number</code>.
          </li>
          <li>
            <strong>The next step never fires.</strong> Check the call step's Outcome Routing in the builder —
            every outcome (answered, no_answer, voicemail, busy, failed, invalid, wrong number) needs a wire
            to a next node or an Exit, otherwise the journey stalls on that outcome.
          </li>
        </ul>
      </div>
    )
  },
  {
    id: "lead-id-convention",
    category: "webhooks",
    title: "The Lead ID Convention — Identifying Leads Across Systems",
    subtitle: "How outbound and inbound integrations stay matched to the same lead, with zero per-webhook configuration.",
    icon: Sparkles,
    content: (
      <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          Every lead has a single canonical identifier: its UUID, exposed everywhere as <code>{`{{lead_id}}`}</code>.
          That's the only thing you need to match a lead across any external system.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">The rule (two sentences)</h4>
        <ol className="list-decimal pl-5 space-y-1 bg-zinc-950/5 dark:bg-white/[0.02] p-3 rounded-xl border border-black/5 dark:border-white/5">
          <li><strong>Outbound:</strong> when you call any external system, stamp <code>followup_lead_id</code> on the request
            (Retell metadata, a URL param, a header, a body field). For Retell, the call dispatch does this automatically.</li>
          <li><strong>Inbound:</strong> when that system calls your webhook back, the engine reads
            <code>followup_lead_id</code> from a fixed set of well-known paths and resolves the lead by UUID.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Where {`{{lead_id}}`} Works</h4>
        <p>
          The <code>{`{{lead_id}}`}</code> merge tag resolves to the lead's UUID wherever merge tags are evaluated —
          email/SMS templates, <strong>Update Lead</strong> values, <strong>HTTP Request</strong> bodies and headers,
          tag names, and the Retell agent prompt (via <code>dynamic_variables</code>).
        </p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-3 rounded-xl font-mono text-xs border border-black/10 dark:border-white/10 space-y-1">
          <div><span className="text-zinc-500">// HTTP Request body to a partner CRM:</span></div>
          <div>{`{ "contact_id": "{{lead_id}}", "event": "callback_requested" }`}</div>
          <div className="pt-2"><span className="text-zinc-500">// SMS with a tracked link back to you:</span></div>
          <div>{`https://your-form.com/book?ref={{lead_id}}`}</div>
        </div>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Inbound: the webhook recognizes these paths</h4>
        <p>
          When a webhook fires (any journey with a Webhook trigger), the engine scans the incoming JSON for
          <code>followup_lead_id</code> at these paths in order:
        </p>
        <ul className="list-disc pl-5 space-y-1 bg-zinc-950/5 dark:bg-white/[0.02] p-3 rounded-xl border border-black/5 dark:border-white/5 font-mono text-xs">
          <li>metadata.followup_lead_id</li>
          <li>followup_lead_id</li>
          <li>body.metadata.followup_lead_id</li>
          <li>body.call.metadata.followup_lead_id</li>
          <li>body.call.dynamic_variables.followup_lead_id</li>
          <li>call.metadata.followup_lead_id</li>
          <li>call.dynamic_variables.followup_lead_id</li>
        </ul>
        <p>
          If found and the UUID matches a lead in your tenant, the engine enrolls that lead into the journey and queues
          step 0. No mapping, no email/phone matching, no risk of creating a phantom lead.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Retell — stamped automatically</h4>
        <p>
          The Retell call dispatch (<code>W-SEND-CALL</code>) passes <code>followup_lead_id</code> as both call
          <code>metadata</code> and a <code>dynamic_variable</code>. Retell echoes both back in the post-call webhook
          payload. <strong>You don't have to configure anything for Retell.</strong> Just point your Retell agent's
          post-call webhook at the journey URL.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Multiple calls per lead — not a problem</h4>
        <p>
          A lead can receive several calls in a journey (call → SMS → wait 48h → call). Each call gets a distinct
          <code>call_id</code>, but they all carry the same <code>followup_lead_id</code>. Every result webhook lands on
          the same lead row — last write wins on standard fields (<code>last_call_*</code>), and every
          <code>custom_analysis_data</code> key is merged into <code>custom_fields</code>.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Fallback: fresh-lead intake</h4>
        <p>
          When the inbound payload doesn't carry a <code>followup_lead_id</code> (typical for new-lead intake from a form
          builder), the webhook falls back to the legacy behavior: read <code>email</code>/<code>phone</code> from your
          configured <code>webhook_mapping</code> (or top-level keys) and find-or-create the lead. Same webhook URL,
          same code path — only the resolution strategy differs based on what's in the payload.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Partner CRMs / Calendly / custom apps</h4>
        <p>
          For any third-party system you initiate contact with, embed <code>{`{{lead_id}}`}</code> in whatever metadata
          channel that system supports — URL parameter, tracking field, custom property — and have the system echo it
          back at a path the webhook recognizes (or in your control, send <code>metadata.followup_lead_id</code> on the
          response). No per-journey configuration needed.
        </p>
      </div>
    )
  },
  {
    id: "gmail-oauth-setup",
    category: "webhooks",
    title: "Gmail OAuth — Connect a Sender (Step-by-Step)",
    subtitle: "Every sender connects its mailbox to Example Co via Google OAuth. This guide walks through it the first time, then becomes your reference for adding more.",
    icon: Mail,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          Example Co sends email natively through the Gmail API. Each sender (each mailbox) needs to authorize Example Co once. After that, Example Co sends, threads replies, and rotates between senders automatically. This guide is for the operator setting up a new sender. Allow ~10 minutes the first time. The next sender on the same Google Workspace takes ~2 minutes.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">What you'll do, in plain terms</h4>
        <ol className="list-decimal pl-5 space-y-1.5 marker:text-zinc-400">
          <li>Make a Google Cloud project (a container for the OAuth settings) using the email account whose mailbox you want to send from.</li>
          <li>Turn on the Gmail API inside that project.</li>
          <li>Tell Google "this app is internal to my organization" so only people in your Workspace can use it.</li>
          <li>Get a Client ID and Client Secret — two strings of text.</li>
          <li>Paste those two strings into Example Co.</li>
          <li>Click "Connect Google" and pick the mailbox to authorize.</li>
          <li>Click "Send test" to confirm it works.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Background: one OAuth client per Workspace</h4>
        <p>
          A "Workspace" is one Google email domain — like <code>tryexample.com</code> or <code>example.com</code>. If you have mailboxes in multiple Workspaces, each Workspace needs its own Google Cloud project + its own OAuth client. Example Co stores those credentials <em>per sender</em>, so different senders can connect through different Workspaces.
        </p>
        <p>
          If <em>all</em> your senders are on one Workspace, you can save the Client ID + Secret once at the tenant level (Settings → Credentials → Gmail) and skip pasting them per sender. The system uses your sender's override if set, otherwise falls back to the tenant default.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Step 1 — Create the Google Cloud project</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Sign in to <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 underline inline-flex items-center gap-0.5">console.cloud.google.com <ExternalLink className="w-3 h-3" /></a> using the account that owns the mailbox (e.g. <code>jane@example.com</code>).</li>
          <li>Top bar → project picker → <strong>"New Project"</strong>.</li>
          <li>Name it something memorable (e.g. <em>"Example Co Mail"</em>). Click <strong>Create</strong>.</li>
          <li>Wait for the project to switch to active (toast bottom-right), then make sure it's selected in the top bar.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Step 2 — Enable the Gmail API</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Left sidebar → <strong>APIs &amp; Services → Library</strong>.</li>
          <li>Search for <strong>"Gmail API"</strong> → click the result → <strong>Enable</strong>.</li>
          <li>Wait for the green check.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Step 3 — Configure the OAuth consent screen</h4>
        <p>
          This is what users see when they're asked to authorize Example Co.
        </p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Left sidebar → <strong>APIs &amp; Services → OAuth consent screen</strong>.</li>
          <li>Under <strong>User Type</strong> pick <strong>Internal</strong> (this limits the app to your Workspace and skips Google's verification process). Click <strong>Create</strong>.</li>
          <li>
            Fill in the basics:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li><strong>App name:</strong> anything (e.g. "Example Co").</li>
              <li><strong>User support email:</strong> your account.</li>
              <li><strong>Developer contact email:</strong> your account.</li>
            </ul>
          </li>
          <li>Logo/links are optional.</li>
          <li><strong>Save and continue</strong>.</li>
          <li>
            On the <strong>Scopes</strong> step: you can leave it empty (Example Co will request scopes at sign-in, that's fine). Save and continue.
          </li>
          <li>Skip <strong>Test users</strong> (Internal apps don't need them). Save and continue.</li>
          <li>You'll land on a summary page. Done with this step.</li>
        </ol>
        <p className="text-[11px] text-zinc-500 italic">
          If "Internal" is greyed out, your Google account isn't a Workspace admin — the account must be on a paid Google Workspace (not a free <code>@gmail.com</code> address) to use Internal. For personal Gmail accounts, see "Special case: personal @gmail.com senders" below.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Step 4 — Create the OAuth Client ID</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Left sidebar → <strong>APIs &amp; Services → Credentials</strong>.</li>
          <li>Top → <strong>+ CREATE CREDENTIALS → OAuth client ID</strong>.</li>
          <li><strong>Application type:</strong> <strong>Web application</strong>.</li>
          <li><strong>Name:</strong> anything (e.g. "Example Co Web Client").</li>
          <li>
            Under <strong>Authorized redirect URIs</strong>, click <strong>+ ADD URI</strong> and paste exactly the URL your Example Co dashboard is served from, with <code>/api/oauth/google/callback</code> at the end. For local development:
          </li>
        </ol>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-2.5 rounded-xl font-mono text-[11px] border border-black/10 dark:border-white/10 break-all">
          http://localhost:3000/api/oauth/google/callback
        </div>
        <p className="text-[11px] text-zinc-500">
          For production, use your real domain. If you serve Example Co at <code>https://app.example.com</code>, the redirect URI is <code>https://app.example.com/api/oauth/google/callback</code>. You can add multiple URIs in this field — useful if you have staging and production.
        </p>
        <ol className="list-decimal pl-5 space-y-1.5" start={6}>
          <li>Click <strong>Create</strong>.</li>
          <li>A dialog appears with <strong>Client ID</strong> and <strong>Client Secret</strong>. Copy both. The secret is shown once — if you lose it, you can regenerate from the credential's edit page, but anything you've already connected with the old secret will break.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Step 5 — Paste into Example Co</h4>
        <p className="font-medium text-zinc-700 dark:text-zinc-200">If this is the first sender for this Workspace, OR you want the credentials scoped per-sender:</p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Go to <strong>Settings → Senders Pools &amp; Throttling</strong>.</li>
          <li>If the sender row already exists, click the <strong>pencil icon</strong> on the right of the row. If not, click <strong>"Add Sender"</strong>.</li>
          <li>Fill in the basics (slot, email, name, domain) if it's a new sender.</li>
          <li>Scroll to the <strong>"Google OAuth Client (optional override)"</strong> block.</li>
          <li>Paste the <strong>Google Client ID</strong> from Google Cloud.</li>
          <li>Paste the <strong>Google Client Secret</strong> from Google Cloud.</li>
          <li>Save.</li>
        </ol>
        <p className="font-medium text-zinc-700 dark:text-zinc-200 mt-2">If all your senders are on the same Workspace and you'd rather set it once:</p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Go to <strong>Settings → Credentials</strong>.</li>
          <li>Add a new credential → Provider: <strong>Gmail</strong>.</li>
          <li>Paste the Client ID + Client Secret.</li>
          <li>Save. Every sender on this tenant will use this client unless they have a per-sender override.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Step 6 — Authorize the mailbox ("Connect Google")</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Back on <strong>Settings → Senders Pools &amp; Throttling</strong>, find your sender row.</li>
          <li>If you haven't connected yet, the row shows a <strong>"Connect Google"</strong> button. Click it.</li>
          <li>Google shows an account picker. <strong>Pick the mailbox you want to send from</strong> (e.g. <code>jane@example.com</code>).</li>
          <li>The consent screen says <em>"&lt;App&gt; wants to access your Google Account → Send email on your behalf"</em>. Click <strong>Allow</strong>.</li>
          <li>You'll be redirected back to Settings with a green toast: <em>"Gmail connected"</em>. The sender row now shows a green <strong>"Google connected ✓"</strong> badge.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Step 7 — Smoke test</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>On the same sender row, click <strong>"Send test"</strong>.</li>
          <li>Modal opens. <strong>To</strong> defaults to the sender's own email (sends to self — safe). Change if you want it elsewhere.</li>
          <li>Click <strong>Send test</strong> → wait ~2 seconds → green toast with a Gmail message id.</li>
          <li>Open the inbox you sent to. You should see the email arrive with proper formatting (paragraphs, line breaks).</li>
          <li>Click "Show original" on the email and confirm the <code>From:</code> is your sender address and there's an <code>X-Example Co-Lead-Id</code> header. That's how we know the chain is intact.</li>
        </ol>
        <p>
          If the test send works, real journey emails will also work. The dispatcher uses the exact same chain.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Common errors and what they mean</h4>
        <div className="space-y-3">
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">"Access blocked: &lt;App&gt; can only be used within its organization"</p>
            <p>The OAuth consent is set to <strong>Internal</strong>, and the mailbox you picked is on a different Workspace than the Cloud project. Either (a) make a new Cloud project under that mailbox's Workspace and use its credentials, or (b) change the consent type to External and add the mailbox as a Test user.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">"redirect_uri_mismatch"</p>
            <p>The URL you're served at doesn't match what's in the OAuth client's Authorized redirect URIs. Copy your browser's URL up to the host (e.g. <code>http://localhost:3000</code>), add <code>/api/oauth/google/callback</code>, and paste back into Google Cloud Credentials → your client → Authorized redirect URIs.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">"invalid_client" or "Token refresh failed"</p>
            <p>The Client ID and Client Secret stored in Example Co don't match the OAuth client in Google Cloud. Either you pasted a wrong/old value, or the secret was regenerated in Google Cloud after you saved it here. Edit the sender → paste the current values → reconnect.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">"No refresh_token returned by Google"</p>
            <p>You've previously consented to this Example Co from this Google account, and Google won't re-issue a refresh token. Go to <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 underline inline-flex items-center gap-0.5">myaccount.google.com/permissions <ExternalLink className="w-3 h-3" /></a>, revoke our app, then retry Connect Google.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">Test send works but real journey emails fail with "Assigned sender is inactive" / "no refresh_token"</p>
            <p>The lead got assigned to a different (broken) sender during enrollment, then got stuck. Edit that lead → clear assigned sender, or re-enroll. Or wait: the dispatcher's self-healing assignment clears it automatically if the lead hasn't yet sent an email on this thread.</p>
          </div>
        </div>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Special case: personal @gmail.com senders</h4>
        <p>
          The Internal user type only exists for Google Workspace accounts. For a personal <code>@gmail.com</code> mailbox, you have to use User Type = <strong>External</strong>. Google then puts your app in "Testing" mode, which limits it to 100 listed test users and gives <em>7-day</em> refresh tokens for sensitive scopes (which <code>gmail.send</code> is). For real use you'd need to submit the app for Google verification — that's a multi-week CASA security audit and is overkill for personal mailboxes. Strong advice: use a paid Google Workspace mailbox for serious outbound. The Workspace fee is trivial compared to the verification overhead and deliverability lift you get from a custom-domain sender.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Reconnecting / rotating credentials</h4>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>"reconnect" link</strong> next to "Google connected ✓" — re-runs the OAuth flow. Use after revoking, after changing the OAuth client, or if the token went bad.</li>
          <li><strong>Rotating Client Secret in Google Cloud:</strong> immediately edit the sender in Example Co and paste the new secret, then click reconnect. Otherwise the existing refresh token can't refresh and dispatch will fail with "invalid_client".</li>
          <li>
            <strong>Snapshot guarantee:</strong> when you click "Connect Google", whichever Client ID + Secret was used at that moment gets snapshotted onto the sender row. Future token refreshes always use those exact values. This means later changes to the tenant default don't silently break existing senders.
          </li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">What scopes Example Co asks for and why</h4>
        <p>
          Only <code>gmail.send</code> (plus <code>userinfo.email</code> and <code>openid</code> to identify the connected account). We deliberately don't ask for read/draft/modify — they're more sensitive scopes that would trigger a stricter Google verification process and aren't needed for outbound dispatch. Gmail inbox polling uses the native readonly grant only when that feature is explicitly connected.
        </p>
      </div>
    )
  },
  {
    id: "twilio-setup",
    category: "webhooks",
    title: "Twilio SMS — Complete Setup Guide",
    subtitle: "Get outbound sends, delivery status, and inbound replies all flowing through your engine.",
    icon: MessageSquare,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          Three URLs. Set them once per phone number in the Twilio Console. Then every SMS your engine sends flows outbound with delivery status flowing back, and every SMS a lead sends back reaches the conversation view within ~15 seconds.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">1. Store your Twilio credentials in Example Co</h4>
        <p>Settings → Credentials → Add → Provider: <strong>Twilio</strong>. Paste:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Account SID</strong> and <strong>Auth Token</strong> — from Twilio Console dashboard.</li>
          <li><strong>From Number</strong> — your Twilio phone number in E.164 (e.g. <code className="font-mono">+15551234567</code>). This is how the engine knows which tenant owns which number when inbound arrives.</li>
          <li><strong>Messaging Service SID</strong> (optional but recommended for production) — enables sender pool + opt-out handling + link shortening.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">2. Delivery status callback</h4>
        <p>This flows delivery events back so your conversation view shows sent → delivered → failed instead of a permanent "sent" state.</p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-2.5 rounded-xl font-mono text-[11px] border border-black/10 dark:border-white/10 break-all">
          https://your-project-ref.supabase.co/functions/v1/twilio-status
        </div>
        <p><strong>Where to paste:</strong> Twilio Console → Phone Numbers → your number → Messaging Configuration → <em>A MESSAGE STATUS CHANGES</em> → set to <strong>POST</strong> to the URL above.</p>
        <p className="text-[11px] text-zinc-500 italic">
          The engine also polls Twilio's REST API as a fallback (<code>twilio-status-poll</code> cron), so a missed webhook eventually reconciles.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">3. Inbound SMS webhook (lead replies)</h4>
        <p>Without this, SMS replies from leads are silently dropped by Twilio.</p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-2.5 rounded-xl font-mono text-[11px] border border-black/10 dark:border-white/10 break-all">
          https://your-project-ref.supabase.co/functions/v1/twilio-inbound
        </div>
        <p><strong>Where to paste:</strong> Twilio Console → Phone Numbers → your number → Messaging Configuration → <em>A MESSAGE COMES IN</em> → set to <strong>POST</strong> to the URL above.</p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">What happens on a reply</h4>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Twilio POSTs the message to the inbound URL.</li>
          <li>Engine resolves the tenant by matching the <code>To</code> field (your Twilio number) against your stored <em>From Number</em>. Cross-tenant leak is impossible — each number belongs to exactly one tenant.</li>
          <li>Matches the lead by <code>phone_e164 = From</code>.</li>
          <li>Cancels any other pending outbound engagements (the lead responded — no need to keep nudging).</li>
          <li>If the message body is STOP / UNSUBSCRIBE / CANCEL / QUIT / END, opts the lead out and adds a suppression.</li>
          <li>Otherwise, if AI replies are enabled + an agent is configured for the lead's journey (or the tenant default), enqueues an AI reply. The AI decides reply-or-escalate based on the agent's rules.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Common errors</h4>
        <div className="space-y-3">
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">"Unknown tenant" events on the Errors page</p>
            <p>Someone SMS'd a number that Example Co doesn't know about. Fix by adding that number as <em>From Number</em> in Settings → Credentials → Twilio for the correct tenant.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">Inbound event created but lead not matched</p>
            <p>The <code>From</code> phone doesn't match any lead's <code>phone_e164</code> in that tenant. The event stays as an orphan (visible on the tenant's inbox view). Add the lead with matching phone, then any future reply from that number will link.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">Twilio keeps retrying the delivery webhook</p>
            <p>The endpoint always returns 200 TwiML even on internal errors — Twilio should never retry indefinitely. If you see repeated attempts, check the Operations page for corresponding <code>error_logs</code> rows.</p>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "ai-agents-overview",
    category: "workflows",
    title: "AI Reply Agents — How they work",
    subtitle: "Auto-reply to inbound leads without hand-typing every response. Full control over tone, knowledge, and when to escalate to a human.",
    icon: Bot,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          An <strong>AI Agent</strong> is a configured LLM persona that reads inbound email or SMS from your leads and either auto-replies or escalates to your team. Every reply lands in the same conversation queue as manual ones — same threading, same throttle, same audit trail.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">What each agent is made of</h4>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Identity</strong> — name, description, enabled toggle.</li>
          <li><strong>Brain</strong> — LLM provider (OpenAI or Anthropic), model (Haiku / Sonnet / Opus / GPT-4o / GPT-4o mini / o1 / any custom model id), system prompt, temperature, max tokens.</li>
          <li><strong>Knowledge</strong> — text snippets the agent grounds its replies in (pricing, product positioning, common objections, do/don't lists). Each snippet has title + content + active toggle.</li>
          <li><strong>Escalation</strong> — which intents (objection, negative, complex, etc.) route to a human via <em>team_alert</em>, confidence threshold below which to escalate even for allowed intents, max replies per lead cap.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">The reply flow — end to end</h4>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Lead replies (email or SMS).</li>
          <li>Engine captures the inbound, matches the lead, cancels other pending outbounds.</li>
          <li>Engine picks an agent: <em>the journey's ai_agent_id</em> if set, otherwise <em>tenant default</em>.</li>
          <li>Enqueues an <code>ai_reply</code> action keyed on the inbound event id (idempotent).</li>
          <li>Within 30 seconds the dispatcher fires <code>generate-ai-reply</code>: loads agent + KB + last 20 messages of history + the API key, calls the LLM with a structured-output schema.</li>
          <li>LLM returns <code>{`{ intent, confidence, reasoning, reply }`}</code>.</li>
          <li>Decision:
            <ul className="list-disc pl-5 mt-1">
              <li>Intent in escalation list OR confidence &lt; threshold → creates a <em>team_alert</em> (amber "Needs your reply" panel in the conversation view with the AI's suggested reply).</li>
              <li>Otherwise → creates a normal outbound send action with <code>payload.inline.body = reply</code>. Uses the existing throttle + threading pipeline.</li>
            </ul>
          </li>
          <li>Every decision (replied or escalated) writes a row to <code>ai_reply_events</code> with tokens + cost. See the Operations page for the 24h view.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Kill switches</h4>
        <p>Three levels of stop, each independent:</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Tenant master switch</strong> — Settings → AI Agents → top banner. Off = no agent fires for this tenant. Emergency stop.</li>
          <li><strong>Per-agent enabled toggle</strong> — turn off a specific agent without deleting it. Journey-attached agents that are disabled fall back to tenant default.</li>
          <li><strong>Max replies per lead</strong> — after N AI replies to one lead, the next inbound escalates automatically instead of auto-replying. Prevents runaway conversations.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Per-journey agent (use-case routing)</h4>
        <p>
          One tenant can have many agents, one per use case: Speed-to-Lead, Reactivation, Cold Follow-up, etc. Each journey has an <em>AI Reply Agent</em> field in Settings → journey builder → Settings tab. Leaving it as <em>"Use tenant default"</em> falls back to the tenant's default agent. Setting it pins that journey's replies to that specific agent, complete with its own prompt + KB.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Playground — test before you ship</h4>
        <p>
          Every agent's edit page has a <strong>Playground</strong> tab. Paste a sample inbound + optional prior outbound, click Test, see exactly what the agent would decide. Uses your in-flight form values (so you can test unsaved prompt tweaks), calls the real LLM through the real path, writes nothing to the database. Costs ~$0.0001 per test on cheap models.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Cost tracking</h4>
        <p>
          The <em>Operations</em> page shows AI activity for the last 24 hours: replied count, escalated count, LLM error count, aggregate cost. Every <code>ai_reply_events</code> row records tokens in/out and estimated dollar cost per the provider's public pricing table. GPT-4o mini is currently the cheapest model that still gets structured output right — expect ~$0.0001–$0.0005 per reply.
        </p>
      </div>
    ),
  },
  {
    id: "ai-agent-templates",
    category: "workflows",
    title: "AI Agent Templates (Speed-to-Lead / Cold Follow-up / Reactivation)",
    subtitle: "Ready-to-use agents crafted for the three most common outbound use cases. Start with a template, tune it to your voice.",
    icon: Rocket,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          Rather than starting an agent from a blank prompt, use one of the three built-in templates as a starting point. Each is tuned for a specific inbound context — the tone, the escalation rules, and the KB seeds match the use case.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Where to find them</h4>
        <p>
          Settings → AI Agents → <strong>"Use a template"</strong> button (next to <em>+ New Agent</em>). Pick a template → preview the prompt + escalation rules + KB seeds → click <em>Create Agent from Template</em>. You'll land on the newly-created agent's edit page with everything pre-filled. Tune the prompt to your voice, edit or add KB items, save.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Template 1: Speed-to-lead follow-up</h4>
        <p><strong>When to use.</strong> A hot inbound just came in — form fill, live chat, "please contact me" — and speed matters. This agent replies within seconds, warmly, and pushes toward a meeting.</p>
        <p><strong>Tone.</strong> Warm, energetic, human. Contractions, short sentences, natural first-name use. Sounds like a sharp SDR who happens to be online right now.</p>
        <p><strong>Escalation defaults.</strong> Escalate on <em>objection</em>, <em>negative</em>, <em>pricing_question</em>. Auto-reply on <em>positive</em>, <em>question</em>, <em>meeting_request</em>. Reason: an inbound-hot lead asking about price is worth a human touch, but a question about "when can we chat" is a booking opportunity.</p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Template 2: Cold follow-up</h4>
        <p><strong>When to use.</strong> This is a follow-up email in a cold-outreach sequence. The lead never asked to be contacted. Care about their time.</p>
        <p><strong>Tone.</strong> Professional, curious, no pressure. Acknowledges the cold context. Never over-explains. Ends with a low-stakes question, not a hard ask.</p>
        <p><strong>Escalation defaults.</strong> Escalate on <em>negative</em>, <em>objection</em>, <em>complex</em>. Auto-reply on <em>question</em>, <em>positive</em>, <em>meeting_request</em>. Reason: cold leads pushing back deserve real human handling; curious leads can be nurtured by the AI.</p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Template 3: Reactivation (old leads)</h4>
        <p><strong>When to use.</strong> A lead engaged with you months ago, then went dark. You're reaching out to reopen the door.</p>
        <p><strong>Tone.</strong> Casual, warm, "hey, it's been a while." Acknowledges time passed without guilt. Empathetic to whatever life changes may have happened. Aims to just reopen the conversation, not close a deal on turn one.</p>
        <p><strong>Escalation defaults.</strong> Escalate on <em>negative</em>, <em>complex</em>, <em>out_of_office</em>. Auto-reply on <em>positive</em>, <em>question</em>, <em>meeting_request</em>. Reason: dormant leads pushing back is a firm no — handle personally. Curiosity is a warm signal the AI can nurture.</p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">All templates share these guardrails</h4>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Never invent pricing, availability, or product capabilities not in the KB.</li>
          <li>If asked something outside the KB, escalate rather than guess.</li>
          <li>Never mention being AI, an assistant, or a bot.</li>
          <li>Match the recipient's energy — shorter for short messages, longer for detailed ones.</li>
          <li>Never sign off with "as an AI language model" or similar disclosures.</li>
          <li>Under 100 words for email replies, under 160 chars for SMS.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-6">Recommended tuning after creating from a template</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Edit the "Agent name" placeholder (the seed KB uses <code>{`{{agent_name}}`}</code> for a sales rep name) to whoever should sign your outbound emails.</li>
          <li>Update the "Product one-liner" KB item to your actual pitch.</li>
          <li>Add 2-3 KB items specific to your ICP: real pricing tiers if you want AI to quote them, actual product features, real availability windows.</li>
          <li>Test in Playground with 3-4 real historical inbounds you've received. Adjust escalation intents if the AI over-escalates or under-escalates on your actual traffic.</li>
          <li>Set as tenant default OR attach to specific journeys (Settings tab in journey builder).</li>
        </ol>
      </div>
    ),
  },
  {
    id: "multi-tenant-onboarding",
    category: "webhooks",
    title: "New Client Onboarding Checklist",
    subtitle: "End-to-end setup for a new tenant. ~30 minutes if you have all the credentials handy.",
    icon: Users,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          When you bring a new client into the engine, the same global webhook URLs apply — you don't provision anything new on our side per client. The only per-tenant work is pasting THEIR credentials into Example Co and pasting our webhook URLs into THEIR provider consoles.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Pre-flight — what to collect from the client</h4>
        <ul className="list-disc pl-5 space-y-1">
          <li>Google Cloud project details (or ability to create one in their Workspace) — for Gmail OAuth client ID + secret.</li>
          <li>Twilio account SID + auth token + at least one phone number.</li>
          <li>Retell API key (if using voice) + agent IDs.</li>
          <li>OpenAI or Anthropic API key (if using AI replies).</li>
          <li>The list of mailboxes to send from (2 per domain works well for warmup).</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Step-by-step in Example Co</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li><strong>Create the tenant</strong> and add the client's admin user via Settings → Access.</li>
          <li><strong>Settings → Tenant Info</strong> — set timezone, business hours, team alert email.</li>
          <li><strong>Settings → Credentials</strong> — add each provider with the client's keys.
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li>Twilio: Account SID, Auth Token, From Number (E.164), optional Messaging Service SID.</li>
              <li>Gmail: Google Client ID + Client Secret from their Google Cloud project. See <em>Gmail OAuth — Connect a Sender</em>.</li>
              <li>Retell: API key.</li>
              <li>Anthropic / OpenAI: API key.</li>
            </ul>
          </li>
          <li><strong>Settings → Senders</strong> — add each mailbox → paste Gmail Client ID/Secret if it's different per-mailbox → click <em>Connect Google</em> → authorize the OAuth flow.</li>
          <li><strong>Settings → AI Agents</strong> — turn on the tenant master switch → create a default agent using a template (see <em>AI Agent Templates</em>) → set as tenant default.</li>
          <li><strong>Templates + Custom Fields</strong> — as needed for the client's use cases.</li>
          <li><strong>Journeys</strong> — build the outbound sequences. Each journey can pin its own AI agent from the Settings tab.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Step-by-step in the client's provider consoles</h4>
        <p>These URLs are the SAME globally — one per channel. The engine identifies the tenant from the payload, not the URL.</p>
        <div className="space-y-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl p-3">
          <div>
            <p className="font-medium text-zinc-800 dark:text-zinc-100">Twilio Console → Phone Numbers → each of the client's numbers</p>
            <p className="text-[11px] mt-0.5">A MESSAGE COMES IN → POST → <code className="break-all">https://your-project-ref.supabase.co/functions/v1/twilio-inbound</code></p>
            <p className="text-[11px]">A MESSAGE STATUS CHANGES → POST → <code className="break-all">https://your-project-ref.supabase.co/functions/v1/twilio-status</code></p>
          </div>
          <div>
            <p className="font-medium text-zinc-800 dark:text-zinc-100">Retell Console → each agent</p>
            <p className="text-[11px] mt-0.5">Post-Call Webhook URL → <code className="break-all">https://your-project-ref.supabase.co/functions/v1/retell-result</code></p>
          </div>
          <div>
            <p className="font-medium text-zinc-800 dark:text-zinc-100">Google Cloud Console → each OAuth client</p>
            <p className="text-[11px] mt-0.5">Authorized redirect URIs → <code className="break-all">https://&lt;YOUR-FOLLOWUP-DOMAIN&gt;/api/oauth/google/callback</code></p>
          </div>
        </div>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">How the engine avoids cross-tenant mistakes</h4>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Inbound SMS:</strong> Twilio tells us which of OUR numbers received the message (the <code>To</code> field). We resolve tenant by <code>tenant_credentials.config.from_number = To</code>. A UNIQUE index prevents two tenants from configuring the same number.</li>
          <li><strong>Inbound email:</strong> We poll each mailbox using ITS tenant's OAuth token. Cross-tenant leak is architecturally impossible — we can only read what we have a token for.</li>
          <li><strong>Call results:</strong> Retell's <code>call_id</code> maps back to the event row we inserted at dispatch, which carries <code>tenant_id</code> + <code>lead_id</code>.</li>
          <li><strong>Twilio delivery status:</strong> <code>MessageSid</code> is unique per message and stamped as <code>provider_id</code> on the outbound event.</li>
        </ul>
      </div>
    ),
  },
  {
    id: "journey-webhook-trigger",
    category: "webhooks",
    title: "Enroll leads from external forms (Journey Webhook Trigger)",
    subtitle: "Send form submissions from Tally, Typeform, Framer, custom apps, etc. directly into a journey.",
    icon: Zap,
    content: (
      <div className="space-y-5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <p>
          Each journey can have its own webhook URL. Point your form-provider's webhook at it, and every submission becomes an enrolled lead — matched against any existing rows or created new, with custom fields mapped straight from the payload.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">1. Enable webhook trigger on the journey</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Open the journey in the builder.</li>
          <li>Click the trigger node → set <strong>Trigger type</strong> to <em>Webhook</em>.</li>
          <li>Save. The engine generates a unique webhook token for this journey.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">2. Copy the webhook URL + secret</h4>
        <p>Trigger node side panel shows the URL, similar to:</p>
        <div className="bg-zinc-950/10 dark:bg-black/60 p-2.5 rounded-xl font-mono text-[11px] border border-black/10 dark:border-white/10 break-all">
          https://&lt;your-followup-domain&gt;/api/journeys/&lt;journey-id&gt;/webhook?token=&lt;secret&gt;
        </div>
        <p className="text-[11px] text-zinc-500 italic">
          The token is per-journey. Rotating it invalidates any external system still using the old token. Copy from the same panel whenever you set up a new integration.
        </p>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">3. Wire the mapping (payload → lead fields)</h4>
        <p>
          The trigger panel has a <strong>Playground</strong> where you paste a real sample payload from your form. Type dot-paths against it to extract each field. For each mapping row you specify:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Key</strong> — the lead field to write into. Standard fields: <code>first_name</code>, <code>last_name</code>, <code>email</code>, <code>phone_e164</code>. Or a custom field: <code>custom.pricing_tier</code>.</li>
          <li><strong>Path</strong> — where in the payload to read from. Supports dot notation and array indexes: <code>data.fields.3.value</code> or <code>contact.emails.0</code>.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">4. Configure your form provider</h4>
        <p>Paste the webhook URL into the form's outgoing webhook config. Use POST. Content-Type <code>application/json</code>.</p>
        <p>Provider-specific notes:</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Tally:</strong> Integrations → Webhook → paste URL → Enable.</li>
          <li><strong>Typeform:</strong> Connect → Webhooks → Add → paste URL. Uses secret in header — set the same secret in trigger config's <em>Signing secret</em> field.</li>
          <li><strong>Framer Forms:</strong> Component Settings → Webhook URL → paste.</li>
          <li><strong>Custom app:</strong> POST JSON to the URL. Response is <code>{`{ok: true, lead_id, action_id?}`}</code> on success.</li>
        </ul>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">5. Test the roundtrip</h4>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Submit a real form (or click "Send test" in your form provider).</li>
          <li>Trigger panel → <em>Recent samples</em> shows the payload the engine received.</li>
          <li>Leads page → find the lead by email → drawer → journey should show enrolled with the first step queued.</li>
        </ol>

        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Deduplication</h4>
        <p>
          If a lead with the same email already exists in this tenant, the engine updates that row instead of creating a duplicate. Their existing journey state, if any, is respected (they aren't re-enrolled to step 0 unless they had already completed the journey).
        </p>
      </div>
    ),
  },
  {
    id: "troubleshooting",
    category: "troubleshooting",
    title: "Troubleshooting common issues",
    subtitle: "Find answers to JSON parse issues, failed webhooks, or empty tags.",
    icon: AlertTriangle,
    content: (
      <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
        <h4 className="font-semibold text-zinc-900 dark:text-white">Why are my merge tags returning empty?</h4>
        <p>
          1. <strong>Case sensitivity:</strong> Verify that the casing matches exactly. <code>{`{{raw_payload.email}}`}</code> is different from <code>{`{{raw_payload.Email}}`}</code>.<br />
          2. <strong>Wrong index:</strong> Ensure array element indexes start at 0. If you map <code>data.fields.5</code> but the array only has 4 items, the output will resolve to null/empty.<br />
          3. <strong>Data types:</strong> Complex nested JSON objects cannot be merged into standard text columns directly without reaching the specific string value at the leaf of the path.
        </p>
        
        <h4 className="font-semibold text-zinc-900 dark:text-white mt-4">Testing webhooks dynamically</h4>
        <p>
          Use the <strong>Webhook mapper playground</strong> (featured on this page) to copy the exact payload sent by your integration provider,
          type a path, and instantly check what values are generated.
        </p>
      </div>
    )
  }
]

// Default tally payload for playground
const DEFAULT_TALLY_PAYLOAD = `{
  "data": {
    "fields": [
      {
        "key": "question_OLPXOK",
        "type": "INPUT_TEXT",
        "label": "First Name",
        "value": "John"
      },
      {
        "key": "question_VVlP2a",
        "type": "INPUT_TEXT",
        "label": "Last Name",
        "value": "Doe"
      },
      {
        "key": "question_PlE9VQ",
        "type": "INPUT_PHONE_NUMBER",
        "label": "Phone",
        "value": "+919762456243"
      },
      {
        "key": "question_EL1lyo",
        "type": "INPUT_EMAIL",
        "label": "Email",
        "value": "demo@example.com"
      },
      {
        "key": "question_nQD1rO",
        "type": "MULTIPLE_CHOICE",
        "label": "Coverage Type",
        "value": [
          "Auto/Car"
        ]
      }
    ]
  }
}`

export default function DocsPage() {
  const [searchTerm, setSearchTerm] = useState("")
  const [activeCategory, setActiveCategory] = useState("all")
  const [expandedArticle, setExpandedArticle] = useState(null)
  
  // Playground state
  const [rawJson, setRawJson] = useState(DEFAULT_TALLY_PAYLOAD)
  const [dotPath, setDotPath] = useState("data.fields.0.value")
  const [copied, setCopied] = useState(false)

  // Categories helper
  const categories = [
    { key: "all", label: "All Topics" },
    { key: "updates", label: "What's New" },
    { key: "webhooks", label: "Webhooks & Mapping" },
    { key: "workflows", label: "Journeys & Nodes" },
    { key: "fields", label: "Custom Fields & Tags" },
    { key: "troubleshooting", label: "Troubleshooting" }
  ]

  // Filtered articles
  const filteredArticles = useMemo(() => {
    return ARTICLES.filter((art) => {
      const matchesCategory = activeCategory === "all" || art.category === activeCategory
      const matchesSearch = 
        art.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        art.subtitle.toLowerCase().includes(searchTerm.toLowerCase())
      return matchesCategory && matchesSearch
    })
  }, [searchTerm, activeCategory])

  // Resolve JSON path
  const resolvedPlaygroundValue = useMemo(() => {
    try {
      const parsed = JSON.parse(rawJson)
      if (!dotPath || dotPath.trim() === "") {
        return { success: true, value: parsed, type: typeof parsed }
      }
      
      const cleanPath = dotPath.replace(/^raw_payload\./, "") // strip raw_payload prefix if user types it
      const parts = cleanPath.split(".")
      let current = parsed
      
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (current === null || current === undefined) {
          return { success: false, error: `Path broken at: "${parts.slice(0, i + 1).join(".")}" (is undefined)` }
        }
        
        const index = parseInt(part, 10)
        if (!isNaN(index) && Array.isArray(current)) {
          current = current[index]
        } else {
          current = current[part]
        }
      }

      if (current === undefined) {
        return { success: false, error: `Value is undefined at: "${cleanPath}"` }
      }

      const type = Array.isArray(current) ? "array" : typeof current
      return { success: true, value: current, type }
    } catch (err) {
      return { success: false, error: `Invalid JSON payload: ${err.message}` }
    }
  }, [rawJson, dotPath])

  // Copy to clipboard helper
  const handleCopyTag = (tag) => {
    navigator.clipboard.writeText(tag)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8 p-6">
      
      {/* Header section with modern glass styling */}
      <div className="relative rounded-3xl p-8 overflow-hidden bg-gradient-to-br from-violet-500/10 via-blue-500/5 to-transparent border border-black/5 dark:border-white/5 backdrop-blur-2xl">
        <div className="absolute top-0 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl -z-10" />
        <div className="absolute bottom-0 left-0 w-80 h-80 bg-blue-500/10 rounded-full blur-3xl -z-10" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <Sparkles className="w-3.5 h-3.5" /> Incremental Knowledge Hub
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-2">
              <AppIcon name="documentation" size={32} className="text-zinc-700 dark:text-zinc-300" />
              Help Center & Docs
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-xl">
              Learn how to map webhook responses, leverage dot notation, configure journey actions, and custom fields.
            </p>
          </div>
          
          {/* Search bar */}
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input
              type="text"
              placeholder="Search guides..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-black/40 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
            />
          </div>
        </div>
      </div>

      {/* Main Grid: Left is Articles, Right is Webhook Mapper Playground */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Left Side: Category tabs & Articles */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Category Filter Tabs */}
          <div className="flex flex-wrap gap-2 pb-1 border-b border-black/5 dark:border-white/5">
            {categories.map((cat) => (
              <button
                key={cat.key}
                onClick={() => {
                  setActiveCategory(cat.key)
                  setExpandedArticle(null)
                }}
                className={`px-3 py-2 text-xs font-semibold rounded-lg transition-all duration-300 ${
                  activeCategory === cat.key
                    ? "bg-zinc-950 dark:bg-white text-white dark:text-black"
                    : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-950/5 dark:hover:bg-white/5"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Articles list */}
          <div className="space-y-4">
            {filteredArticles.length === 0 ? (
              <div className="text-center py-12 border border-dashed border-black/10 dark:border-white/10 rounded-2xl">
                <HelpCircle className="w-8 h-8 text-zinc-400 mx-auto mb-3" />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">No articles matched your search.</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">Try resetting the category filter or search query.</p>
              </div>
            ) : (
              filteredArticles.map((art) => {
                const ArtIcon = art.icon
                const isExpanded = expandedArticle === art.id
                return (
                  <div 
                    key={art.id} 
                    className="border border-black/5 dark:border-white/5 rounded-2xl bg-white/40 dark:bg-black/20 backdrop-blur-md overflow-hidden transition-all duration-300 hover:border-black/10 dark:hover:border-white/10"
                  >
                    <div 
                      onClick={() => setExpandedArticle(isExpanded ? null : art.id)}
                      className="p-5 flex items-start gap-4 cursor-pointer select-none"
                    >
                      <div className="p-2.5 rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
                        <ArtIcon className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">{art.title}</h3>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{art.subtitle}</p>
                      </div>
                      <div className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-5 pb-5 pt-2 border-t border-black/5 dark:border-white/5 bg-zinc-500/[0.01]">
                        {art.content}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Right Side: Interactive Webhook Playground */}
        <div className="space-y-6">
          <div className="p-6 rounded-2xl bg-white/40 dark:bg-black/20 border border-black/5 dark:border-white/5 backdrop-blur-2xl space-y-4">
            
            <div className="flex items-center gap-2 text-zinc-900 dark:text-white">
              <Play className="w-4 h-4 text-violet-500 fill-violet-500/20" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-300">Webhook mapper playground</h2>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-normal">
              Paste a test JSON payload and enter a dot-notation mapping path to instantly evaluate the resulting field value.
            </p>

            {/* JSON Payload input */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold">JSON Webhook Payload</span>
                <button 
                  onClick={() => setRawJson(DEFAULT_TALLY_PAYLOAD)}
                  className="text-[10px] text-violet-600 dark:text-violet-400 hover:underline flex items-center gap-1"
                >
                  <RefreshCw className="w-2.5 h-2.5" /> Reset to Tally Sample
                </button>
              </div>
              <textarea
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                className="w-full h-48 px-3 py-2 border border-black/10 dark:border-white/10 rounded-xl bg-white dark:bg-black text-[11px] font-mono text-zinc-800 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
              />
            </div>

            {/* Path mapping input */}
            <div className="space-y-1.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold">Dot-Notation Path</span>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 text-xs font-mono">raw_payload.</span>
                <input
                  type="text"
                  value={dotPath}
                  onChange={(e) => setDotPath(e.target.value)}
                  className="w-full h-9 pl-24 pr-4 border border-black/10 dark:border-white/10 rounded-xl bg-white dark:bg-black text-xs font-mono text-zinc-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-violet-500/30"
                  placeholder="e.g. data.fields.0.value"
                />
              </div>
            </div>

            {/* Resolved outputs */}
            <div className="pt-2 border-t border-black/5 dark:border-white/5 space-y-3">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-semibold block">Result Preview</span>
              
              {resolvedPlaygroundValue.success ? (
                <div className="p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/10 space-y-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Valid Mapping
                    </span>
                    <span className="text-zinc-400 dark:text-zinc-500 uppercase font-mono">type: {resolvedPlaygroundValue.type}</span>
                  </div>
                  
                  <div className="text-xs font-mono text-zinc-800 dark:text-zinc-200 break-words overflow-x-auto max-h-36 bg-black/5 dark:bg-black/40 p-2 rounded-lg">
                    {typeof resolvedPlaygroundValue.value === "object" 
                      ? JSON.stringify(resolvedPlaygroundValue.value, null, 2)
                      : String(resolvedPlaygroundValue.value)
                    }
                  </div>

                  {/* Copy Tag Button */}
                  <div className="pt-1">
                    <button
                      onClick={() => handleCopyTag(`{{raw_payload.${dotPath.replace(/^raw_payload\./, "")}}}`)}
                      className="w-full h-8 flex items-center justify-center gap-1.5 text-xs border border-zinc-950/10 dark:border-white/10 rounded-lg hover:bg-zinc-950/5 dark:hover:bg-white/5 text-zinc-700 dark:text-zinc-300 font-medium transition-all"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                          Copied tag!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy Merge Tag
                        </>
                      )}
                    </button>
                  </div>

                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-rose-500/5 border border-rose-500/10 space-y-1">
                  <div className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 uppercase">Evaluation Error</div>
                  <div className="text-xs font-mono text-rose-600 dark:text-rose-400">{resolvedPlaygroundValue.error}</div>
                </div>
              )}
            </div>

          </div>
        </div>

      </div>

    </div>
  )
}
