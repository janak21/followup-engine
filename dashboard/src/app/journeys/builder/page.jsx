"use client"

import React, { useEffect, useState, Suspense, useRef, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import { 
  ArrowLeft, PhoneCall, MessageSquare, Mail, AlertCircle, Plus, Trash2,
  Save, Loader2, Clock, GitMerge, ChevronRight, HelpCircle, Sparkles, Check,
  Activity, Tag, Database, Sliders, Play, Pause, RefreshCw, Maximize2, Minimize2,
  X, AlertTriangle, Link2, Info, Code, FileText, Calendar, UserPlus, UserSearch, PieChart,
  Search, GitFork, Upload
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert } from "@/components/ui/alert"
import CustomSelect from "@/components/ui/custom-select"
import { useToast } from "@/components/ui/toast"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { usePrompt } from "@/components/ui/prompt-dialog"
import {
  STEP_TYPES,
  EVENT_WORKFLOW_PALETTE_ORDER,
  PALETTE_ORDER,
  defaultOutcomesFor,
  getJourneyExitDisplay,
  getJourneyNodeDisplay,
  getJourneyOutcomeDisplay,
  migrateOnOutcomes,
  outcomesForStep,
  templateChannelFor
} from "@/lib/journeyStepTypes"
import { CONDITION_FIELDS, getFieldConfig, newRule } from "@/lib/conditionFields"
import {
  getDeliveryStatusDisplay,
  getJourneyStatusDisplay,
  getStatusPillClass,
} from "@/lib/statusDisplay"
import { validateJourneySpec } from "@/lib/journeyValidation"
import { ensureStepSids, allocateStepIndex } from "@/lib/journeySpecIdentity"
import {
  LEAD_MAPPING_TARGETS,
  getDetectedPayloadFieldRows,
  flattenPayloadScalars,
  joinPayloadPath,
  mergeWorkflowFieldMapping,
  normalizeCustomKey,
  toWorkflowPayloadSource,
} from "@/lib/webhookPayloadMapping"

// Icon registry — maps schema's icon name strings to lucide components.
// Keep this in sync with imports above.
const START_TRIGGER_OPTIONS = [
  { value: "lead_enrolled", label: "Lead is enrolled" },
  { value: "webhook", label: "Webhook received" },
  { value: "lead_created", label: "Lead created" },
  { value: "tag_added", label: "Tag added" },
  { value: "incoming_sms", label: "SMS received" },
  { value: "email_replied", label: "Email replied" },
  { value: "lead_imported", label: "Lead added/imported", disabled: true, description: "Coming soon" },
  { value: "field_changed", label: "Field changed", disabled: true, description: "Coming soon" },
  { value: "reply_received", label: "Reply received", disabled: true, description: "Coming soon" },
  { value: "missed_call", label: "Missed call", disabled: true, description: "Coming soon" },
  { value: "appointment_booked", label: "Appointment booked", disabled: true, description: "Coming soon" },
]


// React Flow Imports
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  Handle,
  Position,
  getBezierPath,
  BaseEdge,
  EdgeLabelRenderer
} from "@xyflow/react"
import { EmailInlineComposer } from "./components/EmailInlineComposer"
import { ExecutionsTab } from "./components/ExecutionsTab"
import { SettingsTab } from "./components/SettingsTab"
import { useMergeFieldGroups, MergeFieldInserter } from "./components/MergeFields"
import { nodeTypes, edgeTypes } from "./components/canvasNodes"
import { AddStepPicker } from "./components/AddStepPicker"
import { insertStepAfter } from "./lib/insertStep"
import { computeLayout } from "./lib/autoLayout"
import {
  parseUrlQuery, setUrlQuery, getAuthFromHeaders, applyAuthToHeaders,
  lintJsonBody, clampTimeoutMs,
} from "./lib/httpRequestNode.ts"
import {
  WEBHOOK_ACTION_PALETTE_ORDER,
  getWebhookActionDisabledReason,
  paletteLabelFor,
  webhookHasLeadContext,
} from "./lib/palette"
import { renderTemplatePreview } from "@/lib/mergeFieldTokens"

// Custom Tag Autocomplete component with suggestion dropdown
function TagAutocomplete({ value, onChange, suggestions = [] }) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState(value || "")
  const containerRef = useRef(null)

  useEffect(() => {
    setQuery(value || "")
  }, [value])

  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const filtered = suggestions.filter(item => 
    item.toLowerCase().includes(query.toLowerCase())
  )

  const handleSelect = (item) => {
    onChange(item)
    setQuery(item)
    setIsOpen(false)
  }

  const handleInputChange = (e) => {
    const val = e.target.value
    setQuery(val)
    onChange(val)
    setIsOpen(true)
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <Input
        value={query}
        placeholder="Type or select a tag..."
        onChange={handleInputChange}
        onFocus={() => setIsOpen(true)}
        className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl w-full"
      />
      {isOpen && filtered.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-zinc-900 border border-black/10 dark:border-zinc-800 rounded-xl shadow-lg max-h-48 overflow-y-auto">
          {filtered.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => handleSelect(item)}
              className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 transition-colors first:rounded-t-xl last:rounded-b-xl"
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}



// Query-parameter editor for the HTTP node. The URL string is the single
// source of truth; rows whose key is still empty live in local state until
// they're named (otherwise they'd be dropped from the URL and vanish while
// the operator is typing).
function HttpQueryParamsEditor({ url, onUrlChange }) {
  const { base, params } = parseUrlQuery(url || "")
  const [pending, setPending] = useState([])
  const rows = [...params, ...pending]

  const commit = (nextParams) => onUrlChange(setUrlQuery(base, nextParams))

  const updateRow = (rowIndex, patch) => {
    if (rowIndex < params.length) {
      const next = params.map((row, i) => (i === rowIndex ? { ...row, ...patch } : row))
      const edited = next[rowIndex]
      if (String(edited.key).trim() === "") {
        // Key cleared: move the row out of the URL into pending so it stays editable.
        setPending((prev) => [...prev, edited])
        commit(next.filter((_, i) => i !== rowIndex))
      } else {
        commit(next)
      }
      return
    }
    const pendingIndex = rowIndex - params.length
    const nextPending = pending.map((row, i) => (i === pendingIndex ? { ...row, ...patch } : row))
    const edited = nextPending[pendingIndex]
    if (String(edited.key).trim() !== "") {
      // Named: promote into the URL.
      setPending(nextPending.filter((_, i) => i !== pendingIndex))
      commit([...params, edited])
    } else {
      setPending(nextPending)
    }
  }

  const removeRow = (rowIndex) => {
    if (rowIndex < params.length) commit(params.filter((_, i) => i !== rowIndex))
    else setPending(pending.filter((_, i) => i !== rowIndex - params.length))
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold text-zinc-500 uppercase flex justify-between items-center">
        <span>Query parameters</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPending((prev) => [...prev, { key: "", value: "" }])}
          className="h-6 px-2 text-[10px] rounded-lg border-black/10 dark:border-white/10 font-bold"
        >
          <Plus className="w-3 h-3 mr-0.5" /> Add Row
        </Button>
      </Label>
      {rows.length === 0 ? (
        <p className="text-[11px] text-zinc-500 italic text-center py-2 bg-black/5 dark:bg-white/5 rounded-xl border border-dashed border-black/10 dark:border-white/10">No query parameters.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((param, qi) => (
            <div key={qi} className="flex gap-1.5 items-center">
              <Input
                value={param.key}
                placeholder="key"
                onChange={(e) => updateRow(qi, { key: e.target.value })}
                className="flex-1 bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
              />
              <Input
                value={param.value}
                placeholder={"value or {{lead.email}}"}
                onChange={(e) => updateRow(qi, { value: e.target.value })}
                className="flex-1 bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeRow(qi)}
                aria-label="Remove query parameter"
                className="h-8 w-8 p-0 rounded-lg text-red-500 hover:bg-red-500/10 shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


function getWebhookSampleStatusDisplay(value) {
  const key = String(value || "").toLowerCase()
  if (key === "success") return { label: "Processed", variant: "success" }
  if (key === "processed") return { label: "Processed", variant: "success" }
  if (key === "queued") return { label: "Queued", variant: "neutral" }
  if (key === "failed") return { label: "Failed", variant: "danger" }
  if (key === "sample_captured_no_lead") return { label: "Captured, no lead matched", variant: "warning" }
  if (!key) return { label: "Captured", variant: "neutral" }
  return { label: humanizeBuilderLabel(key), variant: "danger" }
}

function humanizeBuilderLabel(value) {
  return String(value || "")
    .replace(/AI_REPLY/gi, "AI reply")
    .replace(/EXIT_FLOW/gi, "Journey ended")
    .replace(/team_alert/gi, "Team alert")
    .replace(/bounce_hard/gi, "Hard bounced")
    .replace(/opt_out/gi, "Opted out")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function SaveJourneyModal({ isOpen, onClose, validation, onSave, saving, onFocusStep }) {
  if (!isOpen) return null

  const statusConfig = {
    ready: {
      label: "Ready",
      message: "This journey passes all validation checks and is ready to be saved.",
      className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      icon: Check,
    },
    warning: {
      label: "Needs Review",
      message: "This journey can be saved, but please review the warnings before using it with leads.",
      className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      icon: AlertTriangle,
    },
    invalid: {
      label: "Invalid Spec",
      message: "Please fix the required errors before saving this journey.",
      className: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      icon: AlertCircle,
    },
  }[validation?.status] || {
    label: "Needs Review",
    message: "Please review readiness checks before saving.",
    className: "border-zinc-500/20 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
    icon: Info,
  }

  const StatusIcon = statusConfig.icon
  const issues = validation?.checks?.filter((check) => check.level !== "pass") || []
  const visibleChecks = issues.length > 0 ? issues : (validation?.checks || [])

  const isSaveDisabled = validation?.status === "invalid"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/5 shadow-2xl rounded-2xl w-full max-w-lg flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="p-5 border-b border-black/5 dark:border-white/5 flex items-center justify-between bg-zinc-50 dark:bg-black/20 shrink-0">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-zinc-400" />
            <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
              Save Journey & Readiness Check
            </h3>
          </div>
          <button 
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-zinc-500 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 max-h-[60vh]">
          {/* Status Alert Box */}
          <div className={`p-4 rounded-xl border flex items-start gap-3 ${statusConfig.className}`}>
            <StatusIcon className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-bold text-sm">{statusConfig.label}</h4>
              <p className="text-xs opacity-90 mt-1">{statusConfig.message}</p>
            </div>
          </div>

          {/* Checklist list */}
          <div className="space-y-2.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Readiness Checks</div>
            <div className="space-y-2">
              {visibleChecks.length === 0 ? (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 italic">No checklist items found.</div>
              ) : (
                visibleChecks.map((check, index) => {
                  const checkStyle = {
                    error: "border-rose-500/20 bg-rose-500/5 text-rose-700 dark:text-rose-300",
                    warning: "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300",
                    info: "border-blue-500/20 bg-blue-500/5 text-blue-700 dark:text-blue-300",
                    pass: "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
                  }[check.level] || "border-zinc-500/20 bg-zinc-500/5 text-zinc-700 dark:text-zinc-300"

                  const focusable = check.stepId !== null && check.stepId !== undefined && typeof onFocusStep === "function"
                  return focusable ? (
                    <button
                      key={`${check.level}-${check.title}-${index}`}
                      type="button"
                      onClick={() => onFocusStep(check.stepId)}
                      title="Open this step on the canvas"
                      className={`w-full text-left rounded-xl border p-3 transition-colors hover:brightness-95 dark:hover:brightness-110 ${checkStyle}`}
                    >
                      <div className="text-xs font-semibold">{check.title}</div>
                      <div className="text-[11px] opacity-80 mt-0.5">{check.message}</div>
                      <div className="text-[10px] opacity-70 mt-1 flex items-center gap-1">
                        Step: {check.stepLabel || `#${check.stepId}`}
                        <ChevronRight className="w-3 h-3" />
                        <span className="underline underline-offset-2">Open step</span>
                      </div>
                    </button>
                  ) : (
                    <div key={`${check.level}-${check.title}-${index}`} className={`rounded-xl border p-3 ${checkStyle}`}>
                      <div className="text-xs font-semibold">{check.title}</div>
                      <div className="text-[11px] opacity-80 mt-0.5">{check.message}</div>
                      {check.stepLabel && (
                        <div className="text-[10px] opacity-70 mt-1">Step: {check.stepLabel}</div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-black/5 dark:border-white/5 flex justify-end gap-3 bg-zinc-50 dark:bg-black/20 shrink-0">
          <Button 
            onClick={onClose}
            className="bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-semibold"
          >
            Cancel
          </Button>
          <Button 
            onClick={onSave}
            disabled={isSaveDisabled || saving}
            variant="default"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {isSaveDisabled ? "Cannot Save (Fix Errors)" : "Save Journey"}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// TypeableTimeInput
//   Free-form text input that accepts every reasonable way a user might
//   express a time-of-day and normalizes to canonical "HH:MM" on blur.
//
//   Accepts: "9", "9:00", "9:00 AM", "9 AM", "9am", "9pm", "21:00", "0900"
//   Stores:  "HH:MM" 24-hour (parseable by Postgres ::time directly).
//   Displays: friendly 12-hour form ("9:00 AM") when blurred, raw input while editing.
//
//   Why this exists: native <input type="time"> on Safari/Chrome forces the
//   step/spinner UI that's hostile to typing and has an invisible picker icon
//   in dark mode. Plain text + smart parser sidesteps both problems.
// ---------------------------------------------------------------
function parseTimeInput(raw) {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, " ")
  if (!s) return ""
  // "0900" → "09:00"
  let m = s.match(/^(\d{2})(\d{2})$/)
  if (m) {
    const h = parseInt(m[1], 10), mins = parseInt(m[2], 10)
    if (h < 0 || h > 23 || mins < 0 || mins > 59) return null
    return `${String(h).padStart(2, "0")}:${String(mins).padStart(2, "0")}`
  }
  // "9", "9:00", "9 am", "9:30am", "21:00"
  m = s.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const mins = m[2] ? parseInt(m[2], 10) : 0
  const ampm = m[3]
  if (ampm === "am") { if (h === 12) h = 0 }
  else if (ampm === "pm") { if (h !== 12) h += 12 }
  if (h < 0 || h > 23 || mins < 0 || mins > 59) return null
  return `${String(h).padStart(2, "0")}:${String(mins).padStart(2, "0")}`
}

function formatTimeDisplay(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return hhmm || ""
  const [h, m] = hhmm.split(":").map(Number)
  const ampm = h >= 12 ? "PM" : "AM"
  const h12 = ((h % 12) || 12)
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`
}

function TypeableTimeInput({ value, onChange, placeholder = "9:00 AM", className = "" }) {
  // Local text buffer so the user can type freely; we only commit on blur.
  const [text, setText] = useState(formatTimeDisplay(value))
  const [error, setError] = useState(false)
  // Re-sync if the upstream value changes (e.g. when switching nodes).
  useEffect(() => { setText(formatTimeDisplay(value)); setError(false) }, [value])

  const commit = () => {
    const parsed = parseTimeInput(text)
    if (parsed === null) { setError(true); return }
    setError(false)
    setText(formatTimeDisplay(parsed))
    if (parsed !== value) onChange(parsed)
  }

  return (
    <input
      type="text"
      inputMode="text"
      value={text}
      placeholder={placeholder}
      onChange={(e) => { setText(e.target.value); if (error) setError(false) }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur() } }}
      className={`h-9 px-3 rounded-xl text-sm bg-white dark:bg-black border outline-none focus:ring-1 focus:ring-blue-500/30 text-zinc-900 dark:text-white ${error ? "border-rose-500" : "border-black/10 dark:border-white/10"} ${className}`}
    />
  )
}

// ---------------------------------------------------------------
// Searchable field picker for Create/Update Lead nodes.
// Replaces a native <select> with a typeahead-style dropdown grouped by
// Standard / Custom. Click opens the panel, search filters live.
// ---------------------------------------------------------------
function SearchableFieldPicker({ value, options, customOptions = [], usedKeys, onChange, placeholder = "Pick a field" }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const containerRef = useRef(null)

  useEffect(() => {
    function handler(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
        setSearch("")
      }
    }
    if (open) document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const matches = (label) => label.toLowerCase().includes(search.trim().toLowerCase())
  const std = options.filter(o => matches(o.label))
  const cust = customOptions.filter(o => matches(o.label))
  const selected = [...options, ...customOptions].find(o => o.key === value)

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between hover:border-black/20 dark:hover:border-white/20"
      >
        <span className={selected ? "" : "text-zinc-400"}>{selected?.label || placeholder}</span>
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : "rotate-90"}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-xl shadow-xl">
          <div className="p-2 border-b border-black/5 dark:border-white/5 sticky top-0 bg-white dark:bg-surface-2">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full h-7 px-2 text-xs bg-transparent border border-black/10 dark:border-white/10 rounded-md focus:outline-none focus:border-blue-500/40 text-zinc-900 dark:text-white"
            />
          </div>
          {std.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-400">Standard fields</div>
              {std.map(o => {
                const disabled = o.key !== value && usedKeys?.has(o.key)
                return (
                  <button
                    key={o.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => { onChange(o.key); setOpen(false); setSearch("") }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between ${disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-zinc-100 dark:hover:bg-white/5"} ${o.key === value ? "text-blue-600 dark:text-blue-400" : "text-zinc-900 dark:text-white"}`}
                  >
                    <span>{o.label}</span>
                    {disabled && <span className="text-[10px] text-zinc-400">already used</span>}
                  </button>
                )
              })}
            </div>
          )}
          {cust.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-400">Custom fields</div>
              {cust.map(o => {
                const disabled = o.key !== value && usedKeys?.has(o.key)
                return (
                  <button
                    key={o.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => { onChange(o.key); setOpen(false); setSearch("") }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between ${disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-zinc-100 dark:hover:bg-white/5"} ${o.key === value ? "text-blue-600 dark:text-blue-400" : "text-zinc-900 dark:text-white"}`}
                  >
                    <span>{o.label}</span>
                    {disabled && <span className="text-[10px] text-zinc-400">already used</span>}
                  </button>
                )
              })}
            </div>
          )}
          {std.length === 0 && cust.length === 0 && (
            <div className="p-4 text-center text-xs text-zinc-400">No fields match "{search}"</div>
          )}
        </div>
      )}
    </div>
  )
}

// Value input that adapts to the field's type. Boolean fields render a Yes/No
// select, enum fields render their option list, everything else is free text
// (which still accepts merge tags).
// Renders a compact "Pick from sample" button + popover next to a free-text value
// input. The popover walks the most recent webhook sample's JSON tree (already
// captured into journey_webhook_samples). Clicking a leaf inserts
// {{raw_payload.dotted.path}} at the input's cursor position.
//
// Self-contained: takes the samples array as a prop and renders nothing if there
// are no samples. The merge-tag namespace is `raw_payload` for consistency with
// the placeholder hint shown elsewhere in the builder.
function SamplePathPicker({ samples, onPick }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])
  if (!samples || samples.length === 0) return null

  // Most recent sample first (samples API already orders desc by received_at).
  const sample = samples[0]
  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
      >
        Pick from sample ↗
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-[360px] max-h-[320px] overflow-auto bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-xl shadow-2xl p-2">
          <div className="text-[10px] text-zinc-400 uppercase font-semibold mb-1.5">
            Click a leaf to insert <code className="font-mono">{`{{raw_payload.path}}`}</code>
          </div>
          <JsonExplorer
            value={sample.payload}
            onAssign={(_targetKey, path) => {
              // We don't care about the "variable name" half of the existing onAssign
              // contract — we just want the path. Insert as a raw_payload merge tag.
              onPick?.(`{{raw_payload.${path}}}`)
              setOpen(false)
            }}
            variables={[{ key: "raw_payload" }]}
          />
        </div>
      )}
    </div>
  )
}

