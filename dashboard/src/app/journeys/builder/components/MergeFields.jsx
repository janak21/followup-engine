"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Braces } from "lucide-react"
import { buildMergeFieldGroups } from "@/lib/mergeFieldTokens"

// Shared "Insert field" plumbing for every free-text input that accepts merge
// tags (email subject/body, SMS body, HTTP url/body, inline templates, …).
//
// The picker lists fields BY NAME ONLY ("First name", "Email", a custom field's
// label, a webhook path) grouped by source. The underlying merge tag
// ({{first_name}} etc.) is inserted into the target on click but never shown —
// operators pick a human-readable field, not a raw token.

// Build the grouped field list for a `channel`. The emitted token SYNTAX is
// channel-aware because the two server resolvers disagree: template channels
// (email/sms/call/team_alert) get bare tokens for render_template, while
// expression channels (http_request/conditional_split) get namespaced
// {{lead.*}}/{{custom.*}}/{{payload.*}} for resolve_workflow_expr. See
// src/lib/mergeFieldTokens.js for the vocabulary quoted from the live functions.
export function useMergeFieldGroups(customFields = [], samples = [], channel = "email", webhookMappings = []) {
  return useMemo(
    () => buildMergeFieldGroups(customFields, samples, channel, webhookMappings),
    [customFields, samples, channel, webhookMappings],
  )
}

// Insert `token` at the element's caret (or the end when there is no selection).
// Returns the next string and the caret position that follows the insertion.
export function insertTokenAtCaret(el, current, token) {
  const cur = String(current || "")
  const start = el?.selectionStart ?? cur.length
  const end = el?.selectionEnd ?? cur.length
  const next = cur.slice(0, start) + token + cur.slice(end)
  return { next, caret: start + token.length }
}

// Dropdown button listing merge fields by name and calling onPick(token). Pure
// UI — the caller decides where the token goes.
export function InsertFieldMenu({ groups, onPick, align = "right", label = "Insert field", className = "" }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`relative ${className}`}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen((v) => !v)}
        className="h-7 rounded-lg text-[11px] gap-1"
      >
        <Braces className="w-3 h-3" /> {label}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`absolute ${align === "right" ? "right-0" : "left-0"} top-8 z-20 w-64 max-h-72 overflow-y-auto rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-2xl p-2`}
          >
            {groups.map((g) => (
              <div key={g.label} className="mb-1.5">
                <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400">{g.label}</div>
                {g.tokens.map((t) => (
                  <button
                    key={t.token}
                    type="button"
                    onClick={() => {
                      onPick(t.token)
                      setOpen(false)
                    }}
                    title={t.label}
                    className="w-full text-left px-2 py-1.5 rounded-lg text-[11px] hover:bg-indigo-500/10 truncate text-zinc-700 dark:text-zinc-200"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Convenience wrapper bound to a single input/textarea: inserts the picked token
// at the caret of `targetRef`, calls onChange(next), and restores focus + caret.
export function MergeFieldInserter({
  targetRef,
  value,
  onChange,
  groups,
  align = "right",
  label = "Insert field",
  className = "",
}) {
  const handlePick = (token) => {
    const el = targetRef?.current
    const { next, caret } = insertTokenAtCaret(el, value, token)
    onChange(next)
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        try { el.setSelectionRange(caret, caret) } catch { /* number/email inputs */ }
      }
    })
  }
  return <InsertFieldMenu groups={groups} onPick={handlePick} align={align} label={label} className={className} />
}
