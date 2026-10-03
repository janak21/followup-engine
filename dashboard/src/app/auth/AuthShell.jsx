"use client"

// Shared chrome for all /auth/* pages so the card, glow, and noise treatments
// stay identical across login / signup / forgot / reset.

export function AuthShell({ title, subtitle, children }) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-[#f9f9fb] dark:bg-surface-base relative">
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-zinc-400/[0.06] dark:bg-white/[0.03] blur-[120px]" />
        <div className="absolute -bottom-[20%] -right-[10%] w-[40%] h-[40%] rounded-full bg-zinc-300/[0.05] dark:bg-zinc-500/[0.03] blur-[120px]" />
      </div>
      <div className="noise-overlay" aria-hidden="true" />
      <div className="w-full max-w-md p-8 rounded-2xl border border-black/5 dark:border-white/5 bg-white/70 dark:bg-white/[0.03] backdrop-blur-xl shadow-xl relative z-10">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">{title}</h1>
        {subtitle && <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>}
        {children}
      </div>
    </div>
  )
}

export function AuthShellSkeleton() {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-[#f9f9fb] dark:bg-surface-base">
      <div className="w-full max-w-md p-8 rounded-2xl border border-black/5 dark:border-white/5 bg-white/70 dark:bg-white/[0.03] backdrop-blur-xl shadow-xl animate-pulse">
        <div className="h-6 w-24 rounded-lg bg-zinc-200 dark:bg-white/10" />
        <div className="h-4 w-48 rounded-lg bg-zinc-200 dark:bg-white/10 mt-3" />
        <div className="h-10 w-full rounded-xl bg-zinc-200 dark:bg-white/10 mt-6" />
      </div>
    </div>
  )
}
