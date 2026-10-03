"use client"

// Promise-based text-input dialog. One provider is mounted at the app root
// (see app/layout.jsx). Pages call it as a drop-in async replacement for the
// native, blocking window.prompt():
//
//   const prompt = usePrompt()
//   const name = await prompt({ title, message, defaultValue })
//   if (!name) return            // null when cancelled
//
// Options:
//   title        heading (default "Enter a value")
//   message      helper text above the input
//   defaultValue initial input value
//   placeholder  input placeholder
//   confirmLabel default "Confirm"
//   cancelLabel  default "Cancel"
//   required     default true; blocks submitting an empty value

import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X } from "lucide-react"

const PromptContext = createContext(async () => null)

export function PromptProvider({ children }) {
  const [state, setState] = useState(null)
  const [value, setValue] = useState("")
  const resolverRef = useRef(null)
  const inputRef = useRef(null)

  const settle = useCallback((result) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setState(null)
    if (resolve) resolve(result)
  }, [])

  const prompt = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve
      setValue(opts.defaultValue || "")
      setState({
        title: opts.title || "Enter a value",
        message: opts.message || "",
        placeholder: opts.placeholder || "",
        confirmLabel: opts.confirmLabel || "Confirm",
        cancelLabel: opts.cancelLabel || "Cancel",
        required: opts.required !== false,
      })
    })
  }, [])

  const canSubmit = !state?.required || value.trim().length > 0

  const submit = useCallback(() => {
    if (state?.required && value.trim().length === 0) return
    settle(value)
  }, [state, value, settle])

  // Escape cancels (Enter is handled by the form submit).
  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); settle(null) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [state, settle])

  // Focus + select the input on open.
  useEffect(() => {
    if (!state) return
    const el = inputRef.current
    if (el) { el.focus(); el.select() }
  }, [state])

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <AnimatePresence>
        {state && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => settle(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.form
              onSubmit={(e) => { e.preventDefault(); submit() }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="prompt-title"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12, transition: { duration: 0.15 } }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="relative w-full max-w-md rounded-2xl border border-black/5 dark:border-white/10 bg-white dark:bg-surface-1 shadow-2xl overflow-hidden"
            >
              <div className="p-6">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 id="prompt-title" className="text-base font-semibold text-zinc-900 dark:text-white">
                      {state.title}
                    </h2>
                    {state.message && (
                      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                        {state.message}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => settle(null)}
                    aria-label="Close"
                    className="shrink-0 p-1 rounded-lg text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <input
                  ref={inputRef}
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={state.placeholder}
                  className="mt-4 w-full h-9 px-3 rounded-xl bg-zinc-950/5 dark:bg-black/40 border border-black/10 dark:border-white/10 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-600 outline-none focus:border-black/20 dark:focus:border-white/20 focus-visible:ring-3 focus-visible:ring-ring/60 transition-colors"
                />
                <div className="mt-6 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => settle(null)}
                    className="px-3.5 py-2 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none"
                  >
                    {state.cancelLabel}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="px-3.5 py-2 rounded-xl text-sm font-semibold bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {state.confirmLabel}
                  </button>
                </div>
              </div>
            </motion.form>
          </div>
        )}
      </AnimatePresence>
    </PromptContext.Provider>
  )
}

export const usePrompt = () => useContext(PromptContext)
