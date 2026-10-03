"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, Search } from "lucide-react"
import { STEP_TYPES } from "@/lib/journeyStepTypes"
import { ADD_STEP_CATEGORIES, paletteLabelFor, getWebhookActionDisabledReason } from "../lib/palette"
import { resolveStepIcon } from "./canvasNodes"

// One-line hint for a step type. Prefers the registry's helperText; otherwise
// summarises its outcomes. Never a hardcoded label — pulled from the registry.
function hintFor(cfg) {
  if (cfg.helperText) return cfg.helperText
  const outcomes = cfg.outcomes || []
  if (outcomes.length > 1) return outcomes.map((o) => o.label).join(" · ")
  return ""
}

/**
 * Categorised, searchable action picker for the guided "+" flow.
 *
 * @param {boolean} open
 * @param {"lead_enrolled"|"tag_added"|"webhook"|string} triggerType
 * @param {boolean} hasLeadContext - webhook journeys only: a lead is established
 * @param {(type:string)=>void} onPick
 * @param {()=>void} onClose
 */
export function AddStepPicker({ open, triggerType, hasLeadContext, onPick, onClose }) {
  const [query, setQuery] = useState("")
  const inputRef = useRef(null)
  const isWebhook = triggerType === "webhook"

  // Reset the filter and focus the search each time the picker opens.
  useEffect(() => {
    if (open) {
      setQuery("")
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Escape closes the picker, matching the app's other modals/drawers.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === "Escape") onClose?.() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const categories = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ADD_STEP_CATEGORIES.map((cat) => {
      const items = cat.types
        .filter((type) => STEP_TYPES[type]) // only registered types
        .map((type) => {
          const cfg = STEP_TYPES[type]
          const label = paletteLabelFor(type, cfg)
          const disabledReason = isWebhook ? getWebhookActionDisabledReason(type, hasLeadContext) : null
          return { type, cfg, label, hint: hintFor(cfg), disabledReason }
        })
        .filter((item) => !q || item.label.toLowerCase().includes(q))
      return { ...cat, items }
    }).filter((cat) => cat.items.length > 0)
  }, [query, isWebhook, hasLeadContext])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center p-4 sm:pt-24 bg-black/40 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Add a step"
          >
            {/* Header + search */}
            <div className="p-4 border-b border-black/5 dark:border-white/5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-zinc-900 dark:text-white">Add a step</h2>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1 rounded-lg text-zinc-400 hover:bg-zinc-500/10"
                  title="Close"
                  aria-label="Close step picker"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search actions…"
                  className="w-full pl-9 pr-3 py-2 rounded-xl border border-black/10 dark:border-white/10 bg-zinc-50 dark:bg-zinc-950 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
            </div>

            {/* Categorised list */}
            <div className="overflow-y-auto p-2">
              {categories.length === 0 && (
                <div className="p-6 text-center text-sm text-zinc-400">No actions match “{query}”.</div>
              )}
              {categories.map((cat) => (
                <div key={cat.id} className="mb-2">
                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    {cat.label}
                  </div>
                  {cat.items.map((item) => {
                    const Icon = resolveStepIcon(item.cfg.icon)
                    const disabled = Boolean(item.disabledReason)
                    return (
                      <button
                        key={item.type}
                        type="button"
                        disabled={disabled}
                        title={item.disabledReason || undefined}
                        onClick={() => !disabled && onPick(item.type)}
                        className={`w-full text-left px-2 py-2 rounded-xl flex items-start gap-3 transition-colors ${
                          disabled
                            ? "opacity-50 cursor-not-allowed"
                            : "hover:bg-indigo-500/10"
                        }`}
                      >
                        <span className={`p-2 rounded-lg shrink-0 ${item.cfg.iconClass || "bg-zinc-500/10 text-zinc-500"}`}>
                          <Icon className="w-4 h-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-zinc-900 dark:text-white truncate">
                            {item.label}
                          </span>
                          <span className="block text-[11px] text-zinc-400 dark:text-zinc-500 leading-snug line-clamp-1">
                            {disabled ? item.disabledReason : item.hint}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
