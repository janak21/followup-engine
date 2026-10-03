"use client"

import { useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Send, Loader2 } from "lucide-react"
import { useMergeFieldGroups, InsertFieldMenu, insertTokenAtCaret } from "./MergeFields"

// Inline email composer for an email step. Writes flat step fields
// (inline_subject, inline_body, sender_id, from_name, content_mode) that
// compileWorkflow copies into step_spec, which get_email_payload reads.
//
// Merge fields are inserted in "email" (template) syntax: bare {{first_name}}
// and bare {{<custom_key>}} tokens, matching render_template. Webhook-payload
// tokens are intentionally absent here — render_template can't resolve them.
export function EmailInlineComposer({ step, onUpdate, senders = [], customFields = [], samples = [], webhookMappings = [], onSendTest, sendingTest }) {
  const subjectRef = useRef(null)
  const bodyRef = useRef(null)
  const [lastFocused, setLastFocused] = useState("body")
  const [testTo, setTestTo] = useState("")

  const mergeGroups = useMergeFieldGroups(customFields, samples, "email", webhookMappings)

  // Insert into whichever field (subject or body) was focused last.
  const insertToken = (token) => {
    const field = lastFocused === "subject" ? "inline_subject" : "inline_body"
    const el = lastFocused === "subject" ? subjectRef.current : bodyRef.current
    const { next, caret } = insertTokenAtCaret(el, step[field], token)
    onUpdate({ [field]: next, content_mode: "inline", template_key: "" })
    // Restore focus + caret just after the inserted token once state applies.
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        try { el.setSelectionRange(caret, caret) } catch { /* number/email inputs */ }
      }
    })
  }

  const senderValid = senders.some((s) => s.id === step.sender_id)

  return (
    <div className="p-4 bg-zinc-50 dark:bg-black/40 border border-zinc-200 dark:border-white/5 rounded-2xl space-y-3">
      {/* Insert-field control */}
      <div className="flex justify-end">
        <InsertFieldMenu groups={mergeGroups} onPick={insertToken} />
      </div>

      {/* Subject */}
      <div className="space-y-1.5">
        <Label className="text-[10px] text-zinc-400 font-bold uppercase">Email Subject</Label>
        {/* Native input (not the UI Input) so caret-position insertion works. */}
        <input
          ref={subjectRef}
          value={step.inline_subject || ""}
          onFocus={() => setLastFocused("subject")}
          onChange={(e) => onUpdate({ inline_subject: e.target.value, content_mode: "inline", template_key: "" })}
          placeholder="Subject line — supports {{first_name}} etc."
          className="w-full h-9 px-2.5 text-xs bg-white dark:bg-black border border-zinc-200 dark:border-white/10 rounded-xl text-zinc-900 dark:text-white focus:outline-none"
        />
      </div>

      {/* Body */}
      <div className="space-y-1.5">
        <Label className="text-[10px] text-zinc-400 font-bold uppercase">Body</Label>
        <textarea
          ref={bodyRef}
          value={step.inline_body || ""}
          rows={6}
          onFocus={() => setLastFocused("body")}
          onChange={(e) => onUpdate({ inline_body: e.target.value, content_mode: "inline", template_key: "" })}
          placeholder="Write the message here. Plain text or HTML. Merge tags like {{first_name}} resolve at send time."
          className="w-full p-3 text-xs bg-white dark:bg-black rounded-xl border border-zinc-200 dark:border-white/10 focus:outline-none font-sans text-zinc-900 dark:text-white"
        />
      </div>

      {/* From: sender picker + optional display-name override */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-[10px] text-zinc-400 font-bold uppercase">From (sender)</Label>
          <select
            value={step.sender_id || ""}
            onChange={(e) => onUpdate({ sender_id: e.target.value || undefined, content_mode: "inline" })}
            className="w-full h-9 px-2 text-xs bg-white dark:bg-black border border-zinc-200 dark:border-white/10 rounded-xl text-zinc-900 dark:text-white focus:outline-none"
          >
            <option value="">-- Choose a connected sender --</option>
            {senders.map((s) => (
              <option key={s.id} value={s.id}>
                {(s.sender_name ? `${s.sender_name} · ` : "")}{s.sender_email}{s.active === false ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[10px] text-zinc-400 font-bold uppercase">From name (optional)</Label>
          <Input
            value={step.from_name || ""}
            onChange={(e) => onUpdate({ from_name: e.target.value || undefined, content_mode: "inline" })}
            placeholder="e.g. Alex from Example Co"
            className="h-9 text-xs bg-white dark:bg-black border-zinc-200 dark:border-white/10 rounded-xl"
          />
        </div>
      </div>
      <p className="text-[11px] text-zinc-500">
        Emails send from your connected sender&apos;s address. The From name only changes the display name.
        {step.sender_id && !senderValid ? " The selected sender no longer exists — pick another." : ""}
      </p>

      {/* Send test */}
      <div className="flex items-end gap-2 border-t border-black/5 dark:border-white/5 pt-3">
        <div className="flex-1 space-y-1.5">
          <Label className="text-[10px] text-zinc-400 font-bold uppercase">Send a test to</Label>
          <Input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@example.com"
            className="h-9 text-xs bg-white dark:bg-black border-zinc-200 dark:border-white/10 rounded-xl"
          />
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => onSendTest?.(testTo.trim())}
          disabled={sendingTest || !testTo.trim() || !step.sender_id}
          title={!step.sender_id ? "Pick a sender first" : "Send a rendered test to this address"}
          className="h-9 rounded-xl gap-1.5 text-xs"
        >
          {sendingTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Send test
        </Button>
      </div>

      <p className="text-[11px] text-zinc-500">
        Saved on this step. Existing queued actions keep the step snapshot they were created with.
      </p>
    </div>
  )
}
