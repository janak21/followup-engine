"use client"

// Promise-based confirmation dialog. One provider is mounted at the app root
// (see app/layout.jsx). Pages call it as a drop-in async replacement for the
// native, blocking window.confirm():
//
//   const confirm = useConfirm()
//   if (!(await confirm({ title, message, destructive: true }))) return
//
// Options:
//   title        heading text (default "Are you sure?")
//   message      body text — \n is preserved (whitespace-pre-line)
//   confirmLabel default "Confirm"
//   cancelLabel  default "Cancel"
//   destructive  default false; true renders the confirm button in the
//                destructive style and focuses Cancel for safety

import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { AlertTriangle, X } from "lucide-react"

const ConfirmContext = createContext(async () => false)

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const resolverRef = useRef(null)
  const cancelRef = useRef(null)
  const confirmRef = useRef(null)

  const settle = useCallback((result) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setState(null)
    if (resolve) resolve(result)
  }, [])

  const confirm = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve
      setState({
        title: opts.title || "Are you sure?",
        message: opts.message || "",
        confirmLabel: opts.confirmLabel || "Confirm",
        cancelLabel: opts.cancelLabel || "Cancel",
        destructive: opts.destructive === true,
      })
    })
  }, [])

  // Keyboard: Escape cancels, Enter confirms.
  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); settle(false) }
      else if (e.key === "Enter") { e.preventDefault(); settle(true) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [state, settle])

  // Focus the safe action on open (Cancel for destructive, Confirm otherwise).
  useEffect(() => {
    if (!state) return
    const el = state.destructive ? cancelRef.current : confirmRef.current
    el?.focus()
  }, [state])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {state && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => settle(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12, transition: { duration: 0.15 } }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="relative w-full max-w-md rounded-2xl border border-black/5 dark:border-white/10 bg-white dark:bg-surface-1 shadow-2xl overflow-hidden"
            >
              <div className="p-6">
                <div className="flex items-start gap-3">
                  {state.destructive && (
                    <div className="w-9 h-9 rounded-xl bg-rose-500/10 flex items-center justify-center shrink-0">
                      <AlertTriangle className="w-5 h-5 text-rose-500" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 id="confirm-title" className="text-base font-semibold text-zinc-900 dark:text-white">
                      {state.title}
                    </h2>
                    {state.message && (
                      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed whitespace-pre-line">
                        {state.message}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => settle(false)}
                    aria-label="Close"
                    className="shrink-0 p-1 rounded-lg text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="mt-6 flex items-center justify-end gap-2">
                  <button
                    ref={cancelRef}
                    type="button"
                    onClick={() => settle(false)}
                    className="px-3.5 py-2 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none"
                  >
                    {state.cancelLabel}
                  </button>
                  <button
                    ref={confirmRef}
                    type="button"
                    onClick={() => settle(true)}
                    className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition-colors focus-visible:ring-3 focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none ${
                      state.destructive
                        ? "bg-rose-600 text-white hover:bg-rose-500 focus-visible:ring-rose-500/50"
                        : "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100 focus-visible:ring-ring/60"
                    }`}
                  >
                    {state.confirmLabel}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  )
}

export const useConfirm = () => useContext(ConfirmContext)
