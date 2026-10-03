"use client"

// Shown to a signed-in user who has no tenant membership yet (e.g. they signed
// up before being invited). Without this they'd see an empty dashboard whose
// every API call fails with "not a member of any tenant".

import { Building2, LogOut, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

export function NoWorkspace({ email }) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6">
      <div className="w-full max-w-md p-8 rounded-2xl border border-black/5 dark:border-white/5 bg-white/70 dark:bg-white/[0.03] backdrop-blur-xl shadow-xl text-center">
        <div className="w-12 h-12 rounded-full bg-zinc-950/5 dark:bg-white/5 flex items-center justify-center mx-auto mb-4">
          <Building2 className="w-6 h-6 text-zinc-500" />
        </div>
        <h1 className="text-xl font-bold text-zinc-900 dark:text-white">No workspace yet</h1>
        <p className="text-sm text-zinc-500 mt-2">
          You&apos;re signed in as <span className="font-medium text-zinc-800 dark:text-zinc-200">{email}</span>,
          but this email isn&apos;t attached to any workspace.
        </p>
        <p className="text-xs text-zinc-500 mt-3">
          Ask your workspace administrator to invite <span className="font-mono">{email}</span> from
          Settings → Team. Access is attached automatically once the invite exists — refresh this page afterwards.
        </p>
        <div className="flex items-center justify-center gap-2 mt-6">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw className="w-4 h-4 mr-2" /> Check again
          </Button>
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="ghost" size="sm">
              <LogOut className="w-4 h-4 mr-2" /> Sign out
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
