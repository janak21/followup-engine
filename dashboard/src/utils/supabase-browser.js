// Browser-side Supabase client. Use in client components for sign-in,
// sign-out, and any user-scoped reads that should respect RLS.
"use client"

import { createBrowserClient } from "@supabase/ssr"

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}
