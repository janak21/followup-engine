"use client"

import { useState, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { createSupabaseBrowserClient } from "@/utils/supabase-browser"
import { Button } from "@/components/ui/button"
import { Alert } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthShell, AuthShellSkeleton } from "../AuthShell"
import { Mail, Loader2, LogIn } from "lucide-react"

function LoginContent() {
  const search = useSearchParams()
  const router = useRouter()
  const next = search.get("next") || "/"
  // Surface errors bounced back from /auth/callback (expired/invalid links).
  const [error, setError] = useState(() => search.get("error") || "")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [mode, setMode] = useState("password") // "password" | "magic"
  const [busy, setBusy] = useState(false)
  const [magicSent, setMagicSent] = useState(false)

  const signInWithPassword = async (e) => {
    e.preventDefault()
    setError("")
    if (!email.trim() || !password) { setError("Enter your email and password."); return }
    setBusy(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (error) {
        setError(
          error.message === "Invalid login credentials"
            ? "Incorrect email or password. If you normally sign in with a magic link, use “Email me a magic link” below or set a password via “Forgot password”."
            : error.message
        )
        return
      }
      router.push(next)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const sendMagicLink = async (e) => {
    e.preventDefault()
    setError("")
    if (!email.trim()) { setError("Enter your email."); return }
    setBusy(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const origin = typeof window !== "undefined" ? window.location.origin : ""
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      })
      if (error) { setError(error.message); return }
      setMagicSent(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle={mode === "password" ? "Welcome back. Enter your credentials." : "We'll email you a magic link."}
    >
      {magicSent ? (
        <Alert variant="success" title="Check your inbox." className="mt-6 p-4">
          <div className="text-xs mt-1">We sent a sign-in link to {email}. Open it on this device.</div>
        </Alert>
      ) : (
        <form onSubmit={mode === "password" ? signInWithPassword : sendMagicLink} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="login-email" className="text-xs text-zinc-500">Email</Label>
            <Input
              id="login-email"
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

          {mode === "password" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password" className="text-xs text-zinc-500">Password</Label>
                <Link href="/auth/forgot-password" className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 underline underline-offset-2">
                  Forgot password?
                </Link>
              </div>
              <Input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="bg-white dark:bg-black border-black/10 dark:border-white/10 rounded-xl"
              />
            </div>
          )}

          {error && (
            <Alert variant="danger" size="sm">{error}</Alert>
          )}

          <Button
            type="submit"
            disabled={busy}
            className="w-full h-10 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100"
          >
            {busy
              ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
              : mode === "password" ? <LogIn className="w-4 h-4 mr-2" /> : <Mail className="w-4 h-4 mr-2" />}
            {mode === "password" ? "Sign in" : "Send magic link"}
          </Button>

          <button
            type="button"
            onClick={() => { setMode(mode === "password" ? "magic" : "password"); setError("") }}
            className="w-full text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 underline underline-offset-2"
          >
            {mode === "password" ? "Email me a magic link instead" : "Sign in with a password instead"}
          </button>

          <p className="text-xs text-zinc-500 text-center border-t border-black/5 dark:border-white/5 pt-4">
            New to Example Co?{" "}
            <Link href="/auth/signup" className="font-medium text-zinc-800 dark:text-zinc-200 underline underline-offset-2">
              Create an account
            </Link>
          </p>
          <p className="text-[11px] text-zinc-500 text-center">
            By signing in you agree to handle the account responsibly. Audit logs record every change.
          </p>
        </form>
      )}
    </AuthShell>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthShellSkeleton />}>
      <LoginContent />
    </Suspense>
  )
}
