import Link from "next/link"

export default function NotFound() {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-[#f9f9fb] dark:bg-surface-base">
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-zinc-400/[0.06] dark:bg-white/[0.03] blur-[120px]" />
      </div>
      <div className="noise-overlay" aria-hidden="true" />
      <div className="text-center relative z-10 max-w-md">
        <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-white/5 flex items-center justify-center mx-auto mb-6">
          <span className="text-3xl font-bold text-zinc-300 dark:text-zinc-600">404</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white mb-2">Page not found</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-8 leading-relaxed">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-sm font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
