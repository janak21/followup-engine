"use client"

import { useState, Suspense } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { createSupabaseBrowserClient } from "@/utils/supabase-browser"
import { Button } from "@/components/ui/button"
import { Alert } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthShell, AuthShellSkeleton } from "../AuthShell"
import { Loader2, UserPlus } from "lucide-react"

const MIN_PASSWORD_LENGTH = 8

function SignupContent() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [confirmationSent, setConfirmationSent] = useState(false)

  const signUp = async (e) => {
    e.preventDefault()
    setError("")
    if (!email.trim()) { setError("Enter your email."); return }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) { setError("Passwords do not match."); return }
    setBusy(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const origin = typeof window !== "undefined" ? window.location.origin : ""
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=%2F`,
        },
      })
      if (error) { setError(error.message); return }
      // Supabase returns a user with no identities when the email is already
      // registered (anti-enumeration). Point them at sign-in instead.
      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setError("An account with this email already exists. Sign in instead, or use “Forgot password” to set a password.")
        return
      }
      if (data?.session) {
        // Email confirmation disabled — signed in immediately.
        router.push("/")
        router.refresh()
        return
      }
      setConfirmationSent(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Create account" subtitle="Set up your email and password.">
      {confirmationSent ? (
        <Alert variant="success" title="Confirm your email." className="mt-6 p-4">
          <div className="text-xs mt-1">
            We sent a confirmation link to {email}. Click it to activate your account, then sign in.
          </div>
        </Alert>
      ) : (
        <form onSubmit={signUp} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="signup-email" className="text-xs text-zinc-500">Email</Label>
            <Input
              id="signup-email"
              type="email"
              autoFocus
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
            />
            <p className="text-[11px] text-zinc-500">
              If your team invited this email, your workspace access is attached automatically.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-password" className="text-xs text-zinc-500">Password</Label>
            <Input
              id="signup-password"
              type="password"
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
            <Label htmlFor="signup-confirm" className="text-xs text-zinc-500">Confirm password</Label>
            <Input
              id="signup-confirm"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat your password"
              className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
            />
          </div>

          {error && <Alert variant="danger" size="sm">{error}</Alert>}

          <Button
            type="submit"
            disabled={busy}
            className="w-full h-10 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <UserPlus className="w-4 h-4 mr-2" />}
            Create account
          </Button>

          <p className="text-xs text-zinc-500 text-center border-t border-black/5 dark:border-white/5 pt-4">
            Already have an account?{" "}
            <Link href="/auth/login" className="font-medium text-zinc-800 dark:text-zinc-200 underline underline-offset-2">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={<AuthShellSkeleton />}>
      <SignupContent />
    </Suspense>
  )
}
