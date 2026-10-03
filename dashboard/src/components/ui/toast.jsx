"use client"

// Shared toast system. One provider is mounted at the app root (see
// app/layout.jsx) and every page reads it via useToast(). This replaces the
// per-page Toast/ToastStack copies that used to live in settings, operations,
// and ai-agents, and the native alert() calls scattered across pages.
//
// API (kept identical to the old per-page helper so migration is mechanical):
//   const { pushToast, dismissToast } = useToast()
//   pushToast("success" | "error" | "info", message, ttl = 4000)

import { createContext, useContext, useState, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react"

const ToastContext = createContext({
  pushToast: () => {},
  dismissToast: () => {},
})

function Toast({ toast, onDismiss }) {
  const variantClass = {
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    error:   "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    info:    "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  }[toast.type || "info"]
  const Icon = toast.type === "success" ? CheckCircle2 : toast.type === "error" ? AlertCircle : Info
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      className={`flex items-start gap-2.5 max-w-md min-w-[260px] px-3.5 py-2.5 rounded-xl border backdrop-blur-sm shadow-lg text-xs font-medium ${variantClass}`}
      role="status"
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="flex-1 leading-relaxed whitespace-pre-line">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="opacity-50 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  )
}

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-4 right-4 z-[150] flex flex-col-reverse gap-2 pointer-events-none">
      <AnimatePresence initial={false}>
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <Toast toast={t} onDismiss={onDismiss} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const pushToast = useCallback((type, message, ttl = 4000) => {
    const id = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setToasts(prev => [...prev, { id, type, message }])
    if (ttl > 0) setTimeout(() => dismissToast(id), ttl)
    return id
  }, [dismissToast])

  return (
    <ToastContext.Provider value={{ pushToast, dismissToast }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
