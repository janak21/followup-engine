// POST /auth/signout — clears the session cookie and redirects to /auth/login.

import { NextResponse } from "next/server"
import { createSupabaseServerClient } from "@/utils/supabase-server"

export async function POST(request) {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()
  const url = new URL("/auth/login", request.url)
  return NextResponse.redirect(url, { status: 303 })
}