function FieldValueInput({ fieldKey, value, onChange, customFieldsSchema, samples }) {
  const className = "w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white"
  // Standard bool fields
  if (["responded", "opt_out", "callback_requested"].includes(fieldKey)) {
    return (
      <CustomSelect
        value={value || ""}
        onChange={onChange}
        options={[
          { value: "", label: "— pick —" },
          { value: "true", label: `Yes (${fieldKey === "opt_out" ? "opted out" : fieldKey === "callback_requested" ? "callback requested" : "responded"})` },
          { value: "false", label: "No" }
        ]}
        triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
      />
    )
  }
  if (fieldKey === "journey_status") {
    return (
      <CustomSelect
        value={value || ""}
        onChange={onChange}
        options={[
          { value: "", label: "— pick —" },
          ...["new","active","paused","responded","callback_booked","opted_out","completed","error"].map(s => ({
            value: s,
            label: getJourneyStatusDisplay(s).label,
          }))
        ]}
        triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
      />
    )
  }
  // Custom field with declared type
  const cf = (customFieldsSchema || []).find(f => `custom.${f.key}` === fieldKey)
  if (cf?.type === "boolean") {
    return (
      <CustomSelect
        value={value || ""}
        onChange={onChange}
        options={[
          { value: "", label: "— pick —" },
          { value: "true", label: "Yes" },
          { value: "false", label: "No" }
        ]}
        triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
      />
    )
  }
  if (cf?.type === "dropdown" || cf?.type === "radio") {
    return (
      <CustomSelect
        value={value || ""}
        onChange={onChange}
        options={[
          { value: "", label: "— pick —" },
          ...(cf.options || []).map(o => ({ value: o, label: o }))
        ]}
        triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
      />
    )
  }
  // Default: free text with merge-tag hint + optional sample picker.
  // The sample picker only renders when the builder has captured webhook
  // samples for this journey (which is the result-journey use case).
  return (
    <div className="space-y-1">
      <input
        type="text"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Value or {{merge.tag}}"
        className={className}
      />
      {samples && samples.length > 0 && (
        <div className="flex justify-end">
          <SamplePathPicker
            samples={samples}
            onPick={(token) => onChange(((value || "") + token))}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------
// JsonExplorer — recursive renderer for arbitrary JSON.
// Every leaf gets an "Assign →" affordance so the operator can map a payload
// path to a lead field without writing JSONPath by hand. Path is dot-notation
// with [index] for arrays (e.g. data.fields[3].value).
// ---------------------------------------------------------------
function JsonExplorer({ value, path = "", onAssign, onLeadMapping, variables = [], depth = 0 }) {
  const t = Array.isArray(value) ? "array" : typeof value
  const indent = { paddingLeft: depth * 12 }

  if (value === null) {
    return <Leaf style={indent} path={path} display="null" type="null" onAssign={onAssign} onLeadMapping={onLeadMapping} variables={variables} />
  }
  if (t === "string" || t === "number" || t === "boolean") {
    return <Leaf style={indent} path={path} display={JSON.stringify(value)} type={t} onAssign={onAssign} onLeadMapping={onLeadMapping} variables={variables} />
  }
  if (t === "array") {
    return (
      <div style={indent}>
        <div className="text-[10px] text-zinc-500 font-mono">[{value.length}]</div>
        {value.map((v, i) => (
          <div key={i}>
            <div className="text-[10px] text-zinc-400 font-mono">{`[${i}]`}</div>
            <JsonExplorer
              value={v}
              path={joinPayloadPath(path, i, true)}
              onAssign={onAssign}
              onLeadMapping={onLeadMapping}
              variables={variables}
              depth={depth + 1}
            />
          </div>
        ))}
      </div>
    )
  }
  if (t === "object") {
    const keys = Object.keys(value)
    return (
      <div style={indent}>
        {keys.length === 0 && <span className="text-[10px] text-zinc-400">{"{}"}</span>}
        {keys.map(k => (
          <details key={k} open={depth < 1} className="my-0.5">
            <summary className="cursor-pointer text-[11px] text-zinc-700 dark:text-zinc-300 font-mono hover:text-blue-600 dark:hover:text-blue-400">
              {k}
            </summary>
            <JsonExplorer
              value={value[k]}
              path={joinPayloadPath(path, k, false)}
              onAssign={onAssign}
              onLeadMapping={onLeadMapping}
              variables={variables}
              depth={depth + 1}
            />
          </details>
        ))}
      </div>
    )
  }
  return null
}

function Leaf({ style, path, display, type, onAssign, onLeadMapping, variables = [] }) {
  const prompt = usePrompt()
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const payloadSource = toWorkflowPayloadSource(path)

  useEffect(() => {
    function handler(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const colors = {
    string: "text-emerald-700 dark:text-emerald-400",
    number: "text-amber-700 dark:text-amber-400",
    boolean: "text-purple-700 dark:text-purple-400",
    null:    "text-zinc-500",
  }
  return (
    <div ref={containerRef} style={style} className="flex items-center gap-2 py-0.5 group relative">
      <span className={`font-mono text-[11px] truncate ${colors[type] || "text-zinc-800 dark:text-white"}`}>{display}</span>
      <span className="text-[10px] text-zinc-400 font-mono opacity-0 group-hover:opacity-100 truncate">{path}</span>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="ml-auto text-[10px] text-blue-600 dark:text-blue-400 hover:underline opacity-0 group-hover:opacity-100"
      >Assign →</button>
      {open && (
        <div className="absolute right-6 mt-1 z-50 bg-white dark:bg-surface-2 border border-black/10 dark:border-white/10 rounded-xl shadow-xl p-2 space-y-1 min-w-[140px]">
          <div className="px-2 py-1 text-[10px] text-zinc-400 uppercase font-semibold">Map payload value</div>
          <div className="px-2 pb-1 text-[10px] text-zinc-500 font-mono break-all">{payloadSource}</div>
          {onLeadMapping && (
            <>
              <select
                defaultValue=""
                onChange={async (event) => {
                  const destination = event.target.value
                  event.target.value = ""
                  if (!destination) return
                  if (destination === "custom") {
                    const key = (await prompt({ title: "Custom field key", placeholder: "e.g. company_size" }))?.trim()
                    if (key) onLeadMapping(`custom.${normalizeCustomKey(key)}`, payloadSource)
                  } else if (destination === "variable") {
                    const key = (await prompt({ title: "Journey variable name" }))?.trim()
                    if (key) onAssign?.(normalizeCustomKey(key), path)
                  } else {
                    onLeadMapping(destination, payloadSource)
                  }
                  setOpen(false)
                }}
                className="w-full h-8 rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-black px-2 text-xs text-zinc-800 dark:text-zinc-100"
              >
                <option value="">Map to...</option>
                {LEAD_MAPPING_TARGETS.map((target) => (
                  <option key={target.value} value={target.value}>{target.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(payloadSource)
                  setOpen(false)
                }}
                className="block w-full text-left text-xs px-2 py-1.5 rounded hover:bg-zinc-100 dark:hover:bg-white/5 text-zinc-800 dark:text-zinc-100"
              >Copy path</button>
              <div className="border-t border-black/5 dark:border-white/5 my-1" />
            </>
          )}
          <div className="px-2 py-1 text-[10px] text-zinc-400 uppercase font-semibold">Journey variable</div>
          {variables.map(v => (
            <button
              key={v.key}
              type="button"
              onClick={() => { onAssign?.(v.key, path); setOpen(false) }}
              className="block w-full text-left text-xs px-2 py-1.5 rounded hover:bg-zinc-100 dark:hover:bg-white/5 text-zinc-800 dark:text-zinc-100"
            >Map to <span className="font-mono font-semibold">{v.key}</span></button>
          ))}
          <div className="border-t border-black/5 dark:border-white/5 my-1" />
          <button
            type="button"
            onClick={async () => {
              const nameInput = (await prompt({ title: "Create variable", message: "Enter new variable name:" }))?.trim()
              if (nameInput) {
                const safeName = nameInput.toLowerCase().replace(/[^a-z0-9_]/g, "_")
                onAssign?.(safeName, path)
              }
              setOpen(false)
            }}
            className="block w-full text-left text-xs px-2 py-1.5 rounded hover:bg-zinc-100 dark:hover:bg-white/5 text-blue-600 dark:text-blue-400 font-semibold"
          >+ Create variable...</button>
        </div>
      )}
    </div>
  )
}

function formatSampleValue(value) {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function DetectedPayloadFieldsMapper({ sample, onLeadMapping, onAssign, createLeadAvailable = true }) {
  const prompt = usePrompt()
  const rows = getDetectedPayloadFieldRows(sample?.payload)
  const [selected, setSelected] = useState({})

  useEffect(() => {
    setSelected(Object.fromEntries(rows.map((row) => [row.source, row.suggestedDestination])))
  }, [sample?.id])

  if (rows.length === 0) return null

  const handleMap = async (row, destination) => {
    if (!destination) return
    if (destination === "custom") {
      const key = (await prompt({ title: "Custom field key", defaultValue: normalizeCustomKey(row.label) }))?.trim()
      if (key) onLeadMapping?.(`custom.${normalizeCustomKey(key)}`, row.source)
      return
    }
    if (destination === "variable") {
      const key = (await prompt({ title: "Journey variable name", defaultValue: normalizeCustomKey(row.label) }))?.trim()
      if (key) onAssign?.(normalizeCustomKey(key), row.path)
      return
    }
    onLeadMapping?.(destination, row.source)
  }

  const selectedDestination = (row) => selected[row.source] || row.suggestedDestination
  const applySelectedMappings = () => {
    rows.forEach((row) => handleMap(row, selectedDestination(row)))
  }

  return (
    <div className="bg-blue-500/[0.04] rounded-xl p-4 border border-blue-500/15 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold text-blue-600 dark:text-blue-300 uppercase tracking-wider">Detected payload fields</div>
          <p className="text-[11px] text-zinc-500 mt-1">
            Use webhook values as automation inputs. Fields mapped to the lead become insertable in Send SMS / Email steps via <span className="font-semibold">Insert field → Webhook data</span>.
          </p>
        </div>
        {createLeadAvailable ? (
          <button
            type="button"
            onClick={applySelectedMappings}
            className="shrink-0 text-[11px] px-3 py-1.5 rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-semibold"
          >
            Apply to Create Lead
          </button>
        ) : (
          <p className="shrink-0 max-w-[45%] text-[10px] text-zinc-400 text-right">
            The webhook trigger does not require Create Lead — add one to map these fields onto a lead.
          </p>
        )}
      </div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.source} className="space-y-1.5 text-xs bg-white/70 dark:bg-black/20 border border-black/5 dark:border-white/5 rounded-xl p-2">
            <div className="flex items-baseline justify-between gap-2 min-w-0">
              <div className="min-w-0">
                <span className="font-semibold text-zinc-800 dark:text-zinc-100">{row.label}</span>
                <span className="font-mono text-[10px] text-zinc-400 ml-2">{row.source}</span>
              </div>
              <div className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300 truncate max-w-[45%] shrink-0" title={String(row.value ?? "")}>
                {formatSampleValue(row.value)}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
            <select
              value={selectedDestination(row)}
              disabled={!createLeadAvailable}
              onChange={(event) => {
                const destination = event.target.value
                setSelected((prev) => ({ ...prev, [row.source]: destination }))
              }}
              className="h-8 flex-1 min-w-[140px] rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-black px-2 text-xs text-zinc-800 dark:text-zinc-100"
            >
              {selectedDestination(row)?.startsWith("custom.") && (
                <option value={selectedDestination(row)}>Custom: {selectedDestination(row).slice(7)}</option>
              )}
              {LEAD_MAPPING_TARGETS.map((target) => (
                <option key={target.value} value={target.value}>{target.label}</option>
              ))}
            </select>
            <div className="flex gap-1 shrink-0">
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(row.source)}
                className="h-8 px-2 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => handleMap(row, "variable")}
                className="h-8 px-2 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5"
              >
                Variable
              </button>
              {createLeadAvailable && (
                <button
                  type="button"
                  onClick={() => handleMap(row, selectedDestination(row))}
                  className="h-8 px-2 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-500/10"
                >
                  Apply
                </button>
              )}
            </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// SamplesPanel — renders the most recent webhook samples with status badges,
// simplified list layout that delegates JSON inspection to a widescreen modal.
// ---------------------------------------------------------------
function SamplesPanel({ samples, loading, onInspect, onRefresh, pinnedSampleId, onPin, onViewExecution, onClear }) {
  return (
    <div className="space-y-2 pt-2 border-t border-black/5 dark:border-white/10">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold text-zinc-500 uppercase">Recent webhook samples</Label>
        <div className="flex items-center gap-3">
          {onClear && samples.length > 0 && (
            <button type="button" onClick={onClear} className="text-[10px] text-zinc-500 hover:text-rose-500">
              Clear
            </button>
          )}
          <button type="button" onClick={onRefresh} className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline">
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
      {samples.length === 0 && !loading && (
        <p className="text-[10px] italic text-zinc-400 bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/10 rounded-xl p-2 text-center">
          No samples yet. Submit through your form once and they'll show up here.
        </p>
      )}
      <ul className="space-y-1 max-h-64 overflow-y-auto pr-1">
        {samples.map(s => {
          const statusDisplay = getWebhookSampleStatusDisplay(s.result_status)
          const statusColor = {
            success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            danger: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
            neutral: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
          }[statusDisplay.variant]
          return (
            <li key={s.id} className="border border-black/5 dark:border-white/10 rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => onInspect(s)}
                className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-zinc-50 dark:hover:bg-white/[0.03]"
              >
                <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${statusColor}`}>
                  {statusDisplay.label}
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">{new Date(s.received_at).toLocaleString()}</span>
                {pinnedSampleId === s.id && (
                  <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-300">
                    Pinned
                  </span>
                )}
                <span className="text-[10px] text-zinc-400 truncate flex-1">{s.result_message || s.result_reason || ""}</span>
                {onViewExecution && (s.result_run_id || s.result_lead_id) && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => { event.stopPropagation(); onViewExecution(s) }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault(); event.stopPropagation(); onViewExecution(s)
                      }
                    }}
                    className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold hover:underline whitespace-nowrap"
                    title="Open the execution this request started"
                  >View run</span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation()
                    onPin?.(s.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      event.stopPropagation()
                      onPin?.(s.id)
                    }
                  }}
                  className="text-[10px] text-blue-600 dark:text-blue-300 font-semibold hover:underline"
                >
                  {pinnedSampleId === s.id ? "Pinned" : "Pin"}
                </span>
                <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------
// SampleInspectorModal — Centered widescreen modal popup to inspect
// a webhook sample payload JSON tree and assign values to fields.
// ---------------------------------------------------------------
function SampleInspectorModal({ sample, onClose, onAssign, onLeadMapping, onReplay, variables = [], createLeadAvailable = false, hasUnsavedChanges = false, pinnedSampleId = null, onPin, onViewExecution }) {
  const { pushToast } = useToast()
  const [replayResult, setReplayResult] = useState(null)
  if (!sample) return null
  const statusDisplay = getWebhookSampleStatusDisplay(sample.result_status)
  const statusColor = {
    success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    danger: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
    neutral: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  }[statusDisplay.variant]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      {/* Re-run result JSON viewer — read-only, replaces the old native alert() */}
      {replayResult !== null && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setReplayResult(null)}
          />
          <div className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-surface-1 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-black/5 dark:border-white/5 shrink-0">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Re-run result</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(JSON.stringify(replayResult, null, 2))
                    pushToast("success", "Copied JSON to clipboard")
                  }}
                  className="text-[11px] px-2.5 py-1 rounded-lg font-semibold border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => setReplayResult(null)}
                  aria-label="Close result viewer"
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-[11px] leading-relaxed font-mono text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap break-words">
              {JSON.stringify(replayResult, null, 2)}
            </pre>
          </div>
        </div>
      )}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/5 shadow-2xl rounded-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="p-5 border-b border-black/5 dark:border-white/5 flex items-center justify-between bg-zinc-50 dark:bg-black/20 shrink-0">
          <div className="flex items-center gap-3">
            <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded ${statusColor}`}>
              {statusDisplay.label}
            </span>
            <div>
              <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                Webhook Sample Details
              </h3>
              <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                Received: {new Date(sample.received_at).toLocaleString()}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-zinc-500 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Status info bar */}
          <div className="flex items-center justify-between gap-4 p-3 bg-zinc-50 dark:bg-black/20 rounded-xl border border-black/5 dark:border-white/5">
            <div className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
              {sample.result_message || sample.result_reason || "Sample successfully captured."}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {onViewExecution && (sample.result_run_id || sample.result_lead_id) && (
                <button
                  type="button"
                  onClick={() => onViewExecution(sample)}
                  className="text-[11px] px-3 py-1.5 rounded-xl font-semibold border border-emerald-500/25 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                  title="Open the execution this request started"
                >
                  View execution
                </button>
              )}
              <button
                type="button"
                onClick={() => onPin?.(sample.id)}
                className="text-[11px] px-3 py-1.5 rounded-xl font-semibold border border-blue-500/20 text-blue-600 dark:text-blue-300 hover:bg-blue-500/10"
              >
                {pinnedSampleId === sample.id ? "Pinned sample" : "Pin sample"}
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (hasUnsavedChanges) {
                    pushToast("error", "Save the automation before re-running this sample. Re-run uses the saved workflow, not unsaved draft changes.")
                    return
                  }
                  const j = await onReplay(sample.id)
                  setReplayResult(j?.data ?? j ?? {})
                }}
                className={`text-[11px] px-3 py-1.5 rounded-xl font-semibold transition-colors ${
                  hasUnsavedChanges
                    ? "bg-amber-500 text-white hover:bg-amber-600"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                {hasUnsavedChanges ? "Save before re-run" : "Re-run through engine"}
              </button>
              {sample.result_lead_id && (
                <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium bg-emerald-500/10 px-2.5 py-1.5 rounded-lg border border-emerald-500/20">
                  Lead: {String(sample.result_lead_id).slice(0, 8)}…
                </span>
              )}
            </div>
          </div>

          {(sample.result_run_id || sample.result_workflow_action_id || sample.result_details) && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">
              {sample.result_run_id && (
                <div className="bg-zinc-50 dark:bg-black/20 rounded-lg border border-black/5 dark:border-white/5 p-2">
                  <div className="text-zinc-400 uppercase font-semibold">Run ID</div>
                  <div className="font-mono text-zinc-700 dark:text-zinc-200 break-all">{sample.result_run_id}</div>
                </div>
              )}
              {sample.result_workflow_action_id && (
                <div className="bg-zinc-50 dark:bg-black/20 rounded-lg border border-black/5 dark:border-white/5 p-2">
                  <div className="text-zinc-400 uppercase font-semibold">Workflow Action</div>
                  <div className="font-mono text-zinc-700 dark:text-zinc-200 break-all">{sample.result_workflow_action_id}</div>
                </div>
              )}
              {sample.result_details?.outcome && (
                <div className="bg-zinc-50 dark:bg-black/20 rounded-lg border border-black/5 dark:border-white/5 p-2">
                  <div className="text-zinc-400 uppercase font-semibold">Outcome</div>
                  <div className="font-semibold text-zinc-700 dark:text-zinc-200">{sample.result_details.outcome}</div>
                </div>
              )}
            </div>
          )}

          <DetectedPayloadFieldsMapper
            sample={sample}
            onLeadMapping={onLeadMapping}
            onAssign={onAssign}
            createLeadAvailable={createLeadAvailable}
          />

          {/* JSON Explorer Card with relative positioning (for dropdown anchor) */}
          <div className="relative bg-zinc-50 dark:bg-surface-1 rounded-xl p-4 border border-black/5 dark:border-white/10 min-h-[300px]">
            <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Payload Explorer</div>
            <JsonExplorer value={sample.payload} onAssign={onAssign} onLeadMapping={onLeadMapping} variables={variables} />
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-black/5 dark:border-white/5 bg-zinc-50 dark:bg-black/20 flex justify-end shrink-0">
          <Button
            onClick={onClose}
            variant="default"
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// ExecutionsDrawer — right-side slide-over showing recent leads enrolled
// into this journey and their action chain (status, run_at, errors).
// Closes the "did anything actually happen?" debug gap.
// ---------------------------------------------------------------
// FunnelDrawer — per-step reach counts + median time-to-next-step.
// Renders as horizontal step cards with a thin progress bar relative to the
// top step's reach count so drop-off is visible at a glance.
function fmtSeconds(s) {
  if (s == null) return "—"
  s = Math.round(Number(s))
  if (!Number.isFinite(s) || s <= 0) return "—"
  if (s < 60)        return `${s}s`
  if (s < 3600)      return `${Math.round(s/60)}m`
  if (s < 86400)     return `${(s/3600).toFixed(1)}h`
  return `${(s/86400).toFixed(1)}d`
}

function FunnelDrawer({ open, loading, funnel, onClose, onRefresh }) {
  if (!open) return null
  const steps = funnel?.steps || []
  const max = Math.max(1, ...steps.map(s => s.reached_count || 0))
  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[520px] max-w-[90vw] bg-white dark:bg-surface-1 border-l border-black/10 dark:border-white/10 shadow-2xl flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-black/5 dark:border-white/10">
        <div>
          <h3 className="text-sm font-bold text-zinc-900 dark:text-white">Funnel</h3>
          <p className="text-[10px] text-zinc-500">
	            Reached lead counts per step + median time from previous step{funnel?.total_leads !== undefined ? ` • ${funnel.total_leads} current leads` : ""}.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onRefresh} className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-white/5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white" title="Refresh"
 aria-label="Refresh funnel">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-white/5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white" title="Close"
 aria-label="Close funnel drawer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading && steps.length === 0 && (
          <div className="flex items-center justify-center py-12 text-zinc-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
        )}
        {!loading && steps.length === 0 && (
          <p className="text-xs text-zinc-400 italic text-center py-10">Save the journey first or wait for leads to enroll.</p>
        )}
        {steps.map((s, i) => {
          const pct = max ? Math.round((s.reached_count || 0) / max * 100) : 0
          const dropoff = i > 0 && (steps[i-1].reached_count || 0) > 0
            ? Math.round((1 - (s.reached_count || 0) / steps[i-1].reached_count) * 100)
            : null
          return (
            <div key={s.step_index} className="border border-black/5 dark:border-white/10 rounded-xl p-3 bg-white dark:bg-surface-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] text-zinc-400 font-mono">#{s.step_index}</span>
                <span className="text-xs font-semibold text-zinc-900 dark:text-white truncate">{s.label}</span>
                <span className="text-[10px] text-zinc-400 font-mono">{s.type}</span>
                <span className="ml-auto text-base font-bold text-zinc-900 dark:text-white">{s.reached_count}</span>
              </div>
              {/* Reach bar */}
              <div className="mt-2 h-1.5 rounded-full bg-zinc-100 dark:bg-white/5 overflow-hidden">
                <div className="h-full bg-blue-500/80 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-500">
                <div className="flex items-center gap-3">
                  {s.completed_count > 0 && <span className="text-emerald-600 dark:text-emerald-400">✓ {s.completed_count}</span>}
                  {s.pending_count   > 0 && <span className="text-amber-600 dark:text-amber-400">⧖ {s.pending_count}</span>}
                  {s.failed_count    > 0 && <span className="text-rose-600 dark:text-rose-400">✗ {s.failed_count}</span>}
                  {s.cancelled_count > 0 && <span className="text-zinc-500">∅ {s.cancelled_count}</span>}
                </div>
                <div className="flex items-center gap-3">
                  <span>median: {fmtSeconds(s.median_seconds_from_prev)}</span>
                  {dropoff !== null && dropoff > 0 && (
                    <span className="text-rose-600 dark:text-rose-400">−{dropoff}%</span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}


function JourneyBuilderContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { pushToast } = useToast()
  const confirm = useConfirm()
  const [journeyId, setJourneyId] = useState(searchParams.get("id"))
  const [lastSaved, setLastSaved] = useState(null)
  const justSavedRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState("")
  const [successMsg, setSuccessMsg] = useState("")
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false)
  const [hasDraft, setHasDraft] = useState(false)
  const [publishing, setPublishing] = useState(false)

  // Journey metadata
  const [name, setName] = useState("")
  const [journeyKey, setJourneyKey] = useState("")
  const [active, setActive] = useState(true)
  const [stopOnReply, setStopOnReply] = useState("stop")
  const [goals, setGoals] = useState([])
  // Per-journey AI agent override. null = use tenant default. A UUID = pin
  // a specific agent (e.g. "Speed-to-Lead", "Reactivation") to this journey.
  // Loaded from journeys.ai_agent_id, saved via the /api/journeys PUT body.
  const [aiAgentId, setAiAgentId] = useState(null)
  // Agents list for the picker. Loaded once on mount; enabled filter applied
  // in the render (disabled agents shown greyed with a warning).
  const [aiAgentsList, setAiAgentsList] = useState([])
  const [journeyMode, setJourneyMode] = useState("lead_journey")
  const [triggerType, setTriggerType] = useState("lead_enrolled") // lead_enrolled, webhook, tag_added
  const [triggerConfig, setTriggerConfig] = useState({ webhook_url: "", tag: "", form_id: "", keywords: "", subject_filter: "" })
  // Webhook trigger state
  const [webhookInfo, setWebhookInfo] = useState(null) // { webhook_token, webhook_url, samples, webhook_auth_mode, webhook_secret }
  const [webhookLoading, setWebhookLoading] = useState(false)
  // Webhook samples + executions — fetched on demand when user opens the trigger
  // or executions panel. Replaces the "submit a form, then ask Claude what
  // happened" loop with in-app visibility.
  const [samples, setSamples] = useState([])
  const [pinnedSampleId, setPinnedSampleId] = useState(null)
  const [samplesLoading, setSamplesLoading] = useState(false)
  const [inspectedSample, setInspectedSample] = useState(null)

  // n8n-style "listen for test data": poll samples until a new one arrives.
  const [listeningForSample, setListeningForSample] = useState(false)
  const [justReceivedSample, setJustReceivedSample] = useState(false)
  const listenBaselineRef = useRef(null)

  const startListeningForSample = async () => {
    setJustReceivedSample(false)
    const current = await refreshSamples()
    listenBaselineRef.current = current?.[0]?.id ?? null
    setListeningForSample(true)
  }
  const stopListeningForSample = () => setListeningForSample(false)

  useEffect(() => {
    if (!listeningForSample) return
    const startedAt = Date.now()
    const tick = async () => {
      const list = await refreshSamples()
      const newest = list?.[0]?.id ?? null
      if (newest && newest !== listenBaselineRef.current) {
        setListeningForSample(false)
        setJustReceivedSample(true)
        setTimeout(() => setJustReceivedSample(false), 6000)
        return
      }
      // Give up after 3 minutes so we don't poll forever on an abandoned tab.
      if (Date.now() - startedAt > 180_000) setListeningForSample(false)
    }
    const id = setInterval(tick, 3000)
    return () => clearInterval(id)
  }, [listeningForSample])

  // Save a webhook payload path as a journey variable (used by the inline
  // field mapper and the full sample inspector).
  const assignVariablePath = (targetKey, path) => {
    setHasUnsavedChanges(true)
    setVariables(prev => {
      const idx = prev.findIndex(v => v.key === targetKey)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], path }
        return next
      }
      return [...prev, { key: targetKey, path, isStandard: false }]
    })
  }

  // "Did this webhook run anything?" — jump from a sample to the execution
  // it started (samples carry result_run_id / result_lead_id).
  const handleViewSampleExecution = async (sample) => {
    if (!sample?.result_lead_id && !sample?.result_run_id) return
    setInspectedSample(null)
    setIsDrawerOpen(false)
    setActiveTab("executions")
    const list = await refreshExecutions()
    const match = (list || []).find(e =>
      (sample.result_lead_id && e.lead?.id === sample.result_lead_id) ||
      (sample.result_run_id && (e.actions || []).some(a => a.run_id === sample.result_run_id))
    )
    if (match) {
      setSelectedExecution(match)
    } else {
      pushToast("info", "No matching execution found for this sample yet — it may still be processing.")
    }
  }
  const [executions, setExecutions] = useState([])
  const [executionsLoading, setExecutionsLoading] = useState(false)
  const [executionsSearch, setExecutionsSearch] = useState("")

  const filteredExecutions = (executions || []).filter(e => {
    const query = executionsSearch.toLowerCase().trim()
    if (!query) return true
    const leadName = (e.lead.name || "").toLowerCase()
    const leadEmail = (e.lead.email || "").toLowerCase()
    const leadPhone = (e.lead.phone || "").toLowerCase()
    return leadName.includes(query) || leadEmail.includes(query) || leadPhone.includes(query)
  })
  const pinnedSample = samples.find((sample) => sample.id === pinnedSampleId) || samples[0] || null
  const [funnel, setFunnel] = useState(null)
  const [funnelLoading, setFunnelLoading] = useState(false)
  const [showFunnel, setShowFunnel] = useState(false)
  const refreshFunnel = async () => {
    if (!journeyId) return
    setFunnelLoading(true)
    try {
      const res = await fetch(`/api/journeys/${journeyId}/funnel`)
      const json = await res.json()
      if (res.ok) setFunnel(json.data)
    } catch {} finally { setFunnelLoading(false) }
  }

  const refreshSamples = async () => {
    if (!journeyId) return
    setSamplesLoading(true)
    try {
      const res = await fetch(`/api/journeys/${journeyId}/samples`)
      const json = await res.json()
      if (res.ok) {
        const nextSamples = json.data?.samples || []
        setSamples(nextSamples)
        return nextSamples
      }
    } catch {}
    finally { setSamplesLoading(false) }
    return []
  }
  const refreshExecutions = async () => {
    if (!journeyId) return
    setExecutionsLoading(true)
    try {
      const res = await fetch(`/api/journeys/${journeyId}/executions`)
      const json = await res.json()
      if (res.ok) {
        const list = json.data?.executions || []
        setExecutions(list)
        return list
      }
    } catch {}
    finally { setExecutionsLoading(false) }
    return []
  }
  const replaySample = async (sampleId) => {
    const res = await fetch(`/api/journeys/${journeyId}/samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample_id: sampleId }),
    })
    const json = await res.json()
    const nextSamples = await refreshSamples()
    await refreshExecutions()
    const replayedSampleId = json?.data?.sample_id
    if (replayedSampleId) {
      const nextSample = nextSamples.find((sample) => sample.id === replayedSampleId)
      if (nextSample) setInspectedSample(nextSample)
    }
    return json
  }

  const [variables, setVariables] = useState([
    { key: "first_name", path: "first_name", isStandard: true },
    { key: "last_name",  path: "last_name",  isStandard: true },
    { key: "email",      path: "email",      isStandard: true },
    { key: "phone",      path: "phone",      isStandard: true }
  ])
  const [showSecret, setShowSecret] = useState(false)
  const [steps, setSteps] = useState([])
  const stepsRef = useRef([])
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  
  // Trigger absolute node pos and connection
  const [triggerPos, setTriggerPos] = useState({ x: 250, y: 50 })
  const [triggerNextStep, setTriggerNextStep] = useState(null)

  // React Flow State variables
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const handleEdgeDeleteRef = useRef(null)
  // Capture the React Flow instance so we can call fitView() AFTER nodes are
  // loaded from the server — otherwise the canvas opens at default viewport
  // and saved nodes can sit off-screen, looking empty.
  const reactFlowInstanceRef = useRef(null)

  const getCurrentSteps = () => (
    Array.isArray(stepsRef.current) && stepsRef.current.length > 0
      ? stepsRef.current
      : steps
  )

  const replaceStepsState = (nextSteps, dirty = true) => {
    stepsRef.current = nextSteps
    setSteps(nextSteps)
    if (dirty) setHasUnsavedChanges(true)
  }

  // UI state
  const [activeTab, setActiveTab] = useState("builder") // builder, settings, logs
  const [selectedExecution, setSelectedExecution] = useState(null)

  // HTTP Request test state
  const [testingHttp, setTestingHttp] = useState(false)
  // Auth-type the operator picked in the HTTP node before entering credentials;
  // once credentials exist the Authorization header is the source of truth.
  const [httpAuthTypeDraft, setHttpAuthTypeDraft] = useState(null)
  const [sendingInlineTest, setSendingInlineTest] = useState(false)
  const [testResponse, setTestResponse] = useState(null) // null, or { status, headers, body, durationMs, error }

  // Drawer states
  const [selectedNode, setSelectedNode] = useState(null) // null, 'trigger', or { type: 'step', index }

  // Auto-fetch samples whenever the user focuses the trigger node.
  useEffect(() => {
    if (selectedNode?.type === "trigger" && journeyId) refreshSamples()
  }, [selectedNode?.type, journeyId])
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [linkingNodeIndex, setLinkingNodeIndex] = useState(null) // Node index currently in link targeting mode

  // Guided "+" flow: which (source, outcome) the user is adding a step after.
  // Non-null opens the AddStepPicker; picking a type inserts + wires the step.
  const [addStepTarget, setAddStepTarget] = useState(null) // null | { sourceNodeId, outcomeKey }

  const handleAddStepPick = (newType) => {
    if (!addStepTarget) return
    const { sourceNodeId, outcomeKey } = addStepTarget
    const { steps: nextSteps, triggerNextStep: nextTrig } = insertStepAfter({
      steps: getCurrentSteps(),
      triggerNextStep,
      sourceNodeId,
      outcomeKey,
      newType,
      templates,
    })
    // Drop the new step directly beneath its source so the wire reads
    // top-to-bottom instead of landing at the generic palette position.
    const sourceNode = nodes.find(n => n.id === String(sourceNodeId))
    if (sourceNode) {
      const inserted = nextSteps[nextSteps.length - 1]
      // Fan out under the source: offset x toward the outcome's handle so
      // branches from different outcomes don't stack on the same spot.
      let xOffset = 0
      if (sourceNodeId !== "trigger") {
        const sourceStep = nextSteps.find(st => String(st.index) === String(sourceNodeId))
        const outcomeIds = Object.keys(sourceStep?.on_outcome || {})
        const idx = outcomeIds.indexOf(outcomeKey)
        if (idx >= 0 && outcomeIds.length > 1) {
          xOffset = Math.round((idx - (outcomeIds.length - 1) / 2) * 260)
        }
      }
      inserted.x = Math.round(sourceNode.position.x) + xOffset
      inserted.y = Math.round(sourceNode.position.y) + 280
    }
    replaceStepsState(nextSteps)
    setTriggerNextStep(nextTrig)
    syncCanvasFromSteps(nextSteps, triggerPos.x, triggerPos.y, nextTrig, triggerType, triggerConfig)
    setAddStepTarget(null)
  }

  // Escape closes the step-config drawer; matches the modal/drawer conventions
  // used elsewhere (confirm-dialog, prompt-dialog).
  useEffect(() => {
    if (!isDrawerOpen) return
    const onKey = (e) => { if (e.key === "Escape") setIsDrawerOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isDrawerOpen])

  // Database lists
  const [templates, setTemplates] = useState([])
  // Per-tenant Retell agent registry — used by the call node side panel dropdown.
  // Populated from /api/retell-agents on mount.
  const [retellAgents, setRetellAgents] = useState([])
  const [existingTags, setExistingTags] = useState(["lead reactivation", "hot lead", "appointment scheduled", "follow up"])
  // Tenant custom-field schema — drives the field selector dropdowns on
  // Create Contact / Find Contact nodes. Pulled once on mount; lightweight enough.
  const [tenantCustomFields, setTenantCustomFields] = useState([])
  // Connected senders — drives the From picker in the inline email composer.
  const [senders, setSenders] = useState([])
  // Merge-field groups, one per resolver, because the token SYNTAX differs:
  //  • templateMergeGroups → bare {{first_name}}/{{<custom_key>}} for render_template
  //    (email subject/body, SMS body, team_alert). No webhook-payload tokens.
  //  • exprMergeGroups → namespaced {{lead.*}}/{{custom.*}}/{{payload.*}} for
  //    resolve_workflow_expr (HTTP url/body and any expression-resolved field).
  // Plus per-input refs so the "Insert field" control works on each target.
  // Payload fields the Create Lead step maps onto the lead — these become
  // insertable "Webhook data" in template channels (SMS/email), since the
  // template resolver can only read lead-side values, never raw payloads.
  const webhookLeadMappings = useMemo(() => {
    const createLead = steps.find(st => st.type === "create_lead_from_payload")
    return Array.isArray(createLead?.field_mappings) ? createLead.field_mappings : []
  }, [steps])
  const templateMergeGroups = useMergeFieldGroups(tenantCustomFields, samples, "email", webhookLeadMappings)
  const exprMergeGroupsBase = useMergeFieldGroups(tenantCustomFields, samples, "http_request")
  // Response variables saved by HTTP steps — insertable into any
  // expression-resolved input (webhook URL/body/headers, conditions).
  const exprMergeGroups = useMemo(() => {
    const tokens = steps
      .filter(st => st.type === "http_request" && String(st.response_var || "").trim() !== "")
      .flatMap(st => [
        { token: `{{custom.${st.response_var}}}`, label: `${st.response_var} — full response` },
        { token: `{{custom.${st.response_var}_status}}`, label: `${st.response_var} — status code` },
      ])
    return tokens.length > 0 ? [...exprMergeGroupsBase, { label: "HTTP responses", tokens }] : exprMergeGroupsBase
  }, [exprMergeGroupsBase, steps])
  const smsBodyRef = useRef(null)
  const httpUrlRef = useRef(null)
  const httpBodyRef = useRef(null)
  const tplSubjectRef = useRef(null)
  const tplBodyRef = useRef(null)
  const journeyReadiness = useMemo(() => validateJourneySpec({
    mode: journeyMode,
    steps,
    triggerNextStep,
    trigger_type: triggerType,
    goals,
  }, {
    templates,
    retellAgents,
    suppressionSafetyKnown: true,
  }), [journeyMode, steps, triggerNextStep, triggerType, goals, templates, retellAgents])

  useEffect(() => {
    let cancelled = false
    fetch("/api/custom-fields")
      .then(r => r.json())
      .then(j => { if (!cancelled) setTenantCustomFields(Array.isArray(j?.data?.fields) ? j.data.fields : []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Connected senders for the inline email composer's From picker.
  useEffect(() => {
    let cancelled = false
    fetch("/api/senders")
      .then(r => r.json())
      .then(j => { if (!cancelled) setSenders(Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : [])) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Load AI agents once for the per-journey AI-reply-agent picker. Cheap
  // (typically 1-5 rows per tenant); disabled agents are shown greyed so
  // the operator understands why they can't be picked.
  useEffect(() => {
    let cancelled = false
    fetch("/api/ai-agents")
      .then(r => r.json())
      .then(j => { if (!cancelled) setAiAgentsList(Array.isArray(j?.data) ? j.data : []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Inline edit template state (for drawer)
  const [isEditingTemplate, setIsEditingTemplate] = useState(false)
  const [tplEditForm, setTplEditForm] = useState({
    id: null,
    template_key: "",
    channel: "email",
    subject: "",
    body: ""
  })

  // Helper to synchronize loaded spec steps/trigger configuration to React Flow canvas nodes and edges
  const syncCanvasFromSteps = (loadedSteps, triggerX, triggerY, triggerNextVal, triggerTypeVal, triggerConfigVal) => {
    // Build traversed transitions
    const traversedTransitions = new Set()
    const activeTransitions = new Set()
    const visitedSteps = new Set()
    const isTerminal = selectedExecution ? !["active", "new", "paused"].includes(selectedExecution.lead.journey_status) : false
    const currentStep = selectedExecution && !isTerminal ? selectedExecution.lead.current_step : null

    if (selectedExecution) {
      const sortedActions = [...selectedExecution.actions].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
      
      sortedActions.forEach(a => visitedSteps.add(a.step_index))

      if (sortedActions.length > 0) {
        traversedTransitions.add(`trigger->${sortedActions[0].step_index}`)
      } else if (currentStep !== null && currentStep !== undefined) {
        traversedTransitions.add(`trigger->${currentStep}`)
        activeTransitions.add(`trigger->${currentStep}`)
      }

      for (let index = 0; index < sortedActions.length - 1; index++) {
        const currentAct = sortedActions[index]
        const nextAct = sortedActions[index + 1]
        traversedTransitions.add(`${currentAct.step_index}->${nextAct.step_index}`)
      }

      if (sortedActions.length > 0 && currentStep !== null && currentStep !== undefined) {
        const lastAct = sortedActions[sortedActions.length - 1]
        if (lastAct.step_index !== currentStep) {
          traversedTransitions.add(`${lastAct.step_index}->${currentStep}`)
          activeTransitions.add(`${lastAct.step_index}->${currentStep}`)
        }
      }
    }

    const triggerNode = {
      id: "trigger",
      type: "customTrigger",
      position: { x: triggerX, y: triggerY },
      data: {
        triggerType: triggerTypeVal,
        triggerConfig: triggerConfigVal,
        isSelected: false,
        isHighlighted: !!selectedExecution,
        onClick: () => handleNodeClick({ type: "trigger" }),
        onAddStep: setAddStepTarget,
        triggerNextStep: triggerNextVal ?? null,
        stepCount: loadedSteps.length
      }
    }

    const stepNodes = loadedSteps.map(s => {
      const isCurrentStep = currentStep !== null && s.index === currentStep
      const isVisitedStep = visitedSteps.has(s.index)
      const template = templates.find(t => t.template_key === s.template_key)
      return {
        id: s.index.toString(),
        type: "customStep",
        position: { x: s.x ?? 250, y: s.y ?? 200 },
        data: {
          step: s,
          isSelected: false,
          highlightStatus: isCurrentStep ? 'current' : isVisitedStep ? 'visited' : null,
          templatePreview: template ? { subject: template.subject, body: template.body } : null,
          onClick: () => handleNodeClick({ type: "step", index: s.index, step: s }),
          onDelete: handleDeleteStep,
          onAddStep: setAddStepTarget
        }
      }
    })

    const initialEdges = []
    if (triggerNextVal !== null && triggerNextVal !== undefined) {
      const transitionKey = `trigger->${triggerNextVal}`
      const isTraversed = traversedTransitions.has(transitionKey)
      const isActive = activeTransitions.has(transitionKey)
      initialEdges.push({
        id: "e-trigger-default",
        source: "trigger",
        sourceHandle: "default",
        target: triggerNextVal.toString(),
        type: "buttonEdge",
        animated: isActive,
        style: isTraversed
          ? { stroke: isActive ? '#3b82f6' : '#10b981', strokeWidth: 3.5 }
          : { stroke: '#6366f1', strokeWidth: 2.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: isTraversed ? (isActive ? '#3b82f6' : '#10b981') : "#6366f1" },
        data: { 
          onDelete: (id) => handleEdgeDeleteRef.current?.(id),
          label: "Continue",
          outcomeKey: "default"
        }
      })
    }

    loadedSteps.forEach(s => {
      Object.keys(s.on_outcome || {}).forEach(outcomeKey => {
        const outcome = s.on_outcome[outcomeKey]
        if (outcome && outcome.next_step !== undefined && outcome.next_step !== null) {
          const transitionKey = `${s.index}->${outcome.next_step}`
          const isTraversed = traversedTransitions.has(transitionKey)
          const isActive = activeTransitions.has(transitionKey)
          initialEdges.push({
            id: `e-${s.index}-${outcomeKey}`,
            source: s.index.toString(),
            sourceHandle: outcomeKey,
            target: outcome.next_step.toString(),
            type: "buttonEdge",
            animated: isActive,
            style: isTraversed
              ? { stroke: isActive ? '#3b82f6' : '#10b981', strokeWidth: 3.5 }
              : { stroke: '#6366f1', strokeWidth: 2.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: isTraversed ? (isActive ? '#3b82f6' : '#10b981') : "#6366f1" },
            data: { 
              onDelete: (id) => handleEdgeDeleteRef.current?.(id),
              label: getJourneyOutcomeDisplay(s, outcomeKey).label,
              outcomeKey
            }
          })
        }
      })
    })

    setNodes([triggerNode, ...stepNodes])
    setEdges(initialEdges)
  }

  // Edge delete callback ref sync
  useEffect(() => {
    handleEdgeDeleteRef.current = (edgeId) => {
      setEdges(currentEdges => {
        const edge = currentEdges.find(e => e.id === edgeId);
        if (edge) {
          const { source, sourceHandle } = edge;
          if (source === "trigger") {
            setTriggerNextStep(null);
          } else {
            const sourceIndex = parseInt(source);
            const nextSteps = getCurrentSteps().map(s => {
              if (s.index === sourceIndex) {
                const on_outcome = { ...(s.on_outcome || {}) };
                on_outcome[sourceHandle] = { exit: "completed" };
                return { ...s, on_outcome };
              }
              return s;
            });
            replaceStepsState(nextSteps);
          }
        }
        return currentEdges.filter(e => e.id !== edgeId);
      });
    };
  }, []);

  // Dynamic visual path highlighting reactive to selectedExecution
  useEffect(() => {
    setNodes(nds => nds.map(node => {
      if (node.id === "trigger") {
        return {
          ...node,
          data: {
            ...node.data,
            isHighlighted: !!selectedExecution
          }
        }
      }
      const stepIndex = parseInt(node.id)
      const isTerminal = selectedExecution ? !["active", "new", "paused"].includes(selectedExecution.lead.journey_status) : false
      const currentStep = selectedExecution && !isTerminal ? selectedExecution.lead.current_step : null
      const visitedSteps = selectedExecution ? new Set(selectedExecution.actions.map(a => a.step_index)) : new Set()
      const isCurrentStep = currentStep !== null && stepIndex === currentStep
      const isVisitedStep = visitedSteps.has(stepIndex)

      return {
        ...node,
        data: {
          ...node.data,
          highlightStatus: isCurrentStep ? 'current' : isVisitedStep ? 'visited' : null
        }
      }
    }))

    const traversedTransitions = new Set()
    const activeTransitions = new Set()
    const isTerminal = selectedExecution ? !["active", "new", "paused"].includes(selectedExecution.lead.journey_status) : false
    const currentStep = selectedExecution && !isTerminal ? selectedExecution.lead.current_step : null

    if (selectedExecution) {
      const sortedActions = [...selectedExecution.actions].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
      
      if (sortedActions.length > 0) {
        traversedTransitions.add(`trigger->${sortedActions[0].step_index}`)
      } else if (currentStep !== null && currentStep !== undefined) {
        traversedTransitions.add(`trigger->${currentStep}`)
        activeTransitions.add(`trigger->${currentStep}`)
      }

      for (let index = 0; index < sortedActions.length - 1; index++) {
        const currentAct = sortedActions[index]
        const nextAct = sortedActions[index + 1]
        traversedTransitions.add(`${currentAct.step_index}->${nextAct.step_index}`)
      }

      if (sortedActions.length > 0 && currentStep !== null && currentStep !== undefined) {
        const lastAct = sortedActions[sortedActions.length - 1]
        if (lastAct.step_index !== currentStep) {
          traversedTransitions.add(`${lastAct.step_index}->${currentStep}`)
          activeTransitions.add(`${lastAct.step_index}->${currentStep}`)
        }
      }
    }

    setEdges(eds => eds.map(edge => {
      const transitionKey = `${edge.source}->${edge.target}`
      const isTraversed = traversedTransitions.has(transitionKey)
      const isActive = activeTransitions.has(transitionKey)
      
      return {
        ...edge,
        animated: isActive,
        style: isTraversed
          ? { stroke: isActive ? '#3b82f6' : '#10b981', strokeWidth: 3.5 }
          : { stroke: '#6366f1', strokeWidth: 2.5 },
        markerEnd: {
          ...edge.markerEnd,
          color: isTraversed ? (isActive ? '#3b82f6' : '#10b981') : "#6366f1"
        }
      }
    }))
  }, [selectedExecution])

  // Enrich step nodes with hover templates on update
  useEffect(() => {
    setNodes(nds => nds.map(node => {
      if (node.id === "trigger") return node
      const stepIndex = parseInt(node.id)
      const step = steps.find(s => s.index === stepIndex)
      if (!step) return node
      const template = templates.find(t => t.template_key === step.template_key)
      return {
        ...node,
        data: {
          ...node.data,
          templatePreview: template ? { subject: template.subject, body: template.body } : null
        }
      }
    }))
  }, [templates, steps])

  // Load initial configurations
  useEffect(() => {
    fetchTemplates()
    fetchRetellAgents()
    fetchLeadsTags()
    if (journeyId) {
      if (justSavedRef.current) {
        justSavedRef.current = false
      } else {
        fetchJourney()
      }
    } else {
      // Seed default new journey steps with absolute coordinates
      const defaultSteps = [
        {
          index: 0,
          type: "call",
          template_key: "demo_call_1",
          delay: { amount: 0, unit: "minutes" },
          x: 250,
          y: 200,
          on_outcome: {
            answered: { exit: "completed" },
            no_answer: { next_step: 1 },
            voicemail: { next_step: 1 }
          }
        },
        {
          index: 1,
          type: "sms",
          template_key: "demo_sms_1",
          // Per-step delay deprecated — use an upstream Wait node to introduce a delay.
          delay: { amount: 0, unit: "minutes" },
          x: 250,
          y: 380,
          on_outcome: {
            default: { exit: "completed" }
          }
        }
      ]
      setTriggerPos({ x: 250, y: 50 })
      setTriggerNextStep(0)
      const sidSteps = ensureStepSids(defaultSteps)
      stepsRef.current = sidSteps
      setSteps(sidSteps)
      setHasUnsavedChanges(false)
      syncCanvasFromSteps(defaultSteps, 250, 50, 0, "lead_enrolled", { webhook_url: "", tag: "", form_id: "", keywords: "", subject_filter: "" })
    }
  }, [journeyId])

  const fetchTemplates = async () => {
    try {
      const res = await fetch("/api/templates")
      const data = await res.json()
      setTemplates(data.data || [])
    } catch (err) {
      console.error("Failed to fetch templates:", err)
    }
  }

  // Load Retell agent registry alongside templates. Failures here are non-fatal —
  // the call node falls back to "no agent selected" and the dispatcher will
  // surface the resolved fallback (or raise) at runtime.
  const fetchRetellAgents = async () => {
    try {
      const res = await fetch("/api/retell-agents")
      const data = await res.json()
      setRetellAgents(data.data || [])
    } catch (err) {
      console.warn("Failed to load Retell agents:", err)
    }
  }

  const fetchLeadsTags = async () => {
    try {
      const tags = new Set(["lead reactivation", "hot lead", "appointment scheduled", "follow up"])

      // 1. Fetch from leads
      const leadsRes = await fetch("/api/leads")
      const leadsData = await leadsRes.json()
      const leads = leadsData.data || []
      leads.forEach(l => {
        if (l.custom_fields?.tags && Array.isArray(l.custom_fields.tags)) {
          l.custom_fields.tags.forEach(t => tags.add(t))
        }
      })

      // 2. Fetch from tenant config
      const tenantRes = await fetch("/api/tenant")
      const tenantData = await tenantRes.json()
      const tenant = tenantData.data || {}
      if (tenant.config?.tags && Array.isArray(tenant.config.tags)) {
        tenant.config.tags.forEach(t => tags.add(t))
      }

      setExistingTags(Array.from(tags))
    } catch (err) {
      console.warn("Failed to load existing tags, using fallbacks:", err)
    }
  }

  const fetchWebhookInfo = async () => {
    if (!journeyId) {
      setWebhookInfo(null)
      return
    }
    setWebhookLoading(true)
    try {
      // GET first; if no token yet, POST to provision one.
      let res = await fetch(`/api/journeys/${journeyId}/webhook`)
      let json = await res.json()
      if (res.ok && !json.data?.webhook_token) {
        res = await fetch(`/api/journeys/${journeyId}/webhook`, { method: "POST" })
        json = await res.json()
        if (res.ok) {
          // re-GET to also load samples
          const r2 = await fetch(`/api/journeys/${journeyId}/webhook`)
          const j2 = await r2.json()
          if (r2.ok) json.data = j2.data
        }
      }
      if (!res.ok) {
        console.warn("Webhook fetch failed:", json.error)
        return
      }
      setWebhookInfo(json.data)
    } catch (err) {
      console.error("Failed to load webhook info:", err)
    } finally {
      setWebhookLoading(false)
    }
  }

  const rotateWebhookToken = async () => {
    if (!journeyId) return
    if (!(await confirm({
      title: "Rotate the webhook URL?",
      message: "Anything pointing at the old URL will stop working.",
      confirmLabel: "Rotate URL",
      destructive: true,
    }))) return
    setWebhookLoading(true)
    try {
      const res = await fetch(`/api/journeys/${journeyId}/webhook`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate" })
      })
      const json = await res.json()
      if (!res.ok) { pushToast("error", json.error || "Rotate failed"); return }
      await fetchWebhookInfo()
    } finally {
      setWebhookLoading(false)
    }
  }

  const setWebhookAuth = async (mode, opts = {}) => {
    if (!journeyId) return
    setWebhookLoading(true)
    try {
      const res = await fetch(`/api/journeys/${journeyId}/webhook`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_auth", mode, ...opts })
      })
      const json = await res.json()
      if (!res.ok) { pushToast("error", json.error || "Could not update auth"); return }
      await fetchWebhookInfo()
    } finally {
      setWebhookLoading(false)
    }
  }

  const clearWebhookSamples = async () => {
    if (!journeyId) return
    setWebhookLoading(true)
    try {
      await fetch(`/api/journeys/${journeyId}/webhook`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_samples" })
      })
      await fetchWebhookInfo()
    } finally {
      setWebhookLoading(false)
    }
  }

  useEffect(() => {
    if (triggerType === "webhook" && journeyId) {
      fetchWebhookInfo()
    }
  }, [triggerType, journeyId])

  const fetchJourney = async () => {
    setLoading(true)
    try {
      // Include inactive (draft) journeys — the builder is exactly where users
      // come to edit drafts before activating.
      const res = await fetch("/api/journeys?include_inactive=1")
      const data = await res.json()
      const current = (data.data || []).find(j => j.id === journeyId)
      if (current) {
        setName(current.name)
        setJourneyKey(current.journey_key)
        setActive(current.active)
        setAiAgentId(current.ai_agent_id || null)

        // Phase 5: edit the draft when one exists; fall back to the live spec.
        const editSpec = current.draft_spec || current.spec || {}

        // PHASE6: per-journey stop-on-reply policy. 'stop' default → omit from
        // spec to keep specs lean; 'continue' preserves the value.
        setStopOnReply(editSpec.stop_on_reply === "continue" ? "continue" : "stop")

        const journeyModeVal = editSpec.mode === "event_workflow" ? "event_workflow" : "lead_journey"
        const triggerTypeVal = journeyModeVal === "event_workflow" ? "webhook" : (editSpec.trigger_type || "lead_enrolled")
        const triggerConfigVal = editSpec.trigger_config || { webhook_url: "", tag: "", form_id: "", keywords: "", subject_filter: "" }
        setJourneyMode(journeyModeVal)
        setTriggerType(triggerTypeVal)
        setTriggerConfig(triggerConfigVal)
        setGoals(Array.isArray(editSpec.goals) ? editSpec.goals : [])
        setPinnedSampleId(editSpec.pinned_webhook_sample_id || null)
        if (Array.isArray(editSpec.workflow_variables)) {
          const workflowVariables = editSpec.workflow_variables
            .filter((entry) => entry?.key && entry?.path)
            .map((entry) => ({
              key: String(entry.key || "").toLowerCase().replace(/[^a-z0-9_]/g, "_"),
              path: String(entry.path || ""),
              isStandard: Boolean(entry.is_standard || entry.isStandard),
            }))
          setVariables(workflowVariables.length > 0 ? workflowVariables : [
            { key: "first_name", path: "payload.first_name", isStandard: true },
            { key: "last_name",  path: "payload.last_name",  isStandard: true },
            { key: "email",      path: "payload.email",      isStandard: true },
            { key: "phone",      path: "payload.phone",      isStandard: true }
          ])
        } else if (editSpec.webhook_mapping) {
          const wm = editSpec.webhook_mapping
          const standardKeys = ["first_name", "last_name", "email", "phone", "phone_e164", "phone_raw"]
          const loadedVariables = [
            { key: "first_name", path: "", isStandard: true },
            { key: "last_name",  path: "", isStandard: true },
            { key: "email",      path: "", isStandard: true },
            { key: "phone",      path: "", isStandard: true }
          ]
          for (const [k, v] of Object.entries(wm)) {
            const pathVal = typeof v === "string" ? v : (v?.from || "")
            if (standardKeys.includes(k)) {
              const mappedKey = k === "phone_e164" || k === "phone_raw" ? "phone" : k
              const idx = loadedVariables.findIndex(x => x.key === mappedKey)
              if (idx >= 0) {
                loadedVariables[idx].path = pathVal
              }
            } else if (k.startsWith("custom.")) {
              loadedVariables.push({
                key: k.slice(7),
                path: pathVal,
                isStandard: false
              })
            }
          }
          setVariables(loadedVariables)
        } else {
          setVariables([
            { key: "first_name", path: "payload.first_name", isStandard: true },
            { key: "last_name",  path: "payload.last_name",  isStandard: true },
            { key: "email",      path: "payload.email",      isStandard: true },
            { key: "phone",      path: "payload.phone",      isStandard: true }
          ])
        }
        
        // Load Trigger positioning and target
        const triggerX = editSpec.trigger_x ?? 250
        const triggerY = editSpec.trigger_y ?? 50
        setTriggerPos({ x: triggerX, y: triggerY })
        setHasDraft(current.draft_spec != null)

        const loadedSteps = editSpec.steps || []
        const savedTriggerNext = editSpec.trigger_next_step
        const finalTriggerNext = savedTriggerNext !== undefined ? savedTriggerNext : (loadedSteps.length > 0 ? 0 : null)
        setTriggerNextStep(finalTriggerNext)
        
        // Load steps with vertical auto-layout fallback if coordinates are missing.
        // migrateOnOutcomes (from the step-types schema) maps any legacy on_outcome keys
        // to the current vocabulary so old journeys keep working when the schema evolves.
        const hasCoords = loadedSteps.some(s => s.x !== undefined && s.y !== undefined)
        let processedSteps = []
        if (!hasCoords && loadedSteps.length > 0) {
          processedSteps = loadedSteps.map((s, idx) => migrateOnOutcomes({
            ...s,
            x: 250,
            y: 200 + idx * 180
          }))
        } else {
          processedSteps = loadedSteps.map(s => migrateOnOutcomes({
            ...s,
            x: s.x ?? 250,
            y: s.y ?? 200
          }))
        }
        processedSteps = ensureStepSids(processedSteps)
        stepsRef.current = processedSteps
        setSteps(processedSteps)
        setHasUnsavedChanges(false)
        syncCanvasFromSteps(processedSteps, triggerX, triggerY, finalTriggerNext, triggerTypeVal, triggerConfigVal)
        // Re-fit the viewport once React Flow has rendered the newly-loaded
        // nodes. Two animation frames is enough for the layout to settle.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          reactFlowInstanceRef.current?.fitView?.({ padding: 0.2, maxZoom: 1.2 })
        }))
      } else {
        setErrorMsg("Journey not found in database.")
      }
    } catch (err) {
      console.error("Failed to load journey:", err)
      setErrorMsg("Failed to load journey from remote DB.")
    } finally {
      setLoading(false)
    }
  }

  const handleStartTriggerChange = (trigger) => {
    setTriggerType(trigger)
    setJourneyMode(trigger === "webhook" ? "event_workflow" : "lead_journey")
  }

  // Graph compiler for free-form canvas to linear spec.steps format
  const compileWorkflow = () => {
    if (triggerNextStep === null) return [];
    const sourceSteps = getCurrentSteps();
    
    const compiled = [];
    const visited = new Set();
    const canvasToCompiled = {};
    
    // Resolve the next node to visit. Wait nodes are ALWAYS first-class steps
    // (they carry operator-visible timing config), so we never collapse them
    // into the next step's delay. Only exit_flow gets pass-through treatment.
    const resolveNextActiveNode = (startIndex, initialDelay = { amount: 0, unit: "minutes" }) => {
      const step = sourceSteps.find(s => s.index === startIndex);
      if (!step) {
        return { targetIndex: null, delay: initialDelay, exit: "completed" };
      }
      if (step.type === "exit_flow") {
        // exit_flow terminates the lead. We return its canvas index so the
        // visual edge to the exit node persists, AND the exit signal so the
        // runtime terminates via advance_journey's exit-first check.
        return { targetIndex: startIndex, delay: initialDelay, exit: "completed", isExitFlow: true };
      }
      // Every other node type — wait, wait_reply, sms, email, call, team_alert,
      // conditional_split, http_request, etc. — is returned as-is. No walking
      // forward, no delay accumulation. What the operator drew is what runs.
      return { targetIndex: startIndex, delay: initialDelay, exit: null };
    };
    
    // Traverse starting from triggerNextStep
    const queue = [];
    const firstResolved = resolveNextActiveNode(triggerNextStep);
    
    if (firstResolved.targetIndex !== null) {
      queue.push({
        canvasIndex: firstResolved.targetIndex,
        delay: firstResolved.delay
      });
    }
    
    while (queue.length > 0) {
      const curr = queue.shift();
      if (visited.has(curr.canvasIndex)) continue;
      visited.add(curr.canvasIndex);
      
      const step = sourceSteps.find(s => s.index === curr.canvasIndex);
      if (!step) continue;
      
      canvasToCompiled[curr.canvasIndex] = curr.canvasIndex;

      const compiledStep = {
        index: step.index,
        sid: step.sid,
        type: step.type,
        delay: curr.delay,
        // Preserve business_hours_only ONLY when explicitly set by older saved
        // specs. The UI no longer surfaces this per-step (use the Wait node's
        // advance_window instead). Default off so new journeys don't carry it.
        ...(typeof step.business_hours_only === 'boolean' ? { business_hours_only: step.business_hours_only } : {}),
        x: step.x,
        y: step.y
      };

      if (step.template_key) compiledStep.template_key = step.template_key;
      if (step.content_mode) compiledStep.content_mode = step.content_mode;
      if (step.inline_body) compiledStep.inline_body = step.inline_body;
      if (step.inline_subject) compiledStep.inline_subject = step.inline_subject;
      // Sender pin + From-name override are inline-email-only concepts. Only
      // carry them when this email step is actually composing inline, so a
      // template-mode email is never silently pinned to a sender.
      {
        const emailInline = step.type === "email" &&
          (step.content_mode === "inline" || (!step.template_key && step.inline_body));
        if (emailInline && step.sender_id) compiledStep.sender_id = step.sender_id;
        if (emailInline && step.from_name) compiledStep.from_name = step.from_name;
      }
      if (step.label) compiledStep.label = step.label;
      if (step.http_method) compiledStep.http_method = step.http_method;
      if (step.http_url) compiledStep.http_url = step.http_url;
      if (step.http_headers) compiledStep.http_headers = step.http_headers;
      if (step.http_timeout_ms) compiledStep.http_timeout_ms = step.http_timeout_ms;
      if (step.http_body) compiledStep.http_body = step.http_body;
      if (step.response_var) compiledStep.response_var = step.response_var;
      if (step.tag_name) compiledStep.tag_name = step.tag_name;
      if (step.type === "conditional_split" && Array.isArray(step.branches) && step.branches.length > 0) compiledStep.branches = step.branches;
      if (step.type === "ab_split") compiledStep.split_percent_a = Math.max(0, Math.min(100, Number(step.split_percent_a ?? 50) || 0));
      // Legacy single-field update_lead shape is preserved for backwards
      // compatibility. New journeys use step.fields (array) which the
      // execute_update_lead RPC prefers when present.
      if (step.update_field) compiledStep.update_field = step.update_field;
      if (step.update_value) compiledStep.update_value = step.update_value;
      // Multi-field update_lead. Side panel emits [{key, value}]; we pass it
      // through verbatim. The execute_update_lead RPC reads fields[i].key and
      // strips the "custom." prefix for custom-field writes.
      if (step.type === "update_lead" && Array.isArray(step.fields) && step.fields.length > 0) {
        compiledStep.fields = step.fields
          .filter(f => f && (f.key || "").trim() !== "")
          .map(f => ({ key: f.key.trim(), value: f.value ?? "" }));
      }
      if (step.condition) compiledStep.condition = step.condition;
      // Per-step Retell agent override (call nodes). When set, get_call_payload
      // resolves this agent_id against retell_agents instead of using the
      // tenant-credentials default. Empty/missing = use tenant default.
      if (step.type === "call" && step.retell_agent_id) compiledStep.retell_agent_id = step.retell_agent_id;
      // Per-step Retell dynamic variables — passed to retell_llm_dynamic_variables
      // at call time. Filter empty keys (UI lets users add a row then leave it blank).
      if (step.type === "call" && Array.isArray(step.retell_dynamic_variables)) {
        const cleaned = step.retell_dynamic_variables
          .filter(v => v && (v.key || "").trim() !== "")
          .map(v => ({ key: v.key.trim(), value: v.value ?? "" }));
        if (cleaned.length > 0) compiledStep.retell_dynamic_variables = cleaned;
      }
      // Preserve every piece of wait config so the engine can honor it.
      if (step.type === "wait") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (step.mode) compiledStep.mode = step.mode;
        if (step.duration) compiledStep.duration = step.duration;
        if (step.until) compiledStep.until = step.until;
        if (step.on_passed) compiledStep.on_passed = step.on_passed;
        if (step.on_passed_step !== undefined && step.on_passed_step !== null) compiledStep.on_passed_step = step.on_passed_step;
        if (step.advance_window) compiledStep.advance_window = step.advance_window;
      }
      // Preserve wait_reply timeout config. Without this the runtime falls
      // back to delay (which is 0 from curr.delay) and fires timeout instantly.
      if (step.type === "wait_reply") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (step.duration)    compiledStep.duration    = step.duration;
        if (step.mode)        compiledStep.mode        = step.mode;
        if (step.until)       compiledStep.until       = step.until;
      }
      // action_name is a user-facing label — preserve on ANY step type
      // (sms, email, team_alert, etc.) so operators don't lose their custom
      // node labels across a save cycle.
      if (step.action_name && !compiledStep.action_name) {
        compiledStep.action_name = step.action_name;
      }
      // create_lead / update_lead / find_lead config
      if (step.type === "create_lead" || step.type === "update_lead") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (Array.isArray(step.fields)) compiledStep.fields = step.fields;
        if (step.mode) compiledStep.mode = step.mode;
      }
      if (step.type === "create_lead_from_payload") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        compiledStep.duplicate_mode = step.duplicate_mode || "skip_existing";
        compiledStep.field_mappings = Array.isArray(step.field_mappings) ? step.field_mappings : [];
        compiledStep.tags = Array.isArray(step.tags) ? step.tags : [];
      }
      if (step.type === "find_lead") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (Array.isArray(step.filters)) compiledStep.filters = step.filters;
        if (step.match_strategy) compiledStep.match_strategy = step.match_strategy;
      }
      if (step.type === "find_lead_from_payload") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        compiledStep.search = Array.isArray(step.search) ? step.search : [];
      }

      compiled.push({
        compiledStep,
        canvasIndex: curr.canvasIndex,
        originalOutcomes: step.on_outcome || {}
      });
      
      Object.keys(step.on_outcome || {}).forEach(outcomeKey => {
        const outcome = step.on_outcome[outcomeKey];
        if (outcome && outcome.next_step !== undefined) {
          const resolved = resolveNextActiveNode(outcome.next_step);
          if (resolved.targetIndex !== null) {
            if (!visited.has(resolved.targetIndex) && !queue.some(q => q.canvasIndex === resolved.targetIndex)) {
              queue.push({
                canvasIndex: resolved.targetIndex,
                delay: resolved.delay
              });
            }
          }
        }
      });
    }
    
    // Add all unvisited nodes (so they are preserved on the canvas)
    const unvisited = sourceSteps.filter(s => !visited.has(s.index));
    unvisited.forEach(step => {
      canvasToCompiled[step.index] = step.index;
      visited.add(step.index);

      const compiledStep = {
        index: step.index,
        sid: step.sid,
        type: step.type,
        delay: step.delay || { amount: 0, unit: "minutes" },
        ...(typeof step.business_hours_only === 'boolean' ? { business_hours_only: step.business_hours_only } : {}),
        x: step.x,
        y: step.y
      };

      if (step.template_key) compiledStep.template_key = step.template_key;
      if (step.content_mode) compiledStep.content_mode = step.content_mode;
      if (step.inline_body) compiledStep.inline_body = step.inline_body;
      if (step.inline_subject) compiledStep.inline_subject = step.inline_subject;
      // Sender pin + From-name override are inline-email-only concepts. Only
      // carry them when this email step is actually composing inline, so a
      // template-mode email is never silently pinned to a sender.
      {
        const emailInline = step.type === "email" &&
          (step.content_mode === "inline" || (!step.template_key && step.inline_body));
        if (emailInline && step.sender_id) compiledStep.sender_id = step.sender_id;
        if (emailInline && step.from_name) compiledStep.from_name = step.from_name;
      }
      if (step.label) compiledStep.label = step.label;
      if (step.http_method) compiledStep.http_method = step.http_method;
      if (step.http_url) compiledStep.http_url = step.http_url;
      if (step.http_headers) compiledStep.http_headers = step.http_headers;
      if (step.http_timeout_ms) compiledStep.http_timeout_ms = step.http_timeout_ms;
      if (step.http_body) compiledStep.http_body = step.http_body;
      if (step.response_var) compiledStep.response_var = step.response_var;
      if (step.tag_name) compiledStep.tag_name = step.tag_name;
      if (step.type === "conditional_split" && Array.isArray(step.branches) && step.branches.length > 0) compiledStep.branches = step.branches;
      if (step.type === "ab_split") compiledStep.split_percent_a = Math.max(0, Math.min(100, Number(step.split_percent_a ?? 50) || 0));
      if (step.update_field) compiledStep.update_field = step.update_field;
      if (step.update_value) compiledStep.update_value = step.update_value;
      if (step.type === "update_lead" && Array.isArray(step.fields) && step.fields.length > 0) {
        compiledStep.fields = step.fields
          .filter(f => f && (f.key || "").trim() !== "")
          .map(f => ({ key: f.key.trim(), value: f.value ?? "" }));
      }
      if (step.condition) compiledStep.condition = step.condition;
      if (step.type === "call" && step.retell_agent_id) compiledStep.retell_agent_id = step.retell_agent_id;
      if (step.type === "call" && Array.isArray(step.retell_dynamic_variables)) {
        const cleaned = step.retell_dynamic_variables
          .filter(v => v && (v.key || "").trim() !== "")
          .map(v => ({ key: v.key.trim(), value: v.value ?? "" }));
        if (cleaned.length > 0) compiledStep.retell_dynamic_variables = cleaned;
      }
      if (step.type === "wait") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (step.mode) compiledStep.mode = step.mode;
        if (step.duration) compiledStep.duration = step.duration;
        if (step.until) compiledStep.until = step.until;
        if (step.on_passed) compiledStep.on_passed = step.on_passed;
        if (step.on_passed_step !== undefined && step.on_passed_step !== null) compiledStep.on_passed_step = step.on_passed_step;
        if (step.advance_window) compiledStep.advance_window = step.advance_window;
      }
      if (step.type === "wait_reply") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (step.duration)    compiledStep.duration    = step.duration;
        if (step.mode)        compiledStep.mode        = step.mode;
        if (step.until)       compiledStep.until       = step.until;
      }
      if (step.action_name && !compiledStep.action_name) {
        compiledStep.action_name = step.action_name;
      }
      if (step.type === "create_lead" || step.type === "update_lead") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (Array.isArray(step.fields)) compiledStep.fields = step.fields;
        if (step.mode) compiledStep.mode = step.mode;
      }
      if (step.type === "create_lead_from_payload") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        compiledStep.duplicate_mode = step.duplicate_mode || "skip_existing";
        compiledStep.field_mappings = Array.isArray(step.field_mappings) ? step.field_mappings : [];
        compiledStep.tags = Array.isArray(step.tags) ? step.tags : [];
      }
      if (step.type === "find_lead") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        if (Array.isArray(step.filters)) compiledStep.filters = step.filters;
        if (step.match_strategy) compiledStep.match_strategy = step.match_strategy;
      }
      if (step.type === "find_lead_from_payload") {
        if (step.action_name) compiledStep.action_name = step.action_name;
        compiledStep.search = Array.isArray(step.search) ? step.search : [];
      }

      compiled.push({
        compiledStep,
        canvasIndex: step.index,
        originalOutcomes: step.on_outcome || {}
      });
    });
    
    // Fill in outcomes
    const finalSteps = compiled.map(({ compiledStep, canvasIndex, originalOutcomes }) => {
      const on_outcome = {};
      Object.keys(originalOutcomes).forEach(outcomeKey => {
        const outcome = originalOutcomes[outcomeKey];
        if (outcome) {
          if (outcome.next_step !== undefined) {
            const resolved = resolveNextActiveNode(outcome.next_step);
            if (resolved.targetIndex !== null && canvasToCompiled[resolved.targetIndex] !== undefined) {
              const compiledIdx = canvasToCompiled[resolved.targetIndex];
              const targetStep = sourceSteps.find(s => s.index === resolved.targetIndex);
              const targetSid = targetStep?.sid;
              if (resolved.isExitFlow || outcome.exit !== undefined) {
                // Exit_flow target: save BOTH so visual edge persists AND runtime exits.
                // advance_journey checks `exit` first; never executes the exit_flow step row.
                on_outcome[outcomeKey] = { next_step: compiledIdx, ...(targetSid ? { next_sid: targetSid } : {}), exit: outcome.exit || resolved.exit || "completed" };
              } else {
                on_outcome[outcomeKey] = { next_step: compiledIdx, ...(targetSid ? { next_sid: targetSid } : {}) };
              }
            } else {
              on_outcome[outcomeKey] = { exit: outcome.exit || resolved.exit || "completed" };
            }
          } else if (outcome.exit !== undefined) {
            on_outcome[outcomeKey] = { exit: outcome.exit };
          }
        }
      });
      return {
        ...compiledStep,
        on_outcome
      };
    });
    
    return {
      steps: finalSteps,
      triggerNextStepMapped: triggerNextStep !== null ? canvasToCompiled[triggerNextStep] : null
    };
  };

  // Automatically adjust node coordinates to prevent overlaps using layered Sugiyama-style layout
  const autoLayoutWorkflow = () => {
    // Layout math lives in ./lib/autoLayout (pure + unit-tested); this adapter
    // just applies the computed positions to the canvas and the step specs.
    const currentSteps = getCurrentSteps()
    const layout = computeLayout({ triggerNextStep, steps: currentSteps })

    setTriggerPos(layout.trigger)
    setNodes(nds => nds.map(n => {
      if (n.id === "trigger") return { ...n, position: layout.trigger }
      const pos = layout.steps[n.id]
      return pos ? { ...n, position: pos } : n
    }))
    replaceStepsState(currentSteps.map(s => {
      const pos = layout.steps[s.index]
      return pos ? { ...s, x: pos.x, y: pos.y } : s
    }))
  };

  // Handle saving the journey spec to Supabase
  const handleSaveJourney = async () => {
    if (!name.trim()) {
      setErrorMsg("Journey Name is required.")
      return
    }
    if (!journeyKey.trim()) {
      setErrorMsg("Journey Key is required.")
      return
    }
    if (active && journeyReadiness.status === "invalid") {
      setErrorMsg("Fix journey readiness errors before saving an active workflow.")
      return
    }

    setSaving(true)
    setErrorMsg("")
    setSuccessMsg("")

    const { steps: finalSteps, triggerNextStepMapped } = compileWorkflow();

    const spec = {
      key: journeyKey,
      name: name,
      mode: triggerType === "webhook" ? "event_workflow" : "lead_journey",
      ...(stopOnReply === "continue" ? { stop_on_reply: "continue" } : {}),
      trigger: triggerType === "webhook" ? "webhook.fired" : triggerType === "tag_added" ? "lead.tag_added" : "lead.enrolled",
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      trigger_x: triggerPos.x,
      trigger_y: triggerPos.y,
      trigger_next_step: triggerNextStepMapped,
      pinned_webhook_sample_id: pinnedSampleId || null,
      workflow_variables: (variables || [])
        .filter(v => v.key && v.key.trim() !== "" && v.path && v.path.trim() !== "")
        .map(v => ({
          key: v.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
          path: toWorkflowPayloadSource(v.path),
          is_standard: Boolean(v.isStandard),
        })),
      steps: finalSteps,
      goals,
      exit_conditions: [],
      ...(triggerType === "webhook" && journeyMode !== "event_workflow"
        ? {
            webhook_mapping: Object.fromEntries(
              (variables || [])
                .filter(v => v.key && v.key.trim() !== "" && v.path && v.path.trim() !== "")
                .map(v => {
                  const safeKey = v.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_")
                  if (v.isStandard) {
                    return [safeKey, v.path.trim()]
                  } else {
                    return [`custom.${safeKey}`, v.path.trim()]
                  }
                })
            )
          }
        : {})
    }

    try {
      const res = await fetch("/api/journeys", {
        method: journeyId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: journeyId || undefined,
          journey_key: journeyKey,
          name: name,
          spec: spec,
          active: active,
          ai_agent_id: aiAgentId || null,
        })
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || "Failed to save Journey.")
      }

      // Auto-save new tags to the tenant settings config.tags in database
      const journeyTags = new Set()
      if (triggerType === "tag_added" && triggerConfig.tag) {
        journeyTags.add(triggerConfig.tag)
      }
      finalSteps.forEach(s => {
        if ((s.type === "add_tag" || s.type === "remove_tag") && s.tag_name) {
          journeyTags.add(s.tag_name)
        }
        if (s.type === "conditional_split" && s.condition?.rules) {
          s.condition.rules.forEach(r => {
            if (r.field === "tags" && r.value) {
              if (Array.isArray(r.value)) {
                r.value.forEach(v => v && journeyTags.add(v))
              } else {
                journeyTags.add(r.value)
              }
            }
          })
        }
      })

      if (journeyTags.size > 0) {
        try {
          const tenantRes = await fetch("/api/tenant")
          const tenantData = await tenantRes.json()
          const tenant = tenantData.data || {}
          const currentTags = tenant.config?.tags || []
          const mergedTags = Array.from(new Set([...currentTags, ...journeyTags]))
          
          if (mergedTags.length !== currentTags.length) {
            await fetch("/api/tenant", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                config: {
                  ...tenant.config,
                  tags: mergedTags
                }
              })
            })
          }
        } catch (tErr) {
          console.warn("Failed to auto-save new tags:", tErr)
        }
      }

      justSavedRef.current = true
      setHasUnsavedChanges(false)
      setHasDraft(true)
      setSuccessMsg("Draft saved — not live yet. Publish to make it live.")
      setLastSaved(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }))
      setIsSaveModalOpen(false)
      
      if (!journeyId && data.data?.id) {
        setJourneyId(data.data.id)
        window.history.replaceState(null, "", `${window.location.pathname}?id=${data.data.id}`)
      }
      
      setTimeout(() => {
        setSuccessMsg("")
      }, 4000)
    } catch (err) {
      console.error("Save error:", err)
      setErrorMsg(err.message || "Failed to save Journey.")
    } finally {
      setSaving(false)
    }
  }

  // Phase 5: promote the saved draft to the live spec via the publish RPC.
  const handlePublishJourney = async () => {
    if (!journeyId) {
      setErrorMsg("Save the journey first before publishing.")
      return
    }
    if (journeyReadiness.status === "invalid") {
      setErrorMsg("Fix validation errors before publishing.")
      return
    }
    setPublishing(true)
    setErrorMsg("")
    setSuccessMsg("")
    try {
      const res = await fetch(`/api/journeys/${journeyId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const json = await res.json()
      if (!res.ok) {
        setErrorMsg(json.error || "Publish failed.")
        return
      }
      const { version, running_runs } = json.data || {}
      setHasDraft(false)
      setSuccessMsg(`Published v${version}. ${running_runs ?? 0} lead(s) currently running will use the new version on their next step.`)
      setTimeout(() => setSuccessMsg(""), 6000)
    } catch (err) {
      setErrorMsg(err.message || "Failed to publish.")
    } finally {
      setPublishing(false)
    }
  }

  // Phase 5: discard the saved draft (the live spec is untouched).
  const handleDiscardDraft = async () => {
    if (!journeyId) return
    if (!(await confirm({
      title: "Discard the unpublished draft?",
      message: "The live spec is not affected.",
      confirmLabel: "Discard draft",
      destructive: true,
    }))) return
    setPublishing(true)
    try {
      const res = await fetch(`/api/journeys/${journeyId}/publish`, {
        method: "DELETE",
      })
      const json = await res.json()
      if (!res.ok) {
        setErrorMsg(json.error || "Discard failed.")
        return
      }
      setHasDraft(false)
      setSuccessMsg("Draft discarded. Reload the journey to edit the live spec.")
      setTimeout(() => setSuccessMsg(""), 4000)
    } catch (err) {
      setErrorMsg(err.message || "Failed to discard draft.")
    } finally {
      setPublishing(false)
    }
  }
  const handleUpdateStep = (index, updatedFields) => {
    const updateStepList = (prev) => prev.map(s => s.index === index ? { ...s, ...updatedFields } : s)
    replaceStepsState(updateStepList(getCurrentSteps()))

    // Sync to selectedNode if currently selected
    setSelectedNode(prev => {
      if (prev && prev.type === "step" && prev.index === index) {
        return {
          ...prev,
          step: { ...prev.step, ...updatedFields }
        }
      }
      return prev
    })

    // Sync to nodes state so custom node renders updated info
    setNodes(nds => nds.map(n => {
      if (n.id === index.toString()) {
        return {
          ...n,
          data: {
            ...n.data,
            step: { ...n.data.step, ...updatedFields }
          }
        }
      }
      return n
    }))
  }

  const assignPayloadSourceToCreateLead = (destination, source) => {
    const cleanDestination = String(destination || "").trim()
    const cleanSource = toWorkflowPayloadSource(source)
    if (!cleanDestination || !cleanSource) return

    let mapped = false
    const nextSteps = getCurrentSteps().map(step => {
      if (mapped || step.type !== "create_lead_from_payload") return step
      const nextMappings = mergeWorkflowFieldMapping(step.field_mappings, cleanDestination, cleanSource)
      const nextStep = { ...step, field_mappings: nextMappings }
      mapped = true

      setSelectedNode(prevNode => {
        if (prevNode?.type === "step" && prevNode.index === step.index) {
          return { ...prevNode, step: nextStep }
        }
        return prevNode
      })

      setNodes(nds => nds.map(node => {
        if (node.id === String(step.index)) {
          return { ...node, data: { ...node.data, step: nextStep } }
        }
        return node
      }))

      return nextStep
    })

    if (mapped) {
      replaceStepsState(nextSteps)
    }

    setSuccessMsg(mapped ? `Mapped ${cleanSource} to ${cleanDestination}.` : "Add a Create Lead step before mapping lead fields.")
    setTimeout(() => setSuccessMsg(""), 2500)
  }

  // Delete node
  const handleDeleteStep = (indexToDelete) => {
    const remaining = getCurrentSteps().filter(s => s.index !== indexToDelete)
    const nextSteps = remaining.map(s => {
      const on_outcome = { ...(s.on_outcome || {}) };
      Object.keys(on_outcome).forEach(k => {
        if (on_outcome[k] && on_outcome[k].next_step === indexToDelete) {
          on_outcome[k] = { exit: "completed" };
        }
      });
      return { ...s, on_outcome };
    });
    replaceStepsState(nextSteps);

    // Remove node from React Flow state
    setNodes(nds => nds.filter(n => n.id !== indexToDelete.toString()))

    // Remove connected edges from React Flow state
    setEdges(eds => eds.filter(e => e.source !== indexToDelete.toString() && e.target !== indexToDelete.toString()))
    
    if (triggerNextStep === indexToDelete) {
      setTriggerNextStep(null);
    }
    if (selectedNode?.index === indexToDelete) {
      setIsDrawerOpen(false)
      setSelectedNode(null)
    }
  }

  // HTTP Request headers editing helpers
  const handleUpdateHeaderKey = (stepIndex, oldKey, newKey) => {
    replaceStepsState(getCurrentSteps().map(s => {
      if (s.index === stepIndex) {
        const headers = { ...(s.http_headers || {}) };
        const val = headers[oldKey];
        delete headers[oldKey];
        headers[newKey] = val;
        return { ...s, http_headers: headers };
      }
      return s;
    }));
  };

  const handleUpdateHeaderValue = (stepIndex, key, val) => {
    replaceStepsState(getCurrentSteps().map(s => {
      if (s.index === stepIndex) {
        const headers = { ...(s.http_headers || {}) };
        headers[key] = val;
        return { ...s, http_headers: headers };
      }
      return s;
    }));
  };

  const handleAddHeader = (stepIndex) => {
    replaceStepsState(getCurrentSteps().map(s => {
      if (s.index === stepIndex) {
        const headers = { ...(s.http_headers || {}) };
        let newKey = "Header-Name";
        let count = 1;
        while (newKey in headers) {
          newKey = `Header-Name-${count}`;
          count++;
        }
        headers[newKey] = "value";
        return { ...s, http_headers: headers };
      }
      return s;
    }));
  };

  const handleRemoveHeader = (stepIndex, key) => {
    replaceStepsState(getCurrentSteps().map(s => {
      if (s.index === stepIndex) {
        const headers = { ...(s.http_headers || {}) };
        delete headers[key];
        return { ...s, http_headers: headers };
      }
      return s;
    }));
  };

  // HTTP Request testing proxy executor
  const handleTestHttpRequest = async (step) => {
    if (!step.http_url) {
      pushToast("error", "Please specify a Target Endpoint URL first.");
      return;
    }
    setTestingHttp(true);
    setTestResponse(null);
    try {
      const res = await fetch("/api/workflows/test-http", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: step.http_method || "POST",
          url: step.http_url,
          headers: step.http_headers || {},
          body: step.http_body || "",
          timeout_ms: clampTimeoutMs(step.http_timeout_ms)
        })
      });
      const data = await res.json();
      setTestResponse(data);
    } catch (err) {
      setTestResponse({ error: err.message });
    } finally {
      setTestingHttp(false);
    }
  };

  // Inline email composer: render the composed subject/body against a sample
  // lead (client-side, best-effort) and fire the existing sender test-send.
  // The address is always the connected sender's; from_name only changes the
  // display name.
  // Inline email is a TEMPLATE channel, so the preview must render exactly what
  // render_template would: bare lead tokens + bare custom keys, and NOTHING else.
  // (The old preview resolved {{custom.*}} and {{raw_payload.*}}, which the real
  // send leaves literal — the preview lied about the outgoing email.)
  const renderMergeForTest = (text) => renderTemplatePreview(text, samples[0]?.payload || {})

  const handleSendInlineTest = async (step, to) => {
    if (!step?.sender_id) { pushToast("error", "Pick a connected sender before sending a test."); return }
    if (!to) { pushToast("error", "Enter a recipient email for the test."); return }
    if (!String(step.inline_body || "").trim()) { pushToast("error", "Write an email body before sending a test."); return }
    setSendingInlineTest(true)
    try {
      const res = await fetch(`/api/senders/${step.sender_id}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          subject: renderMergeForTest(step.inline_subject),
          body_html: renderMergeForTest(step.inline_body),
          from_name: step.from_name || undefined,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.ok === false) {
        pushToast("error", `Test send failed (${json?.stage || res.status}): ${json?.error || "unknown error"}`)
      } else {
        pushToast("success", `Test sent to ${to} via ${json.via || "sender"}.`)
      }
    } catch (err) {
      pushToast("error", err.message || "Test send failed.")
    } finally {
      setSendingInlineTest(false)
    }
  }

  // Handle dynamic template inline save (from sidebar drawer)
  const handleSaveTemplateInline = async () => {
    if (!tplEditForm.template_key || !tplEditForm.body) {
      pushToast("error", "Template key and body content are required.")
      return
    }
    try {
      const isNew = !tplEditForm.id
      const res = await fetch("/api/templates", {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tplEditForm)
      })
      if (res.ok) {
        await fetchTemplates()
        handleUpdateStep(selectedNode.index, { template_key: tplEditForm.template_key })
        setIsEditingTemplate(false)
      } else {
        const err = await res.json()
        pushToast("error", err.error || "Failed to save template.")
      }
    } catch (err) {
      console.error(err)
      pushToast("error", "Error saving template.")
    }
  }

  // Node editing sidebar drawer trigger
  const handleNodeClick = (node) => {
    if (node && node.type === "step") {
      // Find the latest step in our state to avoid stale closure data from canvas click handlers
      const latestStep = steps.find(s => s.index === node.index)
      if (latestStep) {
        node = { ...node, step: latestStep }
      }
    }
    setSelectedNode(node)
    setIsDrawerOpen(true)
    setIsEditingTemplate(false)
    setTestResponse(null)
    setHttpAuthTypeDraft(null)
  }

  // Jump from a validation check to the offending step: close the save modal,
  // return to the canvas, open the step's config drawer, and center on it.
  const handleFocusStep = (stepId) => {
    const step = getCurrentSteps().find(st => st.index === stepId)
    if (!step) return
    setIsSaveModalOpen(false)
    setActiveTab("builder")
    handleNodeClick({ type: "step", index: stepId, step })
    const node = nodes.find(n => n.id === String(stepId))
    if (node && reactFlowInstanceRef.current) {
      reactFlowInstanceRef.current.setCenter(
        node.position.x + 160, node.position.y + 80,
        { zoom: 1, duration: 500 }
      )
    }
  }

  // Persists tag deletion to database and updates local state
  const handleDeleteTag = async (tagToDelete) => {
    setExistingTags(prev => prev.filter(t => t !== tagToDelete))
    try {
      const res = await fetch("/api/tenant")
      const tenantData = await res.json()
      const tenant = tenantData.data || {}
      const currentTags = tenant.config?.tags || []
      const updatedTags = currentTags.filter(t => t !== tagToDelete)
      
      await fetch("/api/tenant", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            ...tenant.config,
            tags: updatedTags
          }
        })
      })
    } catch (err) {
      console.warn("Failed to persist tag deletion:", err)
    }

    // Pre-populate template edit form if editing step has template key
    if (node.type === "step" && (node.step.type === "sms" || node.step.type === "email" || node.step.type === "call" || node.step.type === "team_alert")) {
      const step = node.step
      const tpl = templates.find(t => t.template_key === step.template_key && t.channel === (step.type === "team_alert" ? "team_alert" : step.type))
      if (tpl) {
        setTplEditForm({
          id: tpl.id,
          template_key: tpl.template_key,
          channel: tpl.channel,
          subject: tpl.subject || "",
          body: tpl.body || ""
        })
      } else {
        setTplEditForm({
          id: null,
          template_key: step.template_key || `tpl_${step.index}`,
          channel: step.type === "team_alert" ? "team_alert" : step.type,
          subject: step.type === "email" ? "Outreach Template" : "",
          body: ""
        })
      }
    }
  }

  // Handle node drag completion (sync coordinates back to steps state)
  const onNodeDragStop = (event, node) => {
    if (node.id === "trigger") {
      setTriggerPos({ x: Math.round(node.position.x), y: Math.round(node.position.y) })
    } else {
      const stepIdx = parseInt(node.id)
      replaceStepsState(getCurrentSteps().map(s => s.index === stepIdx ? { ...s, x: Math.round(node.position.x), y: Math.round(node.position.y) } : s))
    }
  }

  // Handle new canvas edge connections
  const onConnect = (connection) => {
    const { source, sourceHandle, target } = connection
    const targetIdx = parseInt(target)

    if (source === "trigger") {
      setTriggerNextStep(targetIdx)
    } else {
      const sourceIdx = parseInt(source)
      const targetStepSid = getCurrentSteps().find(s => s.index === targetIdx)?.sid
      replaceStepsState(getCurrentSteps().map(s => {
        if (s.index === sourceIdx) {
          const on_outcome = { ...(s.on_outcome || {}) }
          on_outcome[sourceHandle] = { next_step: targetIdx, ...(targetStepSid ? { next_sid: targetStepSid } : {}) }
          return { ...s, on_outcome }
        }
        return s
      }))
    }

    // Add visual edge immediately to canvas state
    const sourceStep = getCurrentSteps().find((step) => step.index === parseInt(source))
    const edgeLabel = source === "trigger"
      ? "Continue"
      : getJourneyOutcomeDisplay(sourceStep, sourceHandle).label
    setEdges(eds => addEdge({
      ...connection,
      type: "buttonEdge",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6366f1" },
      data: { 
        onDelete: (id) => handleEdgeDeleteRef.current?.(id),
        label: edgeLabel,
        outcomeKey: sourceHandle
      }
    }, eds))
  }

  // Highlight selected node card
  useEffect(() => {
    setNodes(nds => nds.map(n => {
      const isSelected = selectedNode 
        ? (n.id === "trigger" ? selectedNode.type === "trigger" : (selectedNode.type === "step" && selectedNode.index.toString() === n.id))
        : false
      return {
        ...n,
        data: {
          ...n.data,
          isSelected
        }
      }
    }))
  }, [selectedNode])

  // Sync templates changes to nodes data
  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.id !== "trigger") {
        return {
          ...n,
          data: {
            ...n.data,
            templates
          }
        }
      }
      return n
    }))
  }, [templates])

  // Sync triggerType and triggerConfig changes to trigger node data
  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.id === "trigger") {
        return {
          ...n,
          data: {
            ...n.data,
            triggerType,
            triggerConfig
          }
        }
      }
      return n
    }))
  }, [triggerType, triggerConfig])

  return (
    <div className="flex flex-col h-dvh relative overflow-hidden text-zinc-900 dark:text-zinc-100">
      
      {/* Top Controls & Navigation Tab bar */}
      <div className="grid grid-cols-3 items-center border-b border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-md px-6 py-3 shrink-0 z-30 w-full">
        <div className="flex items-center gap-3 justify-start">
          <Button 
            variant="ghost" 
            size="sm"
            onClick={() => router.push("/journeys")}
            className="h-9 w-9 p-0 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 border border-black/10 dark:border-white/10 text-zinc-600 dark:text-zinc-400"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="truncate">
            <h1 className="text-lg font-bold tracking-tight flex items-center gap-2 truncate">
              <Sliders className="w-5 h-5 text-zinc-400 shrink-0" />
              <span className="truncate">{name || "Untitled Journey"}</span>
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
              {journeyKey || "new_journey_key"} · {triggerType === "webhook" ? "Webhook received" : "Lead is enrolled"}
            </p>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="flex justify-center">
          <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-xl border border-black/5 dark:border-white/5">
            {["builder", "settings", "executions"].map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab)
                  if (tab === "executions") refreshExecutions()
                }}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all duration-300 ${
                  activeTab === tab 
                    ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm"
                    : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {tab === "builder" ? "Journey Builder" : tab === "settings" ? "Journey Settings" : "Executions"}
              </button>
            ))}
          </div>
        </div>

        {/* Action button bar */}
        <div className="flex items-center gap-3 justify-end">
          {successMsg && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1 bg-emerald-500/10 px-2.5 py-1.5 rounded-lg border border-emerald-500/20 animate-fade-in shrink-0">
              <Check className="w-3.5 h-3.5" />
              {successMsg}
            </span>
          )}
          {!successMsg && lastSaved && (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1 font-medium bg-zinc-950/5 dark:bg-white/5 px-2.5 py-1.5 rounded-lg border border-black/5 dark:border-white/5 shrink-0">
              <Clock className="w-3.5 h-3.5" />
              Last saved: {lastSaved}
            </span>
          )}
          {errorMsg && (
            <span className="text-xs text-rose-600 dark:text-rose-400 font-medium flex items-center gap-1 bg-rose-500/10 px-2.5 py-1.5 rounded-lg border border-rose-500/20 shrink-0">
              <AlertTriangle className="w-3.5 h-3.5" />
              {errorMsg}
            </span>
          )}
          
          <Button
            onClick={() => { setShowFunnel(v => !v); if (!showFunnel) refreshFunnel() }}
            className="bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 rounded-xl px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-2 text-xs font-semibold shrink-0"
          >
            <PieChart className="w-3.5 h-3.5" />
            {showFunnel ? "Hide funnel" : "Funnel"}
          </Button>
          <Button
            onClick={() => setIsSaveModalOpen(true)}
            disabled={saving || loading}
            className="bg-zinc-950 dark:bg-white text-white dark:text-black rounded-xl px-4 py-2 hover:opacity-90 flex items-center gap-2 text-xs font-semibold shadow-md shrink-0"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save Journey
          </Button>
          {journeyId ? (
            <>
              <Button
                onClick={handlePublishJourney}
                disabled={publishing || saving || loading || journeyReadiness.status === "invalid" || !hasDraft}
                className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl px-4 py-2 flex items-center gap-2 text-xs font-semibold shadow-md shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                title={journeyReadiness.status === "invalid" ? "Fix validation errors before publishing" : !hasDraft ? "No unpublished draft to publish" : "Promote the draft to the live spec"}
              >
                {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Publish
              </Button>
              {hasDraft ? (
                <Button
                  onClick={handleDiscardDraft}
                  disabled={publishing || saving || loading}
                  variant="destructive"
                  title="Discard the unpublished draft"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Discard
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {/* Funnel slide-over (toggled by the Funnel button) */}
      <FunnelDrawer
        open={showFunnel}
        loading={funnelLoading}
        funnel={funnel}
        onClose={() => setShowFunnel(false)}
        onRefresh={refreshFunnel}
      />

      {/* Main Canvas Area */}
      <div className="flex-1 flex relative overflow-hidden bg-zinc-50 dark:bg-zinc-950/20">

        {activeTab === "builder" && (
          <div className="flex-1 h-full relative">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDragStop={onNodeDragStop}
              onInit={(inst) => { reactFlowInstanceRef.current = inst }}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
              className="bg-zinc-50 dark:bg-zinc-950"
            >
              <Background variant="dots" gap={24} size={1} className="opacity-40" />
              <Controls className="bg-white/60 dark:bg-zinc-950/40 backdrop-blur-md border border-black/10 dark:border-white/10 rounded-xl shadow-2xl text-zinc-800 dark:text-zinc-200 !m-4" />
              <MiniMap className="bg-white/60 dark:bg-zinc-950/40 backdrop-blur-md border border-black/10 dark:border-white/10 rounded-xl shadow-2xl !m-4" nodeColor={() => '#6366f1'} maskColor="rgba(0, 0, 0, 0.1)" />

              {/* Auto-Layout button floating on top-right */}
              <Panel position="top-right" className="!m-4 z-30">
                <Button
                  onClick={autoLayoutWorkflow}
                  className="bg-white/60 dark:bg-zinc-950/60 backdrop-blur-md border border-black/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-zinc-900/85 text-zinc-800 dark:text-zinc-200 rounded-xl px-3.5 py-2 flex items-center gap-2 text-xs font-semibold shadow-xl transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                  <span>Auto-Layout</span>
                </Button>
              </Panel>

              {/* Floating Toolbox to add steps */}
              <Panel position="top-left" className="flex flex-col gap-2 bg-white/60 dark:bg-black/40 backdrop-blur-md border border-black/10 dark:border-white/10 rounded-2xl p-3 shadow-2xl z-30 w-56 no-pan">
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1 block px-1">Actions</span>

                {/* Palette is generated from the journey step-types schema.
                    To add a new step type: edit src/lib/journeyStepTypes.js. */}
                {(triggerType === "webhook" ? WEBHOOK_ACTION_PALETTE_ORDER : PALETTE_ORDER).filter(t => STEP_TYPES[t]).map(stepType => {
                  const cfg = STEP_TYPES[stepType]
                  const webhookHasLeadContext = steps.some((step) => step.type === "create_lead_from_payload" || step.type === "find_lead_from_payload")
                  const disabledReason = triggerType === "webhook" ? getWebhookActionDisabledReason(stepType, webhookHasLeadContext) : null
                  const disabled = Boolean(disabledReason)
                  return (
                    <button
                      key={stepType}
                      type="button"
                      disabled={disabled}
                      title={disabledReason || undefined}
                      onClick={() => {
                        if (disabled) return
                        const currentSteps = getCurrentSteps()
                        const newIndex = allocateStepIndex(currentSteps)
                        const tplChannel = templateChannelFor(stepType)
                        const defaultTpl = tplChannel ? templates.find(t => t.channel === tplChannel) : null
                        const defaultKey = defaultTpl ? defaultTpl.template_key : undefined

                        const newStep = ensureStepSids([{
                          index: newIndex,
                          type: stepType,
                          x: 250,
                          y: 200 + currentSteps.length * 150,
                          delay: cfg.defaultDelay || { amount: 0, unit: "minutes" },
                          ...(cfg.defaultsExtra || {}),
                          ...(defaultKey ? { template_key: defaultKey } : {}),
                          on_outcome: defaultOutcomesFor(stepType),
                        }])[0]
                        replaceStepsState([...currentSteps, newStep])

                        // Add new node directly to React Flow nodes state
                        const newNode = {
                          id: newIndex.toString(),
                          type: "customStep",
                          position: { x: 250, y: 200 + currentSteps.length * 150 },
                          data: {
                            step: newStep,
                            isSelected: false,
                            onClick: () => handleNodeClick({ type: "step", index: newIndex, step: newStep }),
                            onDelete: handleDeleteStep,
                            onAddStep: setAddStepTarget
                          }
                        }
                        setNodes(nds => [...nds, newNode])
                      }}
                      className={`w-full text-left px-3 py-2 border rounded-xl text-xs font-semibold transition-all flex items-start gap-2 no-drag ${
                        disabled
                          ? "bg-zinc-500/5 text-zinc-400 border-zinc-500/10 cursor-not-allowed"
                          : `${cfg.paletteClass} hover:scale-[1.02] active:scale-[0.98]`
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="min-w-0">
                        <span className="block">{paletteLabelFor(stepType, cfg)}</span>
                        {disabledReason && (
                          <span className="block text-[10px] font-normal leading-snug text-zinc-400 dark:text-zinc-500">
                            {disabledReason}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </Panel>
            </ReactFlow>
          </div>
        )}

        {/* Settings Tab Layout */}
        {activeTab === "settings" && (
          <SettingsTab
            aiAgentId={aiAgentId}
            aiAgentsList={aiAgentsList}
            goals={goals}
            journeyId={journeyId}
            journeyKey={journeyKey}
            name={name}
            setAiAgentId={setAiAgentId}
            setGoals={setGoals}
            setHasUnsavedChanges={setHasUnsavedChanges}
            setJourneyKey={setJourneyKey}
            setName={setName}
            setStopOnReply={setStopOnReply}
            steps={steps}
            stopOnReply={stopOnReply}
          />
        )}

        {/* Executions Tab Layout */}
        {activeTab === "executions" && (
          <ExecutionsTab
            executions={executions}
            executionsLoading={executionsLoading}
            executionsSearch={executionsSearch}
            filteredExecutions={filteredExecutions}
            name={name}
            refreshExecutions={refreshExecutions}
            selectedExecution={selectedExecution}
            setExecutionsSearch={setExecutionsSearch}
            setSelectedExecution={setSelectedExecution}
          />
        )}

        {/* Guided "+" action picker */}
        <AddStepPicker
          open={!!addStepTarget}
          triggerType={triggerType}
          hasLeadContext={webhookHasLeadContext(steps)}
          onPick={handleAddStepPick}
          onClose={() => setAddStepTarget(null)}
        />

        {/* Sliding configuration sidebar drawer (on the right) */}
        <AnimatePresence>
          {isDrawerOpen && selectedNode && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsDrawerOpen(false)}
                className="absolute inset-0 bg-black/60 z-40 backdrop-blur-[1px]"
              />

              {/* Sidebar Content drawer */}
              <motion.div 
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 220 }}
                className="absolute right-0 top-0 bottom-0 w-full max-w-[450px] bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-white/5 shadow-2xl z-50 flex flex-col"
                role="dialog"
                aria-modal="true"
                aria-label={selectedNode.type === "trigger" ? "Configure trigger" : `Configure step ${selectedNode.index}`}
              >
                {/* Drawer Header */}
                <div className="p-5 border-b border-black/5 dark:border-white/5 flex items-center justify-between bg-zinc-50 dark:bg-black/20">
                  <div className="flex items-center gap-2">
                    {selectedNode.type === "trigger" ? (
                      <Activity className="w-5 h-5 text-purple-600" />
                    ) : (
                      <Clock className="w-5 h-5 text-zinc-500" />
                    )}
                    <h3 className="font-bold text-sm text-zinc-900 dark:text-white capitalize">
                      {selectedNode.type === "trigger" ? "Configure Trigger" : `Configure Step #${selectedNode.index}`}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDrawerOpen(false)}
                    aria-label="Close configuration drawer"
                    className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-zinc-500"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Drawer Body Scroll */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  {selectedNode.type === "trigger" ? (
                    /* TRIGGER CONFIG */
                    <div className="space-y-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-zinc-500 uppercase">Start Trigger</Label>
                        <CustomSelect 
                          value={triggerType}
                          onChange={handleStartTriggerChange}
                          options={START_TRIGGER_OPTIONS}
                          triggerClassName="w-full h-10 px-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white font-medium flex items-center justify-between"
                        />
                        {!["lead_enrolled", "webhook"].includes(triggerType) && (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            This trigger is not wired to the native runtime yet. Use manual/bulk enrollment or a custom inbound webhook for active journeys.
                          </p>
                        )}
                      </div>

                      {triggerType === "webhook" && (
                        <div className="space-y-3 bg-blue-500/5 border border-blue-500/10 p-4 rounded-xl">
                          <p className="text-xs text-zinc-700 dark:text-zinc-300">
                            Start this automation when an external form, ad, or tool sends JSON data to this webhook.
                          </p>
                          {!journeyId ? (
                            <div className="text-xs text-zinc-500 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                              <strong className="text-amber-600 dark:text-amber-400 block mb-1">Save the journey first</strong>
                              A webhook URL is provisioned the first time a saved journey requests one.
                            </div>
                          ) : (
                            <>
                              {/* 1. Webhook URL */}
                              <div className="space-y-2">
                                <Label className="text-xs font-semibold text-blue-500 uppercase">Webhook URL</Label>
                                <div className="flex gap-2">
                                  <div className="flex-1 font-mono text-xs p-2 bg-black/40 rounded-lg text-zinc-300 select-all break-all border border-white/5">
                                    {webhookInfo?.webhook_url || (webhookLoading ? "Loading…" : "(will be generated)")}
                                  </div>
                                  {webhookInfo?.webhook_url && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        navigator.clipboard?.writeText(webhookInfo.webhook_url)
                                        setSuccessMsg("Webhook URL copied")
                                        setTimeout(() => setSuccessMsg(""), 1500)
                                      }}
                                      className="rounded-xl border-black/10 dark:border-white/10 text-xs"
                                    >Copy</Button>
                                  )}
                                </div>
                              </div>

                              {/* 2. Listen for test data — n8n-style capture loop */}
                              <div className="space-y-2 pt-2 border-t border-black/5 dark:border-white/10">
                                <Label className="text-xs font-semibold text-zinc-500 uppercase">Test with real data</Label>
                                {listeningForSample ? (
                                  <div className="flex items-center gap-2.5 p-3 bg-blue-500/10 border border-blue-500/25 rounded-xl">
                                    <Loader2 className="w-4 h-4 animate-spin text-blue-500 shrink-0" />
                                    <div className="flex-1 text-xs text-zinc-700 dark:text-zinc-200">
                                      Waiting for a request… send data to the webhook URL now.
                                    </div>
                                    <button
                                      type="button"
                                      onClick={stopListeningForSample}
                                      className="text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 underline underline-offset-2"
                                    >Stop</button>
                                  </div>
                                ) : (
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={startListeningForSample}
                                    className="rounded-xl"
                                  >
                                    <Play className="w-3.5 h-3.5 mr-1.5" />
                                    {samples.length > 0 ? "Listen for new data" : "Listen for data"}
                                  </Button>
                                )}
                                {justReceivedSample && (
                                  <Alert variant="success" size="sm">New data received — pick the fields to use below.</Alert>
                                )}
                              </div>

                              {/* 3. Latest data → click a field to use it */}
                              {samples[0] && (
                                <div className="space-y-2 pt-2 border-t border-black/5 dark:border-white/10">
                                  <div className="flex items-center justify-between">
                                    <Label className="text-xs font-semibold text-zinc-500 uppercase">
                                      Latest data · {new Date(samples[0].received_at).toLocaleString()}
                                    </Label>
                                    <button
                                      type="button"
                                      onClick={() => setInspectedSample(samples[0])}
                                      className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                                    >Open full inspector</button>
                                  </div>
                                  <DetectedPayloadFieldsMapper
                                    sample={samples[0]}
                                    onLeadMapping={assignPayloadSourceToCreateLead}
                                    onAssign={assignVariablePath}
                                    createLeadAvailable={steps.some((step) => step.type === "create_lead_from_payload")}
                                  />
                                </div>
                              )}

                              {/* 4. Sample history — status + jump to the execution it started */}
                              <SamplesPanel
                                samples={samples}
                                loading={samplesLoading}
                                onInspect={(s) => setInspectedSample(s)}
                                onRefresh={refreshSamples}
                                pinnedSampleId={pinnedSampleId}
                                onPin={(sampleId) => {
                                  setPinnedSampleId(sampleId)
                                  setHasUnsavedChanges(true)
                                }}
                                onViewExecution={handleViewSampleExecution}
                                onClear={clearWebhookSamples}
                              />

                              {/* 5. Advanced — auth, variables, rotation, reference docs */}
                              <details className="pt-2 border-t border-black/5 dark:border-white/10">
                                <summary className="cursor-pointer text-xs font-semibold text-zinc-500 uppercase select-none hover:text-zinc-700 dark:hover:text-zinc-300 py-1">
                                  Advanced — authentication, variables &amp; docs
                                </summary>
                                <div className="space-y-3 pt-2">
                                  {/* Authentication */}
                              <div className="space-y-2 pt-2 border-t border-black/5 dark:border-white/10">
                                <Label className="text-xs font-semibold text-zinc-500 uppercase">Authentication</Label>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setWebhookAuth("none")}
                                    disabled={webhookLoading}
                                    className={`flex-1 px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                                      webhookInfo?.webhook_auth_mode === "none"
                                        ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 border-zinc-900 dark:border-white"
                                        : "bg-transparent text-zinc-500 border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                                    }`}
                                  >No auth</button>
                                  <button
                                    type="button"
                                    onClick={() => setWebhookAuth("bearer", { rotate_secret: webhookInfo?.webhook_auth_mode !== "bearer" })}
                                    disabled={webhookLoading}
                                    className={`flex-1 px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                                      webhookInfo?.webhook_auth_mode === "bearer"
                                        ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 border-zinc-900 dark:border-white"
                                        : "bg-transparent text-zinc-500 border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                                    }`}
                                  >Bearer secret</button>
                                </div>
                                {webhookInfo?.webhook_auth_mode === "bearer" && webhookInfo?.webhook_secret && (
                                  <div className="space-y-1.5">
                                    <Label className="text-[10px] text-zinc-500 font-bold uppercase">Secret</Label>
                                    <div className="flex gap-2">
                                      <div className="flex-1 font-mono text-[11px] p-2 bg-black/40 rounded-lg text-zinc-300 select-all break-all border border-white/5">
                                        {showSecret ? webhookInfo.webhook_secret : "•".repeat(Math.min(webhookInfo.webhook_secret.length, 32))}
                                      </div>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setShowSecret(!showSecret)}
                                        className="rounded-xl border-black/10 dark:border-white/10 text-xs"
                                      >{showSecret ? "Hide" : "Show"}</Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          navigator.clipboard?.writeText(webhookInfo.webhook_secret)
                                          setSuccessMsg("Secret copied")
                                          setTimeout(() => setSuccessMsg(""), 1500)
                                        }}
                                        className="rounded-xl border-black/10 dark:border-white/10 text-xs"
                                      >Copy</Button>
                                    </div>
                                    <p className="text-[10px] text-zinc-500">
                                      Callers must send <span className="font-mono text-zinc-400">Authorization: Bearer {"<secret>"}</span>. Anything else returns 401.
                                    </p>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        if (await confirm({
                                          title: "Rotate the secret?",
                                          message: "Anything using the old secret will stop working.",
                                          confirmLabel: "Rotate secret",
                                          destructive: true,
                                        })) {
                                          setWebhookAuth("bearer", { rotate_secret: true })
                                        }
                                      }}
                                      className="text-[10px] text-rose-500 hover:underline"
                                    >Rotate secret</button>
                                  </div>
                                )}
                              </div>

                                  {/* Workflow variables mapping */}
                              <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/10">
                                <div className="flex items-center justify-between">
                                  <Label className="text-xs font-semibold text-zinc-500 uppercase flex items-center gap-1.5">
                                    Journey Variables ({variables.length})
                                    <span
                                      className="cursor-help text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                                      title="Save webhook values for later steps in this automation. Create Lead mappings are separate."
                                    >
                                      <Info className="w-3.5 h-3.5" />
                                    </span>
                                  </Label>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setVariables([...variables, { key: "", path: "", isStandard: false }])
                                      setHasUnsavedChanges(true)
                                    }}
                                    className="h-7 rounded-xl border-black/10 dark:border-white/10 text-[10px]"
                                  >
                                    <Plus className="w-3 h-3 mr-1" /> Add Variable
                                  </Button>
                                </div>
                                <p className="text-[11px] text-zinc-500">
                                  Save webhook values for later steps in this automation. Choose which webhook values become lead fields in the Create Lead step.
                                </p>

                                <div className="space-y-2 max-h-[350px] overflow-y-auto pr-1">
                                  {variables.map((v, idx) => (
                                    <div key={idx} className="grid grid-cols-[110px_1fr_24px] gap-2 items-center">
                                      {v.isStandard ? (
                                        <div className="h-7 px-2 flex items-center bg-zinc-100 dark:bg-white/5 border border-black/5 dark:border-white/5 rounded-lg text-xs font-mono text-zinc-500 dark:text-zinc-400 select-none cursor-not-allowed">
                                          {v.key}
                                        </div>
                                      ) : (
                                        <Input
                                          placeholder="key (e.g. source)"
                                          value={v.key}
                                          onChange={(e) => {
                                            const val = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_")
                                            setVariables(variables.map((x, i) => i === idx ? { ...x, key: val } : x))
                                            setHasUnsavedChanges(true)
                                          }}
                                          className="h-7 text-xs bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-lg font-mono"
                                          list="tenant-custom-fields-list"
                                        />
                                      )}
                                      
                                      <Input
                                        placeholder={v.isStandard && v.key === "email" ? "data.fields[2].value" : "payload path"}
                                        value={v.path}
                                        onChange={(e) => {
                                          setVariables(variables.map((x, i) => i === idx ? { ...x, path: e.target.value } : x))
                                          setHasUnsavedChanges(true)
                                        }}
                                        className="h-7 text-xs bg-white dark:bg-surface-3 border-black/10 dark:border-white/10 rounded-lg font-mono"
                                      />

                                      {v.isStandard ? (
                                        <div className="w-6 h-6 flex items-center justify-center text-[10px] text-zinc-400 font-bold select-none cursor-not-allowed" title="System variable (cannot delete)">
                                          •
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setVariables(variables.filter((_, i) => i !== idx))
                                            setHasUnsavedChanges(true)
                                          }}
                                          className="p-1 text-zinc-400 hover:text-rose-500"
                                          title="Remove"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                                <datalist id="tenant-custom-fields-list">
                                  {tenantCustomFields.map(cf => (
                                    <option key={cf.key} value={cf.key}>{cf.label}</option>
                                  ))}
                                </datalist>
                              </div>

                                  <div className="pt-2 border-t border-black/5 dark:border-white/10">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={rotateWebhookToken}
                                      disabled={webhookLoading}
                                    >Rotate URL</Button>
                                    <p className="text-[10px] text-zinc-500 mt-1">Rotating the URL breaks anything still posting to the old one.</p>
                                  </div>

                                  {/* How to use captured data — collapsible reference */}
                              <details className="bg-blue-500/[0.04] border border-blue-500/20 rounded-xl">
                                <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-500/10 rounded-xl select-none flex items-center gap-1.5">
                                  <HelpCircle className="w-3.5 h-3.5" />
                                  How to use captured payload data
                                </summary>
                                <div className="px-3 py-3 border-t border-blue-500/20 text-[11px] text-zinc-600 dark:text-zinc-300 space-y-3">
                                  <div>
                                    <div className="font-semibold text-zinc-800 dark:text-zinc-100 mb-1">1. Send any JSON</div>
                                    The webhook accepts every payload shape. Click "Fetch samples" above to see what came in, then pick fields to map.
                                  </div>
                                  <div>
                                    <div className="font-semibold text-zinc-800 dark:text-zinc-100 mb-1">2. Map a payload path → lead field</div>
                                    Use payload paths: <span className="font-mono bg-black/30 px-1 rounded text-zinc-200">payload.contact.email</span><br />
                                    Arrays use brackets: <span className="font-mono bg-black/30 px-1 rounded text-zinc-200">payload.data.fields[2].value</span>
                                  </div>
                                  <div>
                                    <div className="font-semibold text-zinc-800 dark:text-zinc-100 mb-1">3. Reference custom fields elsewhere</div>
                                    <div>In <b>email/SMS templates</b>:</div>
                                    <div className="font-mono bg-black/30 px-1.5 py-0.5 rounded text-zinc-200 inline-block mt-0.5">Hi {`{{first_name}}`}, your {`{{<custom_key>}}`}.</div>
                                    <div className="mt-1.5">In a <b>Condition Split</b> (canvas): pick the field <span className="font-mono bg-black/30 px-1 rounded text-zinc-200">custom.{`<key>`}</span>.</div>
                                    <div className="mt-1.5">In a <b>Webhook step</b> body:</div>
                                    <div className="font-mono bg-black/30 px-1.5 py-0.5 rounded text-zinc-200 inline-block mt-0.5">{`{ "tag": "{{custom_key}}" }`}</div>
                                  </div>
                                  <div className="pt-2 border-t border-blue-500/10">
                                    <div className="font-semibold text-zinc-800 dark:text-zinc-100 mb-1">Lead identification</div>
                                    If this automation starts with Create Lead, that step needs a mapping that resolves email or phone. Other webhook automations can use payload values without creating a lead.
                                  </div>
                                </div>
                              </details>
                                </div>
                              </details>
                            </>
                          )}
                        </div>
                      )}
                      {triggerType === "tag_added" && (
                        <div className="space-y-2">
                          <Label className="text-xs font-semibold text-zinc-500 uppercase">Trigger Tag Name</Label>
                          <TagAutocomplete 
                            value={triggerConfig.tag}
                            onChange={(tag) => setTriggerConfig({ ...triggerConfig, tag })}
                            suggestions={existingTags}
                          />
                          <p className="text-[11px] text-zinc-500">Flow starts when this tag is added to any lead.</p>
                        </div>
                      )}

                      {triggerType === "form_submitted" && (
                        <div className="space-y-2">
                          <Label className="text-xs font-semibold text-zinc-500 uppercase">Form Name or ID</Label>
                          <Input 
                            value={triggerConfig.form_id || ""}
                            placeholder="e.g. contact_us_form"
                            onChange={(e) => setTriggerConfig({ ...triggerConfig, form_id: e.target.value })}
                            className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl"
                          />
                          <p className="text-[11px] text-zinc-500">Starts when a user submits this specific form.</p>
                        </div>
                      )}

                      {triggerType === "incoming_sms" && (
                        <div className="space-y-2">
                          <Label className="text-xs font-semibold text-zinc-500 uppercase">SMS Keyword Filters (Comma separated)</Label>
                          <Input 
                            value={triggerConfig.keywords || ""}
                            placeholder="e.g. yes, help, start"
                            onChange={(e) => setTriggerConfig({ ...triggerConfig, keywords: e.target.value })}
                            className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl"
                          />
                          <p className="text-[11px] text-zinc-500">Starts when a lead replies to an SMS containing keywords.</p>
                        </div>
                      )}

                      {triggerType === "email_replied" && (
                        <div className="space-y-2">
                          <Label className="text-xs font-semibold text-zinc-500 uppercase">Subject Keyword Filter (Optional)</Label>
                          <Input
                            value={triggerConfig.subject_filter || ""}
                            placeholder="e.g. pricing, quote"
                            onChange={(e) => setTriggerConfig({ ...triggerConfig, subject_filter: e.target.value })}
                            className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl"
                          />
                          <p className="text-[11px] text-zinc-500">Starts when an email response containing this subject keyword is received.</p>
                        </div>
                      )}

                      {triggerType === "lead_created" && (
                        <div className="space-y-2">
                          <Label className="text-xs font-semibold text-zinc-500 uppercase">Source Filter (Optional)</Label>
                          <Input
                            value={triggerConfig.source || ""}
                            placeholder="e.g. csv_import, manual, webhook"
                            onChange={(e) => setTriggerConfig({ ...triggerConfig, source: e.target.value })}
                            className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl"
                          />
                          <p className="text-[11px] text-zinc-500">Starts when a new lead is created with this source value. Leave empty to trigger on any source.</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* NODE STEPS CONFIG */
                    <div className="space-y-6">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-zinc-500 uppercase">Action Name / Label</Label>
                        <Input 
                          value={selectedNode.step.label || ""}
                          placeholder={`Step #${selectedNode.index} ${selectedNode.step.type}`}
                          onChange={(e) => handleUpdateStep(selectedNode.index, { label: e.target.value })}
                          className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl"
                        />
                      </div>

                      {/* Per-node timing config (wait delay + business-hours restriction)
                          was removed in favor of the dedicated Wait node. Place a Wait
                          step upstream and use its advance_window config to clamp the
                          following step to business hours. One config surface per
                          concept; no duplication across every node. */}

                      {/* Wait specific config — GHL-style */}
                      {selectedNode.step.type === "wait" && (() => {
                        const s = selectedNode.step
                        const mode = s.mode || "duration"
                        const aw = s.advance_window || { enabled: false }
                        const days = Array.isArray(aw.days) ? aw.days : ["Mon","Tue","Wed","Thu","Fri"]
                        const DAY_KEYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
                        const update = (patch) => handleUpdateStep(selectedNode.index, patch)
                        const updateAW = (patch) => update({ advance_window: { ...aw, ...patch } })
                        const toggleDay = (d) => {
                          const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d]
                          updateAW({ days: next })
                        }
                        return (
                          <div className="p-4 bg-amber-500/5 border border-amber-500/10 rounded-2xl space-y-4">
                            <Label className="text-xs font-semibold text-amber-500 uppercase flex items-center gap-1">
                              <Clock className="w-4 h-4" /> Wait
                            </Label>

                            {/* Action name */}
                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Action name</Label>
                              <Input
                                value={s.action_name || ""}
                                placeholder={mode === "until" ? "e.g. 1 Day Before Appointment" : `Wait for ${s.duration?.amount ?? s.delay?.amount ?? 1} ${s.duration?.unit ?? s.delay?.unit ?? "hours"}`}
                                onChange={(e) => update({ action_name: e.target.value })}
                                className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                              />
                              <p className="text-[10px] text-zinc-500">Shows on the canvas so you can tell waits apart at a glance.</p>
                            </div>

                            {/* Wait type */}
                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Selected wait type</Label>
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => update({ mode: "duration" })}
                                  className={`p-2.5 rounded-xl border text-left text-xs flex items-center gap-2 ${mode === "duration" ? "border-amber-500 bg-amber-500/10" : "border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/[0.02]"}`}
                                >
                                  <Clock className="w-4 h-4 text-amber-500" />
                                  For a set period of time
                                </button>
                                <button
                                  type="button"
                                  onClick={() => update({ mode: "until" })}
                                  className={`p-2.5 rounded-xl border text-left text-xs flex items-center gap-2 ${mode === "until" ? "border-amber-500 bg-amber-500/10" : "border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/[0.02]"}`}
                                >
                                  <Calendar className="w-4 h-4 text-amber-500" />
                                  Until a specific date/time
                                </button>
                              </div>
                            </div>

                            {/* Mode: duration */}
                            {mode === "duration" && (
                              <div className="space-y-2">
                                <Label className="text-xs text-zinc-500">Time period</Label>
                                <div className="flex gap-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    value={s.duration?.amount ?? s.delay?.amount ?? 1}
                                    onChange={(e) => update({
                                      duration: {
                                        amount: parseInt(e.target.value) || 0,
                                        unit: s.duration?.unit ?? s.delay?.unit ?? "hours",
                                      },
                                      // Keep legacy `delay` in sync so non-config waits still collapse cleanly.
                                      delay: { amount: parseInt(e.target.value) || 0, unit: s.duration?.unit ?? s.delay?.unit ?? "hours" }
                                    })}
                                    className="w-24 bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                                  />
                                  <CustomSelect
                                    value={s.duration?.unit ?? s.delay?.unit ?? "hours"}
                                    onChange={(val) => update({
                                      duration: { amount: s.duration?.amount ?? s.delay?.amount ?? 1, unit: val },
                                      delay: { amount: s.duration?.amount ?? s.delay?.amount ?? 1, unit: val }
                                    })}
                                    options={[
                                      { value: "seconds", label: "Seconds" },
                                      { value: "minutes", label: "Minutes" },
                                      { value: "hours", label: "Hours" },
                                      { value: "days", label: "Days" }
                                    ]}
                                    triggerClassName="flex-1 h-10 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                                  />
                                </div>
                              </div>
                            )}

                            {/* Mode: until */}
                            {mode === "until" && (
                              <div className="space-y-3">
                                <div className="space-y-1.5">
                                  <Label className="text-xs text-zinc-500">Date and time</Label>
                                  <Input
                                    type="datetime-local"
                                    value={s.until?.datetime ? s.until.datetime.slice(0, 16) : ""}
                                    onChange={(e) => update({
                                      until: { ...(s.until || {}), datetime: e.target.value ? new Date(e.target.value).toISOString() : null, timezone: s.until?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone }
                                    })}
                                    style={{ colorScheme: "light dark" }}
                                    className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl dark:[&::-webkit-calendar-picker-indicator]:invert"
                                  />
                                  <p className="text-[10px] text-zinc-500">
                                    Type directly (MM/DD/YYYY hh:mm AM/PM) or click the icon to pick. Stored in UTC. Timezone: <span className="font-mono">{s.until?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
                                  </p>
                                </div>

                                <div className="space-y-1.5">
                                  <Label className="text-xs text-zinc-500">If this date has already passed</Label>
                                  {[
                                    ["continue", "Continue to next action"],
                                    ["exit", "Exit contact from automation"],
                                    ["goto", "Go to specific step (by index)"],
                                    ["skip_outbound", "Skip all outbound until next wait"],
                                  ].map(([val, label]) => (
                                    <label key={val} className="flex items-center gap-2 text-xs cursor-pointer">
                                      <input
                                        type="radio"
                                        name="on_passed"
                                        checked={(s.on_passed || "continue") === val}
                                        onChange={() => update({ on_passed: val })}
                                      />
                                      <span>{label}</span>
                                    </label>
                                  ))}
                                  {s.on_passed === "goto" && (
                                    <Input
                                      type="number"
                                      min={0}
                                      placeholder="step index"
                                      value={s.on_passed_step ?? ""}
                                      onChange={(e) => update({ on_passed_step: e.target.value === "" ? null : parseInt(e.target.value) })}
                                      className="w-32 mt-1 bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                                    />
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Advance window */}
                            <div className="pt-2 border-t border-amber-500/10 space-y-3">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={!!aw.enabled}
                                  onChange={(e) => updateAW({ enabled: e.target.checked })}
                                  className="w-4 h-4 rounded border-zinc-300 dark:border-white/10 text-zinc-900 dark:text-white accent-zinc-900 dark:accent-white focus:ring-0 focus:ring-offset-0 cursor-pointer"
                                />
                                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Advance window</span>
                              </label>

                              {aw.enabled && (
                                <div className="pl-2 space-y-3">
                                  <div className="space-y-1.5">
                                    <Label className="text-[11px] text-zinc-500">Resume on</Label>
                                    <div className="flex flex-wrap gap-1.5">
                                      {DAY_KEYS.map(d => {
                                        const checked = days.includes(d)
                                        return (
                                          <button
                                            type="button"
                                            key={d}
                                            onClick={() => toggleDay(d)}
                                            className={`px-2.5 py-1 text-[11px] rounded-lg border flex items-center gap-1.5 ${checked ? "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300" : "border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/[0.02] text-zinc-600 dark:text-zinc-400"}`}
                                          >
                                            {d}
                                            <span className={`w-3 h-3 rounded-sm border flex items-center justify-center ${checked ? "bg-blue-500 border-blue-500 text-white" : "border-black/20 dark:border-white/20"}`}>
                                              {checked ? <Check className="w-2.5 h-2.5" /> : null}
                                            </span>
                                          </button>
                                        )
                                      })}
                                    </div>
                                  </div>

                                  <div className="space-y-1.5">
                                    <Label className="text-[11px] text-zinc-500">Resume between hours</Label>
                                    <div className="grid grid-cols-2 gap-2">
                                      <TypeableTimeInput
                                        value={aw.window?.start || "09:00"}
                                        onChange={(val) => updateAW({ window: { ...(aw.window || {}), start: val, end: aw.window?.end || "17:00" } })}
                                        placeholder="9:00 AM"
                                      />
                                      <TypeableTimeInput
                                        value={aw.window?.end || "17:00"}
                                        onChange={(val) => updateAW({ window: { ...(aw.window || {}), end: val, start: aw.window?.start || "09:00" } })}
                                        placeholder="5:00 PM"
                                      />
                                    </div>
                                    <p className="text-[10px] text-zinc-500">Type freely — "9 am", "21:00", "5pm", "0900" all work.</p>
                                  </div>

                                  <div className="space-y-1.5">
                                    <Label className="text-[11px] text-zinc-500">Additional filter (optional)</Label>
                                    <div className="grid grid-cols-3 gap-2">
                                      <CustomSelect
                                        value={aw.additional_filter?.type || ""}
                                        onChange={(val) => updateAW({ additional_filter: val ? { type: val, op: "is", value: null } : null })}
                                        options={[
                                          { value: "", label: "— none —" },
                                          { value: "current_day_of_month", label: "Current Day of month" },
                                          { value: "current_month", label: "Current month" },
                                          { value: "current_year", label: "Current year" }
                                        ]}
                                        triggerClassName="h-9 w-full px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                                      />
                                      <CustomSelect
                                        disabled={!aw.additional_filter?.type}
                                        value={aw.additional_filter?.op || "is"}
                                        onChange={(val) => updateAW({ additional_filter: { ...(aw.additional_filter || {}), op: val } })}
                                        options={[
                                          { value: "is", label: "Is" },
                                          { value: "is_not", label: "Is not" }
                                        ]}
                                        triggerClassName="h-9 w-full px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white disabled:opacity-50 flex items-center justify-between outline-none"
                                      />
                                      <Input
                                        disabled={!aw.additional_filter?.type}
                                        placeholder={aw.additional_filter?.type === "current_month" ? "e.g. July" : aw.additional_filter?.type === "current_day_of_month" ? "1–31" : aw.additional_filter?.type === "current_year" ? "e.g. 2026" : ""}
                                        value={aw.additional_filter?.value ?? ""}
                                        onChange={(e) => updateAW({ additional_filter: { ...(aw.additional_filter || {}), value: e.target.value } })}
                                        className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl text-xs disabled:opacity-50"
                                      />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>

                            <p className="text-[11px] text-zinc-500 border-t border-amber-500/10 pt-2">
                              {(mode === "duration" && !aw.enabled)
                                ? "Simple duration — folded into the next action's run_at for efficiency."
                                : "Preserved as a first-class step at runtime. Engine clamps run_at to the configured window."}
                            </p>
                          </div>
                        )
                      })()}

                      {/* Specific configs by type.
                          Call nodes no longer use a template binding — the
                          agent's prompt + behavior live in Retell itself,
                          picked via the Retell Voice Agent dropdown below. */}
                      {(selectedNode.step.type === "sms" || selectedNode.step.type === "email" || selectedNode.step.type === "team_alert") && (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between gap-3">
                            <Label className="text-xs font-semibold text-zinc-500 uppercase">
                              {selectedNode.step.type === "team_alert"
                                ? "Team notification"
                                : "Message content"}
                            </Label>
                            {(selectedNode.step.type === "sms" || selectedNode.step.type === "email") && (
                              <div className="grid grid-cols-2 rounded-xl border border-black/10 dark:border-white/10 bg-zinc-950/5 dark:bg-black/40 p-0.5 text-[10px] font-semibold">
                                {[
                                  { value: "template", label: "Template" },
                                  { value: "inline", label: "Write message" },
                                ].map((mode) => {
                                  const active = (selectedNode.step.content_mode || (selectedNode.step.inline_body ? "inline" : "template")) === mode.value
                                  return (
                                    <button
                                      key={mode.value}
                                      type="button"
                                      onClick={() => {
                                        if (mode.value === "inline") {
                                          handleUpdateStep(selectedNode.index, {
                                            content_mode: "inline",
                                            template_key: "",
                                            inline_body: selectedNode.step.inline_body || "",
                                          })
                                        } else {
                                          handleUpdateStep(selectedNode.index, {
                                            content_mode: "template",
                                            inline_body: "",
                                            inline_subject: "",
                                          })
                                        }
                                      }}
                                      className={`px-3 py-1.5 rounded-lg transition-colors ${
                                        active
                                          ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm"
                                          : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                                      }`}
                                    >
                                      {mode.label}
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                          {isEditingTemplate ? (
                            <div className="p-4 bg-zinc-50 dark:bg-black/40 border border-zinc-200 dark:border-white/5 rounded-2xl space-y-3">
                              <div className="space-y-1.5">
                                <Label className="text-[10px] text-zinc-400 font-bold uppercase">Template Key</Label>
                                <Input 
                                  value={tplEditForm.template_key}
                                  onChange={(e) => setTplEditForm({ ...tplEditForm, template_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                                  className="h-9 text-xs bg-white dark:bg-black border-zinc-200 dark:border-white/10 rounded-xl"
                                />
                              </div>
                              {(selectedNode.step.type === "email" || selectedNode.step.type === "team_alert") && (
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <Label className="text-[10px] text-zinc-400 font-bold uppercase">
                                      {selectedNode.step.type === "team_alert" ? "Alert Subject" : "Email Subject"}
                                    </Label>
                                    <MergeFieldInserter
                                      groups={templateMergeGroups}
                                      targetRef={tplSubjectRef}
                                      value={tplEditForm.subject || ""}
                                      onChange={(next) => setTplEditForm({ ...tplEditForm, subject: next })}
                                    />
                                  </div>
                                  <input
                                    ref={tplSubjectRef}
                                    value={tplEditForm.subject}
                                    onChange={(e) => setTplEditForm({ ...tplEditForm, subject: e.target.value })}
                                    placeholder={selectedNode.step.type === "team_alert" ? "e.g. Interested lead: {{first_name}} {{last_name}}" : "Subject line — supports {{first_name}} etc."}
                                    className="w-full h-9 px-2.5 text-xs bg-white dark:bg-black border border-zinc-200 dark:border-white/10 rounded-xl text-zinc-900 dark:text-white focus:outline-none"
                                  />
                                  <p className="text-[10px] text-zinc-500 leading-relaxed">
                                    {selectedNode.step.type === "team_alert"
                                      ? "The subject line of the alert email sent to your team (Settings → Workspace → Alert Dispatch Email)."
                                      : "The email subject the lead sees. Merge tags resolve at send time."}
                                  </p>
                                </div>
                              )}
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <Label className="text-[10px] text-zinc-400 font-bold uppercase">Body (Supports dynamic variables: {"{{first_name}}"})</Label>
                                  <MergeFieldInserter
                                    groups={templateMergeGroups}
                                    targetRef={tplBodyRef}
                                    value={tplEditForm.body || ""}
                                    onChange={(next) => setTplEditForm({ ...tplEditForm, body: next })}
                                  />
                                </div>
                                <textarea
                                  ref={tplBodyRef}
                                  value={tplEditForm.body}
                                  rows={5}
                                  onChange={(e) => setTplEditForm({ ...tplEditForm, body: e.target.value })}
                                  className="w-full p-3 text-xs bg-white dark:bg-black rounded-xl border border-zinc-200 dark:border-white/10 focus:outline-none font-sans text-zinc-900 dark:text-white"
                                />
                              </div>
                              <div className="flex justify-end gap-2">
                                <Button size="sm" variant="ghost" onClick={() => setIsEditingTemplate(false)} className="rounded-xl">Cancel</Button>
                                <Button size="sm" onClick={handleSaveTemplateInline} variant="default">Save Template</Button>
                              </div>
                            </div>
                          ) : ((selectedNode.step.type === "sms" || selectedNode.step.type === "email") && (selectedNode.step.content_mode || (selectedNode.step.inline_body ? "inline" : "template")) === "inline" ? (
                            selectedNode.step.type === "email" ? (
                              <EmailInlineComposer
                                step={selectedNode.step}
                                onUpdate={(fields) => handleUpdateStep(selectedNode.index, fields)}
                                senders={senders}
                                customFields={tenantCustomFields}
                                samples={samples}
                                webhookMappings={webhookLeadMappings}
                                onSendTest={(to) => handleSendInlineTest(selectedNode.step, to)}
                                sendingTest={sendingInlineTest}
                              />
                            ) : (
                              <div className="p-4 bg-zinc-50 dark:bg-black/40 border border-zinc-200 dark:border-white/5 rounded-2xl space-y-3">
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <Label className="text-[10px] text-zinc-400 font-bold uppercase">
                                      Body
                                    </Label>
                                    <MergeFieldInserter
                                      groups={templateMergeGroups}
                                      targetRef={smsBodyRef}
                                      value={selectedNode.step.inline_body || ""}
                                      onChange={(next) => handleUpdateStep(selectedNode.index, { inline_body: next, content_mode: "inline", template_key: "" })}
                                    />
                                  </div>
                                  <textarea
                                    ref={smsBodyRef}
                                    value={selectedNode.step.inline_body || ""}
                                    rows={6}
                                    onChange={(e) => handleUpdateStep(selectedNode.index, { inline_body: e.target.value, content_mode: "inline", template_key: "" })}
                                    placeholder="Write the message here. Merge tags like {{first_name}} resolve at send time."
                                    className="w-full p-3 text-xs bg-white dark:bg-black rounded-xl border border-zinc-200 dark:border-white/10 focus:outline-none font-sans text-zinc-900 dark:text-white"
                                  />
                                </div>
                                <p className="text-[11px] text-zinc-500">
                                  Saved on this step. Existing queued actions keep the step snapshot they were created with.
                                </p>
                              </div>
                            )
                          ) : (
                            <div className="space-y-2">
                              <div className="flex gap-2">
                                <CustomSelect 
                                  value={selectedNode.step.template_key}
                                  onChange={(val) => handleUpdateStep(selectedNode.index, { template_key: val, content_mode: "template", inline_body: "", inline_subject: "" })}
                                  options={[
                                    { value: "", label: "-- Choose template --" },
                                    ...templates.filter(t => t.channel === (selectedNode.step.type === "team_alert" ? "team_alert" : selectedNode.step.type)).map(tpl => ({
                                      value: tpl.template_key,
                                      label: `${tpl.subject || tpl.notes || "Message template"} · Key: ${tpl.template_key}`
                                    }))
                                  ]}
                                  triggerClassName="flex-1 h-10 px-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                                />
                                <Button
                                  variant="outline"
                                  onClick={() => setIsEditingTemplate(true)}
                                  className="rounded-xl border-black/10 dark:border-white/10 text-xs"
                                >
                                  Edit / Create
                                </Button>
                              </div>
                              {STEP_TYPES[selectedNode.step.type]?.helperText && (
                                <p className="text-[11px] text-zinc-500">
                                  {STEP_TYPES[selectedNode.step.type].helperText}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Retell Agent selector — call nodes only.
                          Picks which Retell agent fires this call. The selected agent_id
                          is stored on the step (`retell_agent_id`) and emitted into the
                          compiled spec; the runtime get_call_payload RPC reads it and passes
                          it through to Retell so different steps can use different agents. */}
                      {selectedNode.step.type === "call" && (
                        <div className="space-y-2 p-4 bg-blue-500/5 border border-blue-500/10 rounded-2xl">
                          <Label className="text-xs font-semibold text-zinc-500 uppercase flex items-center gap-1">
                            <PhoneCall className="w-3.5 h-3.5 text-blue-500" /> Retell Voice Agent
                          </Label>
                          {retellAgents.length === 0 ? (
                            <div className="text-[11px] text-rose-500 leading-relaxed">
                              No Retell agents registered for this tenant. Add one under
                              <span className="font-semibold"> Settings → Retell Agents</span>,
                              then come back to pick it here. Without a selected agent, this call step will fail at runtime.
                            </div>
                          ) : (
                            <>
                              <CustomSelect
                                value={selectedNode.step.retell_agent_id || ""}
                                onChange={(val) => handleUpdateStep(selectedNode.index, { retell_agent_id: val })}
                                options={[
                                  { value: "", label: "— Pick a Retell agent (required) —" },
                                  ...retellAgents.map(a => ({ value: a.agent_id, label: `${a.name} · ${a.agent_id}` }))
                                ]}
                                triggerClassName={`w-full h-10 px-3 bg-white dark:bg-black border rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between ${
                                  selectedNode.step.retell_agent_id
                                    ? "border-black/10 dark:border-white/10"
                                    : "border-rose-500/60 dark:border-rose-500/60"
                                }`}
                              />
                              {selectedNode.step.retell_agent_id ? (
                                <p className="text-[11px] text-zinc-500">
                                  Each call step targets a specific agent (e.g. speed-to-lead vs reactivation vs email-campaign). No cross-agent fallback — safer that way.
                                </p>
                              ) : (
                                <p className="text-[11px] text-rose-500">
                                  Required. If left blank, this call step will fail with "no Retell agent selected". Pick one — no silent fallback to tenant default.
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {/* Dynamic Variables — call nodes only.
                          Passed to Retell as retell_llm_dynamic_variables at call time.
                          Each value is rendered through resolve_merge_tags against the
                          lead, so {{first_name}}, {{custom.X}}, {{raw_payload.x.y}}
                          all work. followup_lead_id / lead_id / first_name are always
                          included automatically — no need to declare them here. */}
                      {selectedNode.step.type === "call" && (() => {
                        const dynVars = Array.isArray(selectedNode.step.retell_dynamic_variables)
                          ? selectedNode.step.retell_dynamic_variables
                          : []
                        const setDynVars = (next) => handleUpdateStep(selectedNode.index, {
                          retell_dynamic_variables: next,
                        })
                        return (
                          <div className="space-y-2 p-4 bg-indigo-500/5 border border-indigo-500/10 rounded-2xl">
                            <Label className="text-xs font-semibold text-zinc-500 uppercase flex items-center gap-1">
                              <Sparkles className="w-3.5 h-3.5 text-indigo-500" /> Dynamic Variables (to agent)
                            </Label>
                            <p className="text-[11px] text-zinc-500">
                              Variables your Retell agent's prompt can reference. Each key matches a
                              <code className="mx-0.5 font-mono text-[10px] bg-zinc-200/40 dark:bg-white/5 px-1 rounded">{`{{key}}`}</code>
                              in the agent's prompt. Values support merge tags like
                              <code className="mx-0.5 font-mono text-[10px] bg-zinc-200/40 dark:bg-white/5 px-1 rounded">{`{{first_name}}`}</code>,
                              <code className="mx-0.5 font-mono text-[10px] bg-zinc-200/40 dark:bg-white/5 px-1 rounded">{`{{custom.coverage_type}}`}</code>,
                              <code className="mx-0.5 font-mono text-[10px] bg-zinc-200/40 dark:bg-white/5 px-1 rounded">{`{{raw_payload.data.fields.0.value}}`}</code>.
                              <span className="block mt-1 text-zinc-400">
                                Already sent automatically: <code className="font-mono">followup_lead_id</code>, <code className="font-mono">lead_id</code>, <code className="font-mono">first_name</code>.
                              </span>
                            </p>

                            {dynVars.length === 0 && (
                              <p className="text-[11px] text-zinc-400 italic py-1">
                                No custom variables. Click "Add variable" if your agent prompt expects more than the defaults.
                              </p>
                            )}

                            <div className="space-y-1.5">
                              {dynVars.map((row, idx) => (
                                <div key={idx} className="grid grid-cols-12 gap-1.5 items-center">
                                  <Input
                                    placeholder="key (e.g. coverage_type)"
                                    value={row.key || ""}
                                    onChange={(e) => {
                                      const next = [...dynVars]
                                      next[idx] = { ...next[idx], key: e.target.value.replace(/\s+/g, "_") }
                                      setDynVars(next)
                                    }}
                                    className="col-span-5 h-8 text-[11px] font-mono bg-white dark:bg-black/40 border-black/10 dark:border-white/10 rounded-lg"
                                  />
                                  <Input
                                    placeholder="value or {{merge.tag}}"
                                    value={row.value || ""}
                                    onChange={(e) => {
                                      const next = [...dynVars]
                                      next[idx] = { ...next[idx], value: e.target.value }
                                      setDynVars(next)
                                    }}
                                    className="col-span-6 h-8 text-[11px] bg-white dark:bg-black/40 border-black/10 dark:border-white/10 rounded-lg"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setDynVars(dynVars.filter((_, i) => i !== idx))}
                                    className="col-span-1 h-7 w-7 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center justify-center"
                                    aria-label="Remove"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>

                            <button
                              type="button"
                              onClick={() => setDynVars([...dynVars, { key: "", value: "" }])}
                              className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 pt-1"
                            >
                              <Plus className="w-3.5 h-3.5" /> Add variable
                            </button>
                          </div>
                        )
                      })()}

                      {/* Outcome routing legend — driven by the step-types schema.
                          Shows for any step type with more than one outcome. */}
                      {(outcomesForStep(selectedNode.step).length || 0) > 1 && (() => {
                        const OUTCOMES = outcomesForStep(selectedNode.step)
                        const stepsByIndex = Object.fromEntries(steps.map(s => [s.index, s]))
                        const labelFor = (route) => {
                          if (!route) return 'Not connected'
                          if (route.exit) return `End journey: ${getJourneyExitDisplay(route.exit).label}`
                          const tgt = stepsByIndex[route.next_step]
                          if (!tgt) return `Step ${route.next_step}`
                          const targetDisplay = getJourneyNodeDisplay(tgt.type)
                          return `Step ${route.next_step}: ${targetDisplay.label}${tgt.template_key ? ` (${tgt.template_key})` : ''}`
                        }
                        return (
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold text-zinc-500 uppercase">Outcome routing</Label>
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                              Choose what happens after this step. Drag a line from an outcome to another step to set the branch.
                            </p>
                            <div className="space-y-1.5 bg-zinc-50 dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-xl p-2.5">
                              {OUTCOMES.map(o => {
                                const route = selectedNode.step.on_outcome?.[o.id]
                                return (
                                  <div key={o.id} className="flex items-center justify-between gap-2 py-1 text-[11px]">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span
                                        className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-black"
                                        style={{ background: o.color }}
                                        title={o.hint}
                                      />
                                      <span className="font-semibold text-zinc-900 dark:text-white">{o.label}</span>
                                      <span className="text-zinc-400 dark:text-zinc-500 truncate">— {o.hint}</span>
                                    </div>
                                    <span
                                      className={`font-mono text-[10px] whitespace-nowrap px-1.5 py-0.5 rounded ${
                                        !route
                                          ? 'text-zinc-400 bg-zinc-200/30 dark:bg-white/5'
                                          : route.exit
                                          ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10'
                                          : 'text-blue-600 dark:text-blue-400 bg-blue-500/10'
                                      }`}
                                    >
                                      {labelFor(route)}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })()}

                      {/* Webhook config */}
                      {selectedNode.step.type === "http_request" && (
                        <div className="space-y-4">
                          {/* Method + URL */}
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <Label className="text-xs font-semibold text-zinc-500 uppercase">Request</Label>
                              <MergeFieldInserter
                                groups={exprMergeGroups}
                                targetRef={httpUrlRef}
                                value={selectedNode.step.http_url || ""}
                                onChange={(next) => handleUpdateStep(selectedNode.index, { http_url: next })}
                              />
                            </div>
                            <div className="flex gap-1.5">
                              <CustomSelect
                                value={selectedNode.step.http_method || "POST"}
                                onChange={(val) => handleUpdateStep(selectedNode.index, { http_method: val })}
                                options={[
                                  { value: "GET", label: "GET" },
                                  { value: "POST", label: "POST" },
                                  ...(!["GET", "POST", "DELETE"].includes(String(selectedNode.step.http_method || "POST").toUpperCase())
                                    ? [{ value: selectedNode.step.http_method, label: `${selectedNode.step.http_method} (Unsupported)` }]
                                    : []),
                                  { value: "DELETE", label: "DELETE" }
                                ]}
                                triggerClassName="w-[104px] shrink-0 h-9 px-2.5 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl text-xs font-semibold focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                              />
                              <input
                                ref={httpUrlRef}
                                value={selectedNode.step.http_url || ""}
                                placeholder="https://api.external.com/v1/data"
                                onChange={(e) => handleUpdateStep(selectedNode.index, { http_url: e.target.value })}
                                className="flex-1 min-w-0 h-9 px-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl font-mono text-xs text-zinc-900 dark:text-white focus:outline-none"
                              />
                            </div>
                            <p className="text-[10px] text-zinc-500">PUT and PATCH are not supported by the runtime yet.</p>
                          </div>

                          <HttpQueryParamsEditor
                            key={`qp-${selectedNode.index}`}
                            url={selectedNode.step.http_url || ""}
                            onUrlChange={(next) => handleUpdateStep(selectedNode.index, { http_url: next })}
                          />

                          {/* Authentication — sugar over the Authorization header */}
                          {(() => {
                            const httpHeaders = selectedNode.step.http_headers || {}
                            const inferred = getAuthFromHeaders(httpHeaders)
                            const authType = httpAuthTypeDraft ?? inferred.type
                            const setAuth = (auth) =>
                              handleUpdateStep(selectedNode.index, { http_headers: applyAuthToHeaders(httpHeaders, auth) })
                            return (
                              <div className="space-y-2">
                                <Label className="text-xs font-semibold text-zinc-500 uppercase">Authentication</Label>
                                <CustomSelect
                                  value={authType}
                                  onChange={(val) => {
                                    setHttpAuthTypeDraft(val)
                                    if (val === "none") setAuth({ type: "none" })
                                  }}
                                  options={[
                                    { value: "none", label: "None" },
                                    { value: "bearer", label: "Bearer token" },
                                    { value: "basic", label: "Basic auth" },
                                    { value: "custom", label: "Custom Authorization header" },
                                  ]}
                                  triggerClassName="w-full h-9 px-3 bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                                />
                                {authType === "bearer" && (
                                  <Input
                                    type="password"
                                    value={inferred.type === "bearer" ? inferred.token || "" : ""}
                                    placeholder="Token (sent as Authorization: Bearer …)"
                                    onChange={(e) => setAuth({ type: "bearer", token: e.target.value })}
                                    className="bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
                                  />
                                )}
                                {authType === "basic" && (
                                  <div className="flex gap-1.5">
                                    <Input
                                      value={inferred.type === "basic" ? inferred.username || "" : ""}
                                      placeholder="Username"
                                      onChange={(e) => setAuth({ type: "basic", username: e.target.value, password: inferred.type === "basic" ? inferred.password || "" : "" })}
                                      className="flex-1 bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
                                    />
                                    <Input
                                      type="password"
                                      value={inferred.type === "basic" ? inferred.password || "" : ""}
                                      placeholder="Password"
                                      onChange={(e) => setAuth({ type: "basic", username: inferred.type === "basic" ? inferred.username || "" : "", password: e.target.value })}
                                      className="flex-1 bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
                                    />
                                  </div>
                                )}
                                {authType === "custom" && (
                                  <Input
                                    value={inferred.type === "custom" ? inferred.raw || "" : ""}
                                    placeholder={"Full header value, e.g. Token abc or ApiKey {{steps.auth.key}}"}
                                    onChange={(e) => setAuth({ type: "custom", raw: e.target.value })}
                                    className="bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
                                  />
                                )}
                                {authType !== "none" && (
                                  <p className="text-[10px] text-zinc-500">Stored as the Authorization header below — merge tokens are resolved at send time.</p>
                                )}
                              </div>
                            )
                          })()}

                          {/* HTTP Headers key-value editor */}
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold text-zinc-500 uppercase flex justify-between items-center">
                              <span>Webhook headers</span>
                              <Button 
                                variant="outline" 
                                size="sm" 
                                onClick={() => handleAddHeader(selectedNode.index)}
                                className="h-6 px-2 text-[10px] rounded-lg border-black/10 dark:border-white/10 font-bold"
                              >
                                <Plus className="w-3 h-3 mr-0.5" /> Add Row
                              </Button>
                            </Label>
                            
                            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                              {Object.entries(selectedNode.step.http_headers || {}).length === 0 ? (
                                <p className="text-[11px] text-zinc-500 italic text-center py-2 bg-black/5 dark:bg-white/5 rounded-xl border border-dashed border-black/10 dark:border-white/10">No headers defined. Click Add Row.</p>
                              ) : (
                                Object.entries(selectedNode.step.http_headers || {}).map(([key, val]) => (
                                  <div key={key} className="flex gap-1.5 items-center">
                                    <Input 
                                      value={key}
                                      placeholder="Header key"
                                      onChange={(e) => handleUpdateHeaderKey(selectedNode.index, key, e.target.value)}
                                      className="flex-1 bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
                                    />
                                    <Input 
                                      value={val}
                                      placeholder="value"
                                      onChange={(e) => handleUpdateHeaderValue(selectedNode.index, key, e.target.value)}
                                      className="flex-1 bg-white dark:bg-black h-8 text-xs font-mono rounded-lg border-black/10 dark:border-white/10"
                                    />
                                    <Button 
                                      variant="ghost" 
                                      size="sm"
                                      onClick={() => handleRemoveHeader(selectedNode.index, key)}
                                      className="h-8 w-8 p-0 rounded-lg text-red-500 hover:bg-red-500/10 shrink-0"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                          {/* Request body — POST only (the runtime sends no body on GET/DELETE) */}
                          {String(selectedNode.step.http_method || "POST").toUpperCase() === "POST" ? (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-xs font-semibold text-zinc-500 uppercase flex items-center gap-1.5">
                                  <Code className="w-4 h-4 text-zinc-400" /> Request body
                                  <span className="normal-case font-normal text-[10px] text-zinc-400">JSON</span>
                                </Label>
                                <MergeFieldInserter
                                  groups={exprMergeGroups}
                                  targetRef={httpBodyRef}
                                  value={selectedNode.step.http_body || ""}
                                  onChange={(next) => handleUpdateStep(selectedNode.index, { http_body: next })}
                                />
                              </div>
                              <textarea
                                ref={httpBodyRef}
                                value={selectedNode.step.http_body || ""}
                                rows={5}
                                placeholder={`{\n  "id": "{{lead.id}}",\n  "first_name": "{{lead.first_name}}"\n}`}
                                onChange={(e) => handleUpdateStep(selectedNode.index, { http_body: e.target.value })}
                                className="w-full p-3 text-xs bg-zinc-950/5 dark:bg-black/40 rounded-xl border border-black/10 dark:border-white/10 focus:outline-none font-mono text-zinc-900 dark:text-white"
                              />
                              {(() => {
                                const bodyLint = lintJsonBody(selectedNode.step.http_body || "")
                                if (bodyLint.valid) return (
                                  <p className="text-[10px] text-zinc-500">
                                    Sent as JSON (Content-Type: application/json unless overridden in headers). Merge tokens resolve at send time.
                                  </p>
                                )
                                return (
                                  <p className="text-[10px] text-amber-600 dark:text-amber-400">
                                    Body is not valid JSON — it will be sent as a plain JSON string. {bodyLint.error}
                                  </p>
                                )
                              })()}
                            </div>
                          ) : (
                            (selectedNode.step.http_body || "").trim() !== "" && (
                              <p className="text-[10px] text-amber-600 dark:text-amber-400">
                                This step has a saved body, but {String(selectedNode.step.http_method).toUpperCase()} requests do not send one. Switch to POST to send it.
                              </p>
                            )
                          )}

                          {/* Timeout */}
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-zinc-500 uppercase">Timeout</Label>
                            <div className="flex items-center gap-2">
                              <Input
                                type="number"
                                min={1}
                                max={30}
                                value={Math.round(clampTimeoutMs(selectedNode.step.http_timeout_ms) / 1000)}
                                onChange={(e) => {
                                  const seconds = Number(e.target.value)
                                  handleUpdateStep(selectedNode.index, {
                                    http_timeout_ms: Number.isFinite(seconds) && seconds > 0 ? clampTimeoutMs(seconds * 1000) : undefined,
                                  })
                                }}
                                className="w-24 bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl text-xs font-mono h-9"
                              />
                              <span className="text-xs text-zinc-500">seconds (1–30, default 10)</span>
                            </div>
                            <p className="text-[10px] text-zinc-500">The request fails and takes the Continue branch handling if no response arrives in time.</p>
                          </div>

                          {/* Save response as — makes the API result usable downstream */}
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-zinc-500 uppercase flex items-center gap-1">
                              Save response as (optional)
                            </Label>
                            <Input
                              value={selectedNode.step.response_var || ""}
                              placeholder="e.g. api_response"
                              onChange={(e) => handleUpdateStep(selectedNode.index, { response_var: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                              className="bg-zinc-950/5 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-xl font-mono text-xs"
                            />
                            {selectedNode.step.response_var ? (
                              <div className="text-[10px] text-zinc-500 space-y-1 bg-black/5 dark:bg-white/5 rounded-lg p-2 border border-black/5 dark:border-white/5">
                                <div>The JSON response body is saved on the lead, plus the HTTP status code as <code className="font-mono bg-black/10 dark:bg-white/10 px-1 rounded">{selectedNode.step.response_var}_status</code>. Use it downstream:</div>
                                <div>• <b>If/Else</b>: pick "HTTP response · {selectedNode.step.response_var}…" as the field, e.g. <code className="font-mono bg-black/10 dark:bg-white/10 px-1 rounded">custom.{selectedNode.step.response_var}.status</code></div>
                                <div>• <b>Webhook / HTTP steps</b>: insert <code className="font-mono bg-black/10 dark:bg-white/10 px-1 rounded">{`{{custom.${selectedNode.step.response_var}.<path>}}`}</code></div>
                                <div>• <b>SMS / Email</b>: <code className="font-mono bg-black/10 dark:bg-white/10 px-1 rounded">{`{{${selectedNode.step.response_var}}}`}</code> inserts the whole value (nested paths are not supported in messages)</div>
                              </div>
                            ) : (
                              <p className="text-[10px] text-zinc-500">
                                Name it to use the API response later — branch on it in If/Else or pass fields to other webhook steps.
                              </p>
                            )}
                          </div>

                          {/* Webhook test console panel */}
                          <div className="border border-black/10 dark:border-white/10 rounded-2xl p-4 bg-zinc-50 dark:bg-black/30 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">Webhook test</span>
                              <Button 
                                size="sm" 
                                disabled={testingHttp}
                                onClick={() => handleTestHttpRequest(selectedNode.step)}
                                className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs flex items-center gap-1.5 h-8 px-3"
                              >
                                {testingHttp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                Send test
                              </Button>
                            </div>

                            {testResponse && (
                              <div className="space-y-2 border-t border-black/5 dark:border-white/5 pt-3">
                                <div className="flex items-center gap-3 text-[11px] font-mono">
                                  <span>Status:</span>
                                  <span className={`px-2 py-0.5 rounded font-bold ${
                                    testResponse.status >= 200 && testResponse.status < 300 
                                      ? "bg-emerald-500/10 text-emerald-500" 
                                      : "bg-red-500/10 text-red-500"
                                  }`}>
                                    {testResponse.status || "Error"} {testResponse.statusText}
                                  </span>
                                  {testResponse.durationMs !== undefined && (
                                    <span className="text-zinc-500">{testResponse.durationMs}ms</span>
                                  )}
                                </div>
                                
                                <div className="space-y-1">
                                  <span className="text-[10px] text-zinc-500 font-bold block uppercase">Response Body Preview:</span>
                                  <pre className="bg-black/40 text-[10px] font-mono p-3 rounded-lg border border-white/5 max-h-40 overflow-y-auto text-zinc-300 break-all select-text">
                                    {testResponse.error ? `Error: ${testResponse.error}` : JSON.stringify(testResponse.body, null, 2)}
                                  </pre>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Add/Remove Tag config */}
                      {(selectedNode.step.type === "add_tag" || selectedNode.step.type === "remove_tag") && (
                        <div className="space-y-2">
                          <Label className="text-xs font-semibold text-zinc-500 uppercase">Tag Name</Label>
                          <TagAutocomplete 
                            value={selectedNode.step.tag_name || ""}
                            onChange={(tag_name) => handleUpdateStep(selectedNode.index, { tag_name })}
                            suggestions={existingTags}
                          />
                          <p className="text-[11px] text-zinc-500">
                            {selectedNode.step.type === "add_tag" 
                              ? "Type a new tag or select from database tag names to add to the lead." 
                              : "Select an existing tag to remove from the lead when reached."}
                          </p>

                          {existingTags.length > 0 && (
                            <div className="pt-2 border-t border-black/5 dark:border-white/10 mt-3">
                              <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                                Manage Database Tags
                              </span>
                              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 bg-zinc-950/5 dark:bg-black/20 rounded-xl">
                                {existingTags.map(tag => (
                                  <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-mono bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/5 text-zinc-700 dark:text-zinc-300">
                                    {tag}
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteTag(tag)}
                                      className="text-red-500 hover:text-red-600 font-bold ml-0.5 text-[10px] cursor-pointer"
                                    >
                                      ×
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Conditional Split — real condition builder */}
                      {selectedNode.step.type === "conditional_split" && (() => {
                        const payloadConditionOptions = triggerType === "webhook" && pinnedSample?.payload
                          ? flattenPayloadScalars(pinnedSample.payload)
                              .filter(row => row.source && row.source !== "payload")
                              .slice(0, 80)
                              .map(row => ({
                                value: row.source,
                                label: `Webhook payload · ${row.source}`,
                              }))
                          : []
                        const defaultConditionField = triggerType === "webhook" && payloadConditionOptions[0]?.value
                          ? payloadConditionOptions[0].value
                          : "tags"
                        // Response variables saved by HTTP steps in this journey — offered
                        // as ready-made fields so operators can branch on API results.
                        const httpResponseConditionOptions = steps
                          .filter(st => st.type === "http_request" && String(st.response_var || "").trim() !== "" && st.index !== selectedNode.index)
                          .flatMap(st => [
                            { value: `custom.${st.response_var}_status`, label: `HTTP response · ${st.response_var} status code` },
                            { value: `custom.${st.response_var}.`, label: `HTTP response · ${st.response_var} body field…` },
                          ])
                        const conditionFieldOptions = [
                          ...payloadConditionOptions,
                          ...httpResponseConditionOptions,
                          ...CONDITION_FIELDS.map(f => ({ value: f.key, label: `${f.group} · ${f.label}` })),
                        ]
                        const branches = Array.isArray(selectedNode.step.branches) ? selectedNode.step.branches : []
                        const branchMode = branches.length > 0
                        const defaultCondition = () => ({ combinator: "and", rules: [newRule(defaultConditionField)] })
                        const legacyCondition = selectedNode.step.condition || defaultCondition()
                        const setBranches = (nextBranches) => {
                          const allowed = new Set(outcomesForStep({ ...selectedNode.step, branches: nextBranches }).map(outcome => outcome.id))
                          const on_outcome = Object.fromEntries(
                            Object.entries(selectedNode.step.on_outcome || {}).filter(([key]) => allowed.has(key))
                          )
                          handleUpdateStep(selectedNode.index, { branches: nextBranches, on_outcome })
                        }
                        const updateBranch = (idx, patch) => {
                          setBranches(branches.map((branch, i) => i === idx ? { ...branch, ...patch } : branch))
                        }
                        const updateBranchCondition = (idx, nextCondition) => {
                          updateBranch(idx, { condition: nextCondition })
                        }
                        const addBranch = () => {
                          const nextIndex = branches.length + 1
                          setBranches([
                            ...branches,
                            {
                              id: `branch_${nextIndex}`,
                              label: `Branch ${nextIndex}`,
                              condition: defaultCondition(),
                            },
                          ])
                        }
                        const removeBranch = (idx) => {
                          setBranches(branches.filter((_, i) => i !== idx))
                        }
                        const renderRuleEditor = (cond, setCondition, labelPrefix = "Rule") => {
                          const rules = Array.isArray(cond.rules) ? cond.rules : []
                          const updateRule = (idx, patch) => {
                            const nextRules = rules.map((r, i) => i === idx ? { ...r, ...patch } : r)
                            setCondition({ ...cond, rules: nextRules })
                          }
                          const onFieldChange = (idx, newField) => {
                            let fieldKey = newField
                            if (newField === "__custom__") {
                              fieldKey = "custom."
                            }
                            const fcfg = getFieldConfig(fieldKey)
                            const op = fcfg?.operators?.[0]?.id || "equals"
                            updateRule(idx, { field: fieldKey, op, value: "" })
                          }

                          return (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <CustomSelect
                                  value={cond.combinator || "and"}
                                  onChange={(val) => setCondition({ ...cond, combinator: val })}
                                  options={[
                                    { value: "and", label: "ALL must match (AND)" },
                                    { value: "or", label: "ANY can match (OR)" }
                                  ]}
                                  triggerClassName="px-2 py-1 text-[11px] font-semibold rounded-lg bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 outline-none flex items-center justify-between gap-1.5"
                                />
                              </div>

                              {rules.length === 0 && (
                                <div className="text-[11px] italic text-zinc-400 bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/10 rounded-xl p-3 text-center">
                                  No conditions yet. Add one below.
                                </div>
                              )}
                              {rules.map((rule, idx) => {
                                const fieldKey = rule.field?.startsWith("custom.") && !conditionFieldOptions.some(o => o.value === rule.field)
                                  ? "__custom__"
                                  : rule.field
                                const fcfg = getFieldConfig(rule.field)
                                const operators = fcfg?.operators || []
                                const opCfg = operators.find(o => o.id === rule.op) || operators[0]
                                const showValueInput = opCfg && !opCfg.noValue
                                return (
                                  <div key={idx} className="space-y-1.5 bg-zinc-50 dark:bg-black/30 border border-black/5 dark:border-white/5 rounded-xl p-2.5">
                                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                                      <span>{labelPrefix} {idx + 1}</span>
                                      <button
                                        type="button"
                                        onClick={() => setCondition({ ...cond, rules: rules.filter((_, i) => i !== idx) })}
                                        className="p-1 rounded hover:bg-red-500/10 text-red-500"
                                        title="Remove rule"
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>

                                    <CustomSelect
                                      value={fieldKey || "tags"}
                                      onChange={(val) => onFieldChange(idx, val)}
                                      options={conditionFieldOptions}
                                      triggerClassName="w-full h-8 text-xs px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-lg outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                                    />

                                    {rule.field?.startsWith("custom.") && (
                                      <Input
                                        placeholder="key or nested path (e.g. api_response.status)"
                                        value={rule.field.substring(7)}
                                        onChange={(e) => updateRule(idx, { field: "custom." + e.target.value.replace(/[^A-Za-z0-9_.\[\]]/g, "") })}
                                        className="h-8 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg font-mono"
                                      />
                                    )}

                                    <CustomSelect
                                      value={rule.op}
                                      onChange={(val) => updateRule(idx, { op: val, value: operators.find(o => o.id === val)?.noValue ? "" : rule.value })}
                                      options={operators.map(o => ({ value: o.id, label: o.label }))}
                                      triggerClassName="w-full h-8 text-xs px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-lg outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                                    />

                                    {showValueInput && fcfg?.valueType === "tag" && (
                                      <>
                                        {(rule.op === "includes_any" || rule.op === "includes_all") ? (
                                          <Input
                                            placeholder="tag1, tag2, tag3"
                                            value={Array.isArray(rule.value) ? rule.value.join(", ") : (rule.value || "")}
                                            onChange={(e) => updateRule(idx, { value: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                                            className="h-8 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg font-mono"
                                          />
                                        ) : (
                                          <Input
                                            placeholder="tag name"
                                            value={rule.value || ""}
                                            onChange={(e) => updateRule(idx, { value: e.target.value })}
                                            className="h-8 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg font-mono"
                                            list={`tag-suggestions-${selectedNode.index}-${labelPrefix}-${idx}`}
                                          />
                                        )}
                                        <datalist id={`tag-suggestions-${selectedNode.index}-${labelPrefix}-${idx}`}>
                                          {existingTags.map(t => (<option key={t} value={t} />))}
                                        </datalist>
                                      </>
                                    )}
                                    {showValueInput && fcfg?.valueType === "enum" && (
                                      <CustomSelect
                                        value={rule.value || ""}
                                        onChange={(val) => updateRule(idx, { value: val })}
                                        options={[
                                          { value: "", label: "- pick a value -" },
                                          ...(fcfg.options || []).map(opt => ({
                                            value: opt,
                                            label: rule.field === "journey_status" ? getJourneyStatusDisplay(opt).label : opt,
                                          }))
                                        ]}
                                        triggerClassName="w-full h-8 text-xs px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-lg outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                                      />
                                    )}
                                    {showValueInput && fcfg?.valueType === "number" && (
                                      <Input
                                        type="number"
                                        value={rule.value ?? ""}
                                        onChange={(e) => updateRule(idx, { value: e.target.value === "" ? "" : Number(e.target.value) })}
                                        className="h-8 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg font-mono"
                                      />
                                    )}
                                    {showValueInput && (fcfg?.valueType === "string" || (rule.field?.startsWith("custom.") && fcfg?.valueType !== "tag")) && (
                                      <Input
                                        value={rule.value || ""}
                                        onChange={(e) => updateRule(idx, { value: e.target.value })}
                                        className="h-8 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg"
                                      />
                                    )}
                                  </div>
                                )
                              })}

                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setCondition({ ...cond, rules: [...rules, newRule(defaultConditionField)] })}
                                className="w-full rounded-xl border-cyan-500/30 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10 text-xs"
                              >
                                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Condition
                              </Button>
                            </div>
                          )
                        }

                        return (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-semibold text-zinc-500 uppercase flex items-center gap-1.5">
                                <GitMerge className="w-4 h-4 text-cyan-500" /> {branchMode ? "Branch conditions" : "Condition for \"Yes\" branch"}
                              </Label>
                              {!branchMode && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={addBranch}
                                  variant="outline"
                                >
                                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add branches
                                </Button>
                              )}
                            </div>

                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                              {branchMode
                                ? "Branches are checked top to bottom. The first match runs; otherwise Else runs."
                                : <>If the condition is true, the automation follows the <span className="text-emerald-500 font-bold">Yes</span> branch. Otherwise it follows the <span className="text-red-500 font-bold">No</span> branch.</>}
                              {triggerType === "webhook" && " Webhook payload fields can be used before a lead exists."}
                            </p>

                            {!branchMode && renderRuleEditor(legacyCondition, (next) => handleUpdateStep(selectedNode.index, { condition: next }))}

                            {branchMode && (
                              <div className="space-y-3">
                                {branches.map((branch, idx) => (
                                  <div key={branch.id || idx} className="space-y-3 rounded-xl border border-black/10 dark:border-white/10 bg-zinc-50 dark:bg-black/30 p-3">
                                    <div className="flex items-center gap-2">
                                      <Input
                                        value={branch.label || ""}
                                        onChange={(e) => updateBranch(idx, { label: e.target.value })}
                                        placeholder={`Branch ${idx + 1}`}
                                        className="h-8 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg"
                                      />
                                      <Input
                                        value={branch.id || ""}
                                        onChange={(e) => updateBranch(idx, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                                        placeholder={`branch_${idx + 1}`}
                                        className="h-8 w-28 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg font-mono"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => removeBranch(idx)}
                                        className="p-2 rounded-lg hover:bg-red-500/10 text-red-500"
                                        title="Remove branch"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                    {renderRuleEditor(branch.condition || defaultCondition(), (next) => updateBranchCondition(idx, next), "Branch rule")}
                                  </div>
                                ))}

                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={addBranch}
                                  variant="outline"
                                >
                                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Branch
                                </Button>
                              </div>
                            )}

                            <details className="text-[10px] text-zinc-400 dark:text-zinc-500">
                              <summary className="cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300">Saved split (debug)</summary>
                              <pre className="mt-1 font-mono bg-black/40 text-zinc-300 p-2 rounded-md overflow-x-auto">{JSON.stringify(branchMode ? branches : legacyCondition, null, 2)}</pre>
                            </details>
                          </div>
                        )
                      })()}

                      {selectedNode.step.type === "ab_split" && (() => {
                        const percentA = Math.max(0, Math.min(100, Number(selectedNode.step.split_percent_a ?? 50) || 0))
                        const setPercentA = (value) => {
                          const next = Math.max(0, Math.min(100, Number(value) || 0))
                          handleUpdateStep(selectedNode.index, { split_percent_a: next })
                        }

                        return (
                          <div className="space-y-4">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-semibold text-zinc-500 uppercase flex items-center gap-1.5">
                                <GitFork className="w-4 h-4 text-fuchsia-500" /> A/B allocation
                              </Label>
                              <div className="text-xs font-semibold text-fuchsia-500">
                                A {percentA}% / B {100 - percentA}%
                              </div>
                            </div>

                            <div className="rounded-xl border border-black/10 dark:border-white/10 bg-zinc-50 dark:bg-black/30 p-3 space-y-3">
                              <input
                                type="range"
                                min="0"
                                max="100"
                                step="1"
                                value={percentA}
                                onChange={(e) => setPercentA(e.target.value)}
                                className="w-full accent-fuchsia-500"
                              />
                              <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                  <Label className="text-[10px] text-zinc-400 font-bold uppercase">Variant A</Label>
                                  <Input
                                    type="number"
                                    min="0"
                                    max="100"
                                    value={percentA}
                                    onChange={(e) => setPercentA(e.target.value)}
                                    className="h-9 text-xs bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-lg"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-[10px] text-zinc-400 font-bold uppercase">Variant B</Label>
                                  <Input
                                    type="number"
                                    value={100 - percentA}
                                    readOnly
                                    className="h-9 text-xs bg-white/60 dark:bg-black/40 border-black/10 dark:border-white/10 rounded-lg"
                                  />
                                </div>
                              </div>
                              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                Assignment is deterministic for each lead or event run at this step.
                              </p>
                            </div>
                          </div>
                        )
                      })()}

                      {/* Webhook-triggered Create Lead config */}
                      {selectedNode.step.type === "create_lead_from_payload" && (() => {
                        const s = selectedNode.step
                        const mappings = Array.isArray(s.field_mappings) ? s.field_mappings : []
                        const tags = Array.isArray(s.tags) ? s.tags : []
                        const staticTags = tags
                          .map((tag) => tag?.static)
                          .filter(Boolean)
                          .join(", ")
                        const stdFields = [
                          { value: "first_name", label: "First name" },
                          { value: "last_name", label: "Last name" },
                          { value: "email", label: "Email" },
                          { value: "phone", label: "Phone" },
                          { value: "source", label: "Source" },
                        ]
                        const customFieldOptions = (tenantCustomFields || [])
                          .filter((field) => field.active !== false)
                          .map((field) => ({ value: `custom.${field.key}`, label: `Custom: ${field.label || field.key}` }))
                        const destinationOptions = [...stdFields, ...customFieldOptions]
                        const setMappings = (next) => handleUpdateStep(selectedNode.index, { field_mappings: next })
                        const sourceMode = (source) => source?.static !== undefined ? "static" : "source"
                        const sourceValue = (source) => source?.static !== undefined ? source.static : source?.source || ""
                        const setStaticTags = (value) => {
                          const nextTags = value
                            .split(",")
                            .map((tag) => tag.trim())
                            .filter(Boolean)
                            .map((tag) => ({ static: tag }))
                          handleUpdateStep(selectedNode.index, { tags: nextTags })
                        }

                        return (
                          <div className="p-4 bg-violet-500/5 border border-violet-500/10 rounded-2xl space-y-4">
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-violet-500 uppercase flex items-center gap-1">
                                <UserPlus className="w-4 h-4" /> Create Lead
                              </Label>
                              <p className="text-[11px] text-zinc-500">Create or match a lead using data from the webhook payload.</p>
                              <p className="text-[11px] text-zinc-500">Choose which webhook values become lead fields.</p>
                            </div>

                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Duplicate handling</Label>
                              <CustomSelect
                                value={s.duplicate_mode || "skip_existing"}
                                onChange={(duplicate_mode) => handleUpdateStep(selectedNode.index, { duplicate_mode })}
                                options={[
                                  { value: "skip_existing", label: "Skip existing leads" },
                                  { value: "update_missing", label: "Update missing fields only" },
                                  { value: "overwrite_mapped", label: "Overwrite mapped fields" },
                                ]}
                                triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                              />
                            </div>

                            <DetectedPayloadFieldsMapper
                              sample={pinnedSample}
                              onLeadMapping={assignPayloadSourceToCreateLead}
                              createLeadAvailable={true}
                              onAssign={(targetKey, path) => {
                                setHasUnsavedChanges(true)
                                setVariables(prev => {
                                  const idx = prev.findIndex(v => v.key === targetKey)
                                  if (idx >= 0) {
                                    const next = [...prev]
                                    next[idx] = { ...next[idx], path }
                                    return next
                                  }
                                  return [...prev, { key: targetKey, path, isStandard: false }]
                                })
                              }}
                            />

                            <div className="space-y-2">
                              <Label className="text-xs text-zinc-500">Field mappings</Label>
                              {mappings.map((mapping, idx) => {
                                const mode = sourceMode(mapping.source)
                                return (
                                  <div key={idx} className="space-y-2 border border-black/5 dark:border-white/5 rounded-xl p-2.5">
                                    <CustomSelect
                                      value={mapping.destination || ""}
                                      onChange={(destination) => {
                                        const next = [...mappings]
                                        next[idx] = { ...next[idx], destination }
                                        setMappings(next)
                                      }}
                                      options={destinationOptions}
                                      placeholder="Destination field"
                                      triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                                    />
                                    <div className="grid grid-cols-[110px_1fr] gap-2">
                                      <CustomSelect
                                        value={mode}
                                        onChange={(nextMode) => {
                                          const next = [...mappings]
                                          const currentValue = sourceValue(mapping.source)
                                          next[idx] = {
                                            ...next[idx],
                                            source: nextMode === "static" ? { static: currentValue } : { source: currentValue || "payload." },
                                          }
                                          setMappings(next)
                                        }}
                                        options={[
                                          { value: "source", label: "Payload path" },
                                          { value: "static", label: "Static value" },
                                        ]}
                                        triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                                      />
                                      <Input
                                        value={sourceValue(mapping.source)}
                                        placeholder={mode === "static" ? "Webhook" : "payload.data.fields[2].value"}
                                        onChange={(e) => {
                                          const next = [...mappings]
                                          next[idx] = {
                                            ...next[idx],
                                            source: mode === "static" ? { static: e.target.value } : { source: e.target.value },
                                          }
                                          setMappings(next)
                                        }}
                                        className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                                      />
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => setMappings(mappings.filter((_, i) => i !== idx))}
                                      className="text-[10px] text-rose-500 hover:underline flex items-center gap-1"
                                    >
                                      <Trash2 className="w-3 h-3" /> Remove
                                    </button>
                                  </div>
                                )
                              })}
                              <button
                                type="button"
                                onClick={() => setMappings([...mappings, { destination: "email", source: { source: "payload.data.fields[0].value" } }])}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                              >
                                <Plus className="w-3.5 h-3.5" /> Add mapping
                              </button>
                            </div>

                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Static tags</Label>
                              <Input
                                value={staticTags}
                                placeholder="webhook, inbound"
                                onChange={(e) => setStaticTags(e.target.value)}
                                className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                              />
                            </div>

                            <p className="text-[11px] text-zinc-500 border-t border-violet-500/10 pt-2">
                              Webhook-triggered automations queue this action from the webhook. After a lead is created or matched, tags, email, SMS, calls, waits, and team alerts can continue through the lead action engine.
                            </p>
                          </div>
                        )
                      })()}

                      {/* Create Lead / Update Lead — shared multi-field config */}
                      {(selectedNode.step.type === "create_lead" || selectedNode.step.type === "update_lead") && (() => {
                        const s = selectedNode.step
                        const isUpdate = s.type === "update_lead"
                        // Standard fields the leads table supports natively.
                        const STD_FIELDS = [
                          { key: "first_name",     label: "First name" },
                          { key: "last_name",      label: "Last name" },
                          { key: "email",          label: "Email" },
                          { key: "phone",          label: "Phone" },
                          { key: "campaign_type",  label: "Enrollment Type" },
                          { key: "source",         label: "Source" },
                          { key: "zip_code",       label: "ZIP code" },
                          { key: "address",        label: "Address" },
                          { key: "timezone",       label: "Timezone" },
                        ]
                        // Backwards-compat: legacy update_lead with single update_field/update_value
                        // is surfaced as the first row in the new fields array.
                        let fields = Array.isArray(s.fields) ? s.fields : []
                        if (isUpdate && fields.length === 0 && s.update_field) {
                          fields = [{ key: s.update_field, value: s.update_value || "" }]
                        }
                        const setFields = (next) => handleUpdateStep(selectedNode.index, {
                          fields: next,
                          update_field: undefined,
                          update_value: undefined,
                        })
                        const usedKeys = new Set(fields.map(f => f.key))
                        const customKeys = (tenantCustomFields || [])
                          .filter(f => f.active !== false)
                          .map(f => ({ key: `custom.${f.key}`, label: f.label }))
                        const allOptions = [...STD_FIELDS, ...customKeys]
                        const Icon = isUpdate ? Database : UserPlus
                        const title = isUpdate ? "Update Lead" : "Create/update lead"
                        const placeholder = isUpdate ? "e.g. Apply Retell extracted data" : "e.g. Set fields from webhook data"
                        const accentClass = isUpdate ? "indigo" : "violet"
                        // Action type — only meaningful on update_lead. Create implicitly sets.
                        const mode = isUpdate ? (s.mode || "set") : "set"
                        return (
                          <div className={`p-4 bg-${accentClass}-500/5 border border-${accentClass}-500/10 rounded-2xl space-y-3`}>
                            <Label className={`text-xs font-semibold text-${accentClass}-500 uppercase flex items-center gap-1`}>
                              <Icon className="w-4 h-4" /> {title}
                            </Label>

                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Action name</Label>
                              <Input
                                value={s.action_name || ""}
                                placeholder={placeholder}
                                onChange={(e) => handleUpdateStep(selectedNode.index, { action_name: e.target.value })}
                                className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                              />
                            </div>

                            {isUpdate && (
                              <div className="space-y-1.5">
                                <Label className="text-xs text-zinc-500">Action type</Label>
                                <CustomSelect
                                   value={mode}
                                   onChange={(val) => handleUpdateStep(selectedNode.index, { mode: val })}
                                   options={[
                                     { value: "set", label: "Update field data" },
                                     { value: "clear", label: "Clear field data" }
                                   ]}
                                   triggerClassName="w-full h-9 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                                 />
                                <p className="text-[10px] text-zinc-500">
                                  {mode === "clear"
                                    ? "Sets each selected field to empty / NULL. Required and protected fields are skipped."
                                    : "Writes new values to each selected field. Empty values are skipped — they won't overwrite existing data."}
                                </p>
                              </div>
                            )}

                            <div className="space-y-2">
                              <Label className="text-xs text-zinc-500">Fields</Label>
                              {fields.length === 0 && (
                                <p className="text-[11px] text-zinc-500 italic">
                                  No fields yet. {mode === "clear" ? "Pick fields to clear." : "Add at least one field mapping."}
                                </p>
                              )}
                              {fields.map((row, idx) => (
                                <div key={idx} className="space-y-1.5 border border-black/5 dark:border-white/5 rounded-xl p-2.5">
                                  <SearchableFieldPicker
                                    value={row.key}
                                    options={STD_FIELDS}
                                    customOptions={customKeys}
                                    usedKeys={usedKeys}
                                    onChange={(k) => {
                                      const next = [...fields]
                                      next[idx] = { ...next[idx], key: k }
                                      setFields(next)
                                    }}
                                  />
                                  {mode === "set" && row.key && (
                                    <FieldValueInput
                                      fieldKey={row.key}
                                      value={row.value}
                                      customFieldsSchema={tenantCustomFields}
                                      samples={samples}
                                      onChange={(v) => {
                                        const next = [...fields]
                                        next[idx] = { ...next[idx], value: v }
                                        setFields(next)
                                      }}
                                    />
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setFields(fields.filter((_, i) => i !== idx))}
                                    className="text-[10px] text-rose-500 hover:underline flex items-center gap-1"
                                  >
                                    <Trash2 className="w-3 h-3" /> Remove
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() => setFields([...fields, { key: "", value: "" }])}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                              >
                                <Plus className="w-3.5 h-3.5" /> Add field
                              </button>
                              {allOptions.length === 0 && (
                                <a href="/settings/custom-fields" target="_blank" className="block text-[11px] text-blue-600 dark:text-blue-400 hover:underline">+ Create a custom field</a>
                              )}
                            </div>

                            <p className={`text-[11px] text-zinc-500 border-t border-${accentClass}-500/10 pt-2`}>
                              {mode === "clear"
                                ? "Clears the listed fields on the current journey lead."
                                : <>Applies field values to the current journey lead. Idempotent — empty values won't overwrite existing data. Merge tags resolve against the lead (e.g. <span className="font-mono">{`{{first_name}}`}</span>, <span className="font-mono">{`{{custom.X}}`}</span>) and the webhook payload via <span className="font-mono">{`{{raw_payload.path}}`}</span>.</>}
                            </p>
                          </div>
                        )
                      })()}

                      {/* Find Lead Node config */}
                      {selectedNode.step.type === "find_lead" && (() => {
                        const s = selectedNode.step
                        const FILTER_FIELDS = [
                          { key: "email",       label: "Email" },
                          { key: "phone",       label: "Phone" },
                          { key: "first_name",  label: "First name" },
                          { key: "last_name",   label: "Last name" },
                        ]
                        const filters = Array.isArray(s.filters) ? s.filters : []
                        const setFilters = (next) => handleUpdateStep(selectedNode.index, { filters: next })
                        const customKeys = (tenantCustomFields || [])
                          .filter(f => f.active !== false)
                          .map(f => ({ key: `custom.${f.key}`, label: f.label }))
                        return (
                          <div className="p-4 bg-violet-500/5 border border-violet-500/10 rounded-2xl space-y-3">
                            <Label className="text-xs font-semibold text-violet-500 uppercase flex items-center gap-1">
                              <UserSearch className="w-4 h-4" /> Find Lead
                            </Label>

                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Action name</Label>
                              <Input
                                value={s.action_name || ""}
                                placeholder="e.g. Find Lead by Phone"
                                onChange={(e) => handleUpdateStep(selectedNode.index, { action_name: e.target.value })}
                                className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                              />
                            </div>

                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Match strategy</Label>
                              <CustomSelect
                                value={s.match_strategy || "all"}
                                onChange={(val) => handleUpdateStep(selectedNode.index, { match_strategy: val })}
                                options={[
                                  { value: "all", label: "Match ALL filters (AND)" },
                                  { value: "any", label: "Match ANY filter (OR)" }
                                ]}
                                triggerClassName="w-full h-9 px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                              />
                            </div>

                            <div className="space-y-2">
                              <Label className="text-xs text-zinc-500">Filters</Label>
                              {filters.length === 0 && (
                                <p className="text-[11px] text-zinc-500 italic">No filters yet — branch will always evaluate as "not_found".</p>
                              )}
                              {filters.map((row, idx) => (
                                <div key={idx} className="space-y-1.5 border border-black/5 dark:border-white/5 rounded-xl p-2.5">
                                  <CustomSelect
                                    value={row.key || ""}
                                    onChange={(val) => {
                                      const next = [...filters]
                                      next[idx] = { ...next[idx], key: val }
                                      setFilters(next)
                                    }}
                                    options={[
                                      { value: "", label: "— pick a field —" },
                                      ...FILTER_FIELDS.map(f => ({ value: f.key, label: `Standard · ${f.label}` })),
                                      ...customKeys.map(f => ({ value: f.key, label: `Custom · ${f.label}` }))
                                    ]}
                                    triggerClassName="w-full h-9 px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                                  />
                                  <Input
                                    value={row.value || ""}
                                    placeholder={`Value or {{merge.tag}}`}
                                    onChange={(e) => {
                                      const next = [...filters]
                                      next[idx] = { ...next[idx], value: e.target.value }
                                      setFilters(next)
                                    }}
                                    className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl text-xs"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setFilters(filters.filter((_, i) => i !== idx))}
                                    className="text-[10px] text-rose-500 hover:underline flex items-center gap-1"
                                  >
                                    <Trash2 className="w-3 h-3" /> Remove
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() => setFilters([...filters, { key: "", value: "" }])}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                              >
                                <Plus className="w-3.5 h-3.5" /> Add filter
                              </button>
                            </div>

                            <p className="text-[11px] text-zinc-500 border-t border-violet-500/10 pt-2">
                              Searches the tenant's lead pool. Outputs "Found" / "Not found". Merge tags resolve against the current journey lead, e.g. <span className="font-mono">{`{{email}}`}</span>, <span className="font-mono">{`{{phone_e164}}`}</span>, <span className="font-mono">{`{{custom.X}}`}</span>.
                            </p>
                          </div>
                        )
                      })()}

                      {/* Find Lead from Payload Node config */}
                      {selectedNode.step.type === "find_lead_from_payload" && (() => {
                        const s = selectedNode.step
                        const SEARCH_FIELDS = [
                          { key: "email", label: "Email" },
                          { key: "phone", label: "Phone" },
                        ]
                        const search = Array.isArray(s.search) ? s.search : []
                        const setSearch = (next) => handleUpdateStep(selectedNode.index, { search: next })
                        return (
                          <div className="p-4 bg-violet-500/5 border border-violet-500/10 rounded-2xl space-y-3">
                            <Label className="text-xs font-semibold text-violet-500 uppercase flex items-center gap-1">
                              <UserSearch className="w-4 h-4" /> Find Lead
                            </Label>

                            <div className="space-y-1.5">
                              <Label className="text-xs text-zinc-500">Action name</Label>
                              <Input
                                value={s.action_name || ""}
                                placeholder="e.g. Find Lead by Email"
                                onChange={(e) => handleUpdateStep(selectedNode.index, { action_name: e.target.value })}
                                className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                              />
                            </div>

                            <div className="space-y-2">
                              <Label className="text-xs text-zinc-500">Search by</Label>
                              {search.length === 0 && (
                                <p className="text-[11px] text-zinc-500 italic">No search configured — branch will always evaluate as "Not found".</p>
                              )}
                              {search.map((row, idx) => (
                                <div key={idx} className="space-y-1.5 border border-black/5 dark:border-white/5 rounded-xl p-2.5">
                                  <CustomSelect
                                    value={row.field || ""}
                                    onChange={(val) => {
                                      const next = [...search]
                                      next[idx] = { ...next[idx], field: val }
                                      setSearch(next)
                                    }}
                                    options={[
                                      { value: "", label: "— pick a field —" },
                                      ...SEARCH_FIELDS.map(f => ({ value: f.key, label: f.label }))
                                    ]}
                                    triggerClassName="w-full h-9 px-2 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs text-zinc-900 dark:text-white flex items-center justify-between outline-none"
                                  />
                                  <Input
                                    value={row.source?.source || ""}
                                    placeholder="payload.email"
                                    onChange={(e) => {
                                      const next = [...search]
                                      next[idx] = { ...next[idx], source: { source: e.target.value } }
                                      setSearch(next)
                                    }}
                                    className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl text-xs"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setSearch(search.filter((_, i) => i !== idx))}
                                    className="text-[10px] text-rose-500 hover:underline flex items-center gap-1"
                                  >
                                    <Trash2 className="w-3 h-3" /> Remove
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() => setSearch([...search, { field: "", source: { source: "" } }])}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                              >
                                <Plus className="w-3.5 h-3.5" /> Add search field
                              </button>
                            </div>

                            <p className="text-[11px] text-zinc-500 border-t border-violet-500/10 pt-2">
                              Looks up an existing lead using webhook payload data. Outputs "Found" (lead attached to run) or "Not found" (no lead created).
                            </p>
                          </div>
                        )
                      })()}

                      {/* Wait for Reply Node config */}
                      {selectedNode.step.type === "wait_reply" && (
                        <div className="p-4 bg-amber-500/5 border border-amber-500/10 rounded-2xl space-y-3">
                          <Label className="text-xs font-semibold text-amber-500 uppercase flex items-center gap-1">
                            <Clock className="w-4 h-4" /> Reply Timeout Configuration
                          </Label>
                          <div className="flex gap-2">
                            <Input 
                              type="number"
                              value={selectedNode.step.delay?.amount ?? 12}
                              min={1}
                              onChange={(e) => handleUpdateStep(selectedNode.index, {
                                delay: { ...(selectedNode.step.delay || { unit: "hours" }), amount: Math.max(1, parseInt(e.target.value) || 1) }
                              })}
                              className="w-24 bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
                            />
                            <CustomSelect 
                              value={selectedNode.step.delay?.unit ?? "hours"}
                              onChange={(val) => handleUpdateStep(selectedNode.index, {
                                delay: { ...(selectedNode.step.delay || { amount: 12 }), unit: val }
                              })}
                              options={[
                                { value: "minutes", label: "Minutes" },
                                { value: "hours", label: "Hours" },
                                { value: "days", label: "Days" }
                              ]}
                              triggerClassName="flex-1 h-10 px-3 bg-white dark:bg-black border border-black/10 dark:border-white/10 rounded-xl text-xs focus:outline-none text-zinc-900 dark:text-white flex items-center justify-between"
                            />
                          </div>
                          <p className="text-[11px] text-zinc-500">
                            The flow branches depending on whether the lead replies before this timeout duration completes.
                          </p>
                        </div>
                      )}

                      {/* Exit Flow Node Config */}
                      {selectedNode.step.type === "exit_flow" && (
                        <div className="space-y-3 bg-red-500/5 border border-red-500/10 p-4 rounded-xl text-center">
                          <X className="w-8 h-8 text-red-500 mx-auto mb-2" />
                          <h4 className="font-semibold text-sm text-zinc-900 dark:text-white">End Journey</h4>
                          <p className="text-xs text-zinc-500">
                            Stop follow-up for this lead. Connect any outcome here when no further steps should run.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Drawer Footer controls */}
                <div className="p-4 border-t border-black/5 dark:border-white/5 flex justify-between gap-3 bg-zinc-50 dark:bg-black/20">
                  {selectedNode.type === "step" && (
                    <Button 
                      variant="ghost" 
                      onClick={() => {
                        handleDeleteStep(selectedNode.index)
                      }}
                      className="text-red-500 hover:bg-red-500/10 rounded-xl text-xs"
                    >
                      Delete Node
                    </Button>
                  )}
                  <Button 
                    onClick={() => setIsDrawerOpen(false)}
                    className="ml-auto bg-zinc-900 text-white dark:bg-white dark:text-black rounded-xl px-5 py-2 hover:opacity-95 text-xs font-semibold"
                  >
                    Close & Apply
                  </Button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
        <SampleInspectorModal
          sample={inspectedSample}
          onClose={() => setInspectedSample(null)}
          onReplay={replaySample}
          variables={variables}
          onLeadMapping={assignPayloadSourceToCreateLead}
          createLeadAvailable={steps.some((step) => step.type === "create_lead_from_payload")}
          hasUnsavedChanges={hasUnsavedChanges}
          pinnedSampleId={pinnedSampleId}
          onPin={(sampleId) => {
            setPinnedSampleId(sampleId)
            setHasUnsavedChanges(true)
          }}
          onAssign={assignVariablePath}
          onViewExecution={handleViewSampleExecution}
        />
        <SaveJourneyModal
          onFocusStep={handleFocusStep}
          isOpen={isSaveModalOpen}
          onClose={() => setIsSaveModalOpen(false)}
          validation={journeyReadiness}
          onSave={() => handleSaveJourney()}
          saving={saving}
        />
      </div>
    </div>
  )
}

export default function JourneyBuilderPage() {
  return (
    <Suspense fallback={
      <div className="p-16 flex flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
        <p className="text-zinc-500 dark:text-zinc-400 text-sm">Initializing builder...</p>
      </div>
    }>
      <ReactFlowProvider>
        <JourneyBuilderContent />
      </ReactFlowProvider>
    </Suspense>
  )
}
