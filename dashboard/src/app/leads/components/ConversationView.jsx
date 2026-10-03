"use client"

// Conversation timeline for the lead detail drawer. Extracted verbatim from
// leads/page.jsx.

import { useEffect, useState } from "react"
import {
  AlertCircle, ChevronRight, Info, Loader2, Mail, MessageSquare, Sparkles,
} from "lucide-react"
import { getDeliveryStatusDisplay, getStatusPillClass } from "@/lib/statusDisplay"
import { getTimelineEventDisplay, humanizeInlineLabel } from "./leadDisplay"

// ConversationView
// =========================================================================
//
// Chat-bubble view of a lead's exchange with us across email / SMS / calls.
// Reads from the existing timeline items so we don't add a second fetch path.
//
// Filter:  All | Email | SMS | Calls
// Sort:    oldest → newest (conversation feel; not timeline order)
// Group:   by date label (Today / Yesterday / weekday / Mon DD)
// Bubble:  outbound = right, brand-tinted | inbound = left, neutral
//          system events (cancellations, opt-outs, etc.) centered, small
//
// Body rendering: bodies are stripped to plain text first. Email bodies
// often arrive as HTML; rendering them with dangerouslySetInnerHTML is a
// foot-gun (XSS, broken layouts, embedded tracking pixels). Plain text is
// also closer to what an operator actually wants to skim.
function ConversationView({
  timeline,
  loading,
  lead,
  channelFilter,
  setChannelFilter,
  stripHtmlAndEntities,
  stripQuotedTail,    // (s) => only the new text, no quoted tail
  dateBucketLabel,
  formatTimeOnly,
  onReplySent,        // () => refetch timeline
  onComposerError,    // (msg) => show toast
  showSystemLogs = false,
}) {
  // Composer state. Channel auto-defaults to email unless the lead has no
  // email but has a phone. Operator can override.
  const [replyChannel, setReplyChannel] = useState(
    (lead?.email ? "email" : (lead?.phone_e164 ? "sms" : "email"))
  )
  const [replyBody, setReplyBody] = useState("")
  const [replyBusy, setReplyBusy] = useState(false)

  useEffect(() => {
    // When switching leads, clear the composer + re-pick default channel.
    setReplyBody("")
    setReplyChannel(lead?.email ? "email" : (lead?.phone_e164 ? "sms" : "email"))
  }, [lead?.id])

  const canSend = (() => {
    if (!replyBody.trim() || replyBusy) return false
    if (lead?.opt_out) return false
    if (replyChannel === "email" && !lead?.email) return false
    if (replyChannel === "sms"   && !lead?.phone_e164) return false
    return true
  })()

  const handleSend = async () => {
    if (!canSend || !lead?.id) return
    setReplyBusy(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: replyChannel, body: replyBody.trim() }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j?.ok) {
        const msg = j?.error || `HTTP ${res.status}`
        onComposerError?.(`Reply failed: ${msg}`)
      } else {
        setReplyBody("")
        // Refetch so the new outbound bubble shows up at the bottom.
        onReplySent?.()
        // Distinguish throttle (healthy deferral) from actual dispatch errors.
        // Throttle = sender cooldown / daily cap; the action was rescheduled
        // and pg_cron will fire it at next_eligible_at. NOT an error.
        const dr = j?.dispatch_result
        if (dr?.throttled === true) {
          const deferred = dr.deferred_until ? new Date(dr.deferred_until) : null
          const inMin = deferred ? Math.max(1, Math.round((deferred - Date.now()) / 60000)) : null
          onComposerError?.(
            inMin
              ? `Reply queued. Sender on cooldown — will send in ~${inMin} min.`
              : `Reply queued. Will send when sender is eligible.`
          )
        } else if (j.dispatched === false) {
          onComposerError?.("Reply queued but immediate dispatch had an issue. It'll retry within ~1 min.")
        }
      }
    } catch (err) {
      onComposerError?.(`Network error: ${err?.message || String(err)}`)
    } finally {
      setReplyBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-3">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400 dark:text-gray-500" />
        <span className="text-sm text-zinc-500 dark:text-gray-500">Loading conversation…</span>
      </div>
    )
  }

  // Filter to only the items that make sense in a conversation (have a body
  // or were a call). System "info" / "cancellation" rows are kept so the
  // conversation has context — they render as a centered chip.
  const channelOk = (it) => {
    if (channelFilter === "all") return true
    return it.channel === channelFilter
  }
  // Action↔Event dedupe: when an outbound send completes the timeline has
  // BOTH the action row (queue/throttle/retry metadata) AND the event row
  // (the actual message body). For a conversation we want one bubble per
  // message, with the body — so we prefer the event whenever it exists
  // and suppress the matching action. Pending/failed actions with no
  // event yet still pass through (they're either future plans or
  // failures, useful context either way).
  const eventActionIds = new Set(
    (timeline || [])
      .filter((it) => it.type === "outbound" || it.type === "inbound")
      .map((it) => it.actionId)
      .filter(Boolean)
  )
  const items = (timeline || [])
    .filter((it) => channelOk(it))
    .filter((it) => {
      const allowed = ["email", "sms", "call"]
      if (showSystemLogs) allowed.push("system")
      return allowed.includes(it.channel)
    })
    .filter((it) =>
      // Drop scheduled future actions (status=pending && isFuture) — those
      // aren't conversation, they're plans. Keep historical pending/failed
      // because they're useful context ("we tried but it bounced").
      !(it.status === "pending" && it.isFuture)
    )
    // Suppress the action half of an action+event pair. Action items in
    // this codebase don't carry a body (it lives on the event), so showing
    // both would produce one empty bubble + one real bubble per message.
    .filter((it) => {
      const isActionItem = it.type === "outbound" && !it.actionId && !it.body && !it.details?.body
      const hasMatchingEvent = eventActionIds.has(it.id)
      return !hasMatchingEvent
    })
    .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))

  // Group by date bucket. Insertion order respected.
  const grouped = items.reduce((acc, it) => {
    const key = dateBucketLabel(it.timestamp)
    if (!acc[key]) acc[key] = []
    acc[key].push(it)
    return acc
  }, {})
  const bucketKeys = Object.keys(grouped)

  const tabs = [
    { v: "all",   label: "All",    Icon: Sparkles },
    { v: "email", label: "Email",  Icon: Mail },
    { v: "sms",   label: "SMS",    Icon: MessageSquare },
    { v: "call",  label: "Calls",  Icon: PhoneCall },
  ]

  return (
    <div className="space-y-5">
      {/* Channel filter chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {tabs.map((t) => {
          const active = channelFilter === t.v
          const count = t.v === "all"
            ? items.length
            : (timeline || []).filter((x) => x.channel === t.v).length
          const Icon = t.Icon
          return (
            <button
              key={t.v}
              type="button"
              onClick={() => setChannelFilter(t.v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors ${
                active
                  ? "bg-zinc-900 dark:bg-white text-white dark:text-black border-transparent shadow-sm"
                  : "bg-zinc-100 dark:bg-white/5 text-zinc-600 dark:text-gray-400 border-black/5 dark:border-white/10 hover:bg-zinc-200 dark:hover:bg-white/10"
              }`}
            >
              <Icon className="w-3 h-3" />
              {t.label}
              <span className={`text-[10px] px-1 rounded ${active ? "bg-white/20 dark:bg-black/15" : "bg-zinc-200 dark:bg-white/10"}`}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Empty state */}
      {items.length === 0 ? (
        <div className="text-center py-10 text-xs text-zinc-400 dark:text-gray-500 bg-zinc-950/[0.01] dark:bg-white/[0.01] border border-dashed border-black/10 dark:border-white/5 rounded-2xl">
          {channelFilter === "all"
            ? "No conversation yet on this lead."
            : `No ${channelFilter} messages yet on this lead.`}
          {channelFilter === "email" && (
            <p className="mt-2 text-[10px] text-zinc-400/80 dark:text-gray-500 max-w-md mx-auto leading-relaxed">
              If the lead has replied to a journey email but it isn't showing here, the sender's inbox may not be watched for inbound. See "Gmail OAuth — Connect a Sender" in Docs for inbound capture setup.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {bucketKeys.map((bucket) => (
            <div key={bucket} className="space-y-2">
              {/* Date divider */}
              <div className="flex items-center gap-2 py-1">
                <div className="flex-1 border-t border-dashed border-black/10 dark:border-white/10" />
                <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-gray-500 font-semibold">{bucket}</span>
                <div className="flex-1 border-t border-dashed border-black/10 dark:border-white/10" />
              </div>
              {grouped[bucket].map((it) => (
                <ConversationBubble
                  key={it.id}
                  item={it}
                  lead={lead}
                  stripHtmlAndEntities={stripHtmlAndEntities}
                  stripQuotedTail={stripQuotedTail}
                  formatTimeOnly={formatTimeOnly}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ---------- Inline reply composer ----------
          Persistent at the bottom of the conversation view. The operator
          picks a channel (email/sms), types into the textarea, and clicks
          Send. POSTs /api/leads/[id]/reply, which enqueues an action with
          payload.inline = { body } and immediately invokes dispatch. */}
      {lead?.id && (
        <div className="sticky bottom-0 bg-white/85 dark:bg-zinc-950/85 backdrop-blur-md border border-black/10 dark:border-white/10 rounded-2xl p-3 shadow-lg space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center bg-zinc-100 dark:bg-white/5 rounded-lg p-0.5 text-[11px]">
              {lead?.email && (
                <button
                  type="button"
                  onClick={() => setReplyChannel("email")}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                    replyChannel === "email"
                      ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                      : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
                  }`}
                  title={`Reply via email to ${lead.email}`}
                >
                  <Mail className="w-3 h-3" /> Email
                </button>
              )}
              {lead?.phone_e164 && (
                <button
                  type="button"
                  onClick={() => setReplyChannel("sms")}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                    replyChannel === "sms"
                      ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                      : "text-zinc-500 dark:text-gray-400 hover:text-zinc-700 dark:hover:text-gray-200"
                  }`}
                  title={`Reply via SMS to ${lead.phone_e164}`}
                >
                  <MessageSquare className="w-3 h-3" /> SMS
                </button>
              )}
            </div>
            {lead?.opt_out && (
              <span className="text-[10px] text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> Lead opted out — composer disabled
              </span>
            )}
          </div>
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            disabled={lead?.opt_out || replyBusy}
            placeholder={
              replyChannel === "email"
                ? `Reply to ${lead?.email || "lead"}…  (threading carries to existing email thread)`
                : `Reply to ${lead?.phone_e164 || "lead"}…  (SMS, kept short)`
            }
            rows={replyChannel === "sms" ? 2 : 3}
            onKeyDown={(e) => {
              // Cmd/Ctrl + Enter to send. Common convention.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault()
                handleSend()
              }
            }}
            className="w-full bg-white dark:bg-black/30 border border-black/10 dark:border-white/10 text-zinc-900 dark:text-white rounded-xl px-3 py-2 text-sm leading-relaxed outline-none focus:border-black/20 dark:focus:border-white/20 resize-none placeholder:text-zinc-400 dark:placeholder:text-gray-500"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-400 dark:text-gray-500">
              {replyChannel === "sms"
                ? `${replyBody.length} chars · 1 SMS segment ≤ 160`
                : "⌘/Ctrl + Enter to send"}
            </span>
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                canSend
                  ? "bg-zinc-900 dark:bg-white text-white dark:text-black hover:bg-zinc-800 dark:hover:bg-white/90"
                  : "bg-zinc-200 dark:bg-white/5 text-zinc-400 dark:text-gray-500 cursor-not-allowed"
              }`}
            >
              {replyBusy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  Send {replyChannel === "email" ? "email" : "SMS"} <ChevronRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// One row in the conversation. Outbound right, inbound left, system centered.
function ConversationBubble({ item, lead, stripHtmlAndEntities, stripQuotedTail, formatTimeOnly }) {
  const isOutbound = item.type === "outbound"
  const isInbound  = item.type === "inbound"
  const isSystem   = !isOutbound && !isInbound
  const isEmail = item.channel === "email"
  const isSMS   = item.channel === "sms"
  const isCall  = item.channel === "call"
  const deliveryDisplay = isOutbound ? getDeliveryStatusDisplay(item.status, item) : null

  // System rows = engagement cancels, opt-outs, internal info, AI escalations.
  if (isSystem) {
    // AI escalation: show full chip with reasoning + the AI's suggested reply
    // so the operator can copy it into the composer if they want to use it.
    if (item.isAIEscalation) {
      return (
        <div className="flex justify-center">
          <div className="max-w-[78%] bg-amber-500/5 border border-amber-500/30 rounded-2xl p-3 space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
              <AlertCircle className="w-3.5 h-3.5" />
              Needs your reply — AI escalated
              <span className="opacity-60 font-normal">· {formatTimeOnly(item.timestamp)}</span>
            </div>
            <div className="text-[10px] text-zinc-600 dark:text-gray-400">
              <span className="font-semibold">Reason:</span> {humanizeInlineLabel(item.aiEscalationReason)}
              {item.aiIntent && (
                <> · {humanizeInlineLabel(item.aiIntent, "Review needed")}</>
              )}
              {item.aiConfidence !== null && item.aiConfidence !== undefined && (
                <> · confidence {Math.round(item.aiConfidence * 100)}%</>
              )}
            </div>
            {item.aiReasoning && (
              <div className="text-[11px] text-zinc-700 dark:text-gray-300 italic">
                "{item.aiReasoning}"
              </div>
            )}
            {item.aiSuggestedReply && (
              <details className="text-[11px] text-zinc-700 dark:text-gray-300">
                <summary className="cursor-pointer text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white">
                  View AI's suggested reply (you may use or override)
                </summary>
                <p className="mt-1 whitespace-pre-wrap bg-zinc-950/5 dark:bg-black/30 p-2 rounded-lg border border-black/5 dark:border-white/5">
                  {item.aiSuggestedReply}
                </p>
              </details>
            )}
          </div>
        </div>
      )
    }
    return (
      <div className="flex justify-center">
        <div className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-gray-400 bg-zinc-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-full px-2.5 py-1">
          <Info className="w-3 h-3" />
          {getTimelineEventDisplay(item).title}
          <span className="opacity-50">· {formatTimeOnly(item.timestamp)}</span>
        </div>
      </div>
    )
  }

  // Status pill — failed / bounced sends get visible warning.
  const isFailed = item.status === "failed" || item.status === "failed_permanent" || item.status === "cancelled"

  // Build the text we'll show inside the bubble.
  //
  // Order matters:
  //   1. strip HTML + entities (so quote markers like "On X wrote:" are
  //      visible as plain lines instead of buried inside <div>s)
  //   2. strip quoted tail for INBOUND only — outbound is our own text,
  //      it never has a quoted tail unless we composed one in.
  const bodyRaw = item.details?.body || item.body || ""
  let bodyText = stripHtmlAndEntities(bodyRaw)
  if (isInbound && stripQuotedTail) {
    bodyText = stripQuotedTail(bodyText)
  }
  const subject = item.details?.subject || (isCall ? item.title : null)

  // Channel colors. Inbound stays neutral so outbound (us) reads as the
  // distinct voice; matches WhatsApp/iMessage/GHL conventions.
  const outboundBubble = isFailed
    ? "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/20"
    : "bg-zinc-900 dark:bg-white text-white dark:text-black border border-transparent"
  const inboundBubble = "bg-white dark:bg-zinc-900 text-zinc-800 dark:text-gray-200 border border-black/10 dark:border-white/10"

  // Per-channel meta icon.
  const ChannelIcon = isEmail ? Mail : isSMS ? MessageSquare : PhoneCall

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[78%] flex flex-col gap-1 ${isOutbound ? "items-end" : "items-start"}`}>
        {/* Who-said-what label */}
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 dark:text-gray-500">
          <ChannelIcon className="w-3 h-3" />
          {isOutbound
            ? <>You{item.sender_email ? <span className="opacity-70"> · {item.sender_email}</span> : null}</>
            : <>{lead?.first_name || lead?.email || "Lead"}</>}
          {/* AI badge — outbound bubbles whose parent action carried
              source='ai_reply' get a violet "AI" chip with the agent name
              and confidence shown on hover. */}
          {isOutbound && item.aiSource === "ai_reply" && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300 bg-violet-500/15 border border-violet-500/30 rounded-md px-1 py-0.5"
              title={[
                item.aiAgentName && `Agent: ${item.aiAgentName}`,
                item.aiIntent && `Intent: ${humanizeInlineLabel(item.aiIntent, "Review needed")}`,
                item.aiConfidence !== null && item.aiConfidence !== undefined && `Confidence: ${Math.round(item.aiConfidence * 100)}%`,
                item.aiReasoning && `Why: ${item.aiReasoning}`,
              ].filter(Boolean).join("\n")}
            >
              <Sparkles className="w-2.5 h-2.5" /> AI
            </span>
          )}
	          <span className="opacity-60">· {formatTimeOnly(item.timestamp)}</span>
	          {deliveryDisplay && (
	            <span className={getStatusPillClass(deliveryDisplay.variant, "text-[10px] px-1.5 py-0")} title={deliveryDisplay.title}>
	              {deliveryDisplay.label}
	            </span>
	          )}
	        </div>

        {/* The bubble itself */}
        <div className={`rounded-2xl px-3.5 py-2.5 shadow-sm ${isOutbound ? outboundBubble : inboundBubble}`}>
          {subject && (
            <div className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${isOutbound ? "opacity-70" : "text-zinc-500 dark:text-gray-400"}`}>
              {subject}
            </div>
          )}

          {/* Call-specific surface */}
          {isCall && item.callSummary && (
            <p className="text-xs whitespace-pre-wrap leading-relaxed mb-1">{item.callSummary}</p>
          )}
          {isCall && item.callRecordingUrl && (
            <audio
              controls
              preload="none"
              src={item.callRecordingUrl}
              className="mt-1 w-full max-w-[260px]"
            />
          )}

          {/* Body (email / sms) */}
          {bodyText && (
            <p className={`text-[13px] whitespace-pre-wrap leading-relaxed ${isCall ? "opacity-80" : ""}`}>
              {bodyText}
            </p>
          )}

          {/* Status banner if the send failed/bounced */}
          {isFailed && (item.subtitle || item.errorMessage) && (
            <div className="text-[10px] mt-1.5 pt-1.5 border-t border-rose-500/20 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {item.subtitle || item.errorMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export { ConversationView }
