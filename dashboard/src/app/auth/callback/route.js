// Magic link redirect target. Supabase appends `?code=...` to the URL after
// clicking the link; we exchange it for a session, then bounce to ?next.

import { NextResponse } from "next/server"
import { createSupabaseServerClient } from "@/utils/supabase-server"

export async function GET(request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const next = url.searchParams.get("next") || "/"

  if (code) {
    const supabase = await createSupabaseServerClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      const failUrl = new URL("/auth/login", url.origin)
      failUrl.searchParams.set("error", error.message)
      return NextResponse.redirect(failUrl)
    }
  }
  return NextResponse.redirect(new URL(next, url.origin))
}
