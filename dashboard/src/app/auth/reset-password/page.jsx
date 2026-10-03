"use client"

import { useEffect, useState, Suspense } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { createSupabaseBrowserClient } from "@/utils/supabase-browser"
import { Button } from "@/components/ui/button"
import { Alert } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthShell, AuthShellSkeleton } from "../AuthShell"
import { Loader2, ShieldCheck } from "lucide-react"

const MIN_PASSWORD_LENGTH = 8

// Landed on from the recovery-email link: /auth/callback exchanges the code
// for a session first, then redirects here, so updateUser() works directly.
function ResetPasswordContent() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [hasSession, setHasSession] = useState(null) // null = checking

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session))
  }, [])

  const save = async (e) => {
    e.preventDefault()
    setError("")
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) { setError("Passwords do not match."); return }
    setBusy(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const { error } = await supabase.auth.updateUser({ password })
      if (error) { setError(error.message); return }
      router.push("/")
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (hasSession === null) return <AuthShellSkeleton />

  if (!hasSession) {
    return (
      <AuthShell title="Reset link expired" subtitle="This page only works right after opening a reset link.">
        <Alert variant="warning" className="mt-6 p-4">
          <div className="text-xs">
            Your reset link may have expired or was already used. Request a new one and open it on this device.
          </div>
        </Alert>
        <p className="text-xs text-zinc-500 text-center mt-4">
          <Link href="/auth/forgot-password" className="font-medium text-zinc-800 dark:text-zinc-200 underline underline-offset-2">
            Request a new reset link
          </Link>
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Set a new password" subtitle="You're signed in — choose your new password.">
      <form onSubmit={save} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="reset-password" className="text-xs text-zinc-500">New password</Label>
          <Input
            id="reset-password"
            type="password"
            autoFocus
            required
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reset-confirm" className="text-xs text-zinc-500">Confirm new password</Label>
          <Input
            id="reset-confirm"
            type="password"
            required
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat your new password"
            className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
          />
        </div>
        {error && <Alert variant="danger" size="sm">{error}</Alert>}
        <Button
          type="submit"
          disabled={busy}
          className="w-full h-10 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
          Save new password
        </Button>
      </form>
    </AuthShell>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthShellSkeleton />}>
      <ResetPasswordContent />
    </Suspense>
  )
}
