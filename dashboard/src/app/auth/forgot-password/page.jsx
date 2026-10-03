"use client"

import { useState, Suspense } from "react"
import Link from "next/link"
import { createSupabaseBrowserClient } from "@/utils/supabase-browser"
import { Button } from "@/components/ui/button"
import { Alert } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthShell, AuthShellSkeleton } from "../AuthShell"
import { Loader2, KeyRound } from "lucide-react"

function ForgotPasswordContent() {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sent, setSent] = useState(false)

  const send = async (e) => {
    e.preventDefault()
    setError("")
    if (!email.trim()) { setError("Enter your email."); return }
    setBusy(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const origin = typeof window !== "undefined" ? window.location.origin : ""
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/auth/reset-password")}`,
      })
      if (error) { setError(error.message); return }
      setSent(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Reset password" subtitle="We'll email you a link to set a new password.">
      {sent ? (
        <Alert variant="success" title="Check your inbox." className="mt-6 p-4">
          <div className="text-xs mt-1">
            If an account exists for {email}, a password reset link is on its way. Open it on this device.
          </div>
        </Alert>
      ) : (
        <form onSubmit={send} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="forgot-email" className="text-xs text-zinc-500">Email</Label>
            <Input
              id="forgot-email"
              type="email"
              autoFocus
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
            />
          </div>
          {error && <Alert variant="danger" size="sm">{error}</Alert>}
          <Button
            type="submit"
            disabled={busy}
            className="w-full h-10 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <KeyRound className="w-4 h-4 mr-2" />}
            Send reset link
          </Button>
          <p className="text-xs text-zinc-500 text-center border-t border-black/5 dark:border-white/5 pt-4">
            Remembered it?{" "}
            <Link href="/auth/login" className="font-medium text-zinc-800 dark:text-zinc-200 underline underline-offset-2">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  )
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<AuthShellSkeleton />}>
      <ForgotPasswordContent />
    </Suspense>
  )
}
