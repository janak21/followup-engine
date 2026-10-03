// Next.js middleware.
// - Refreshes the Supabase auth session cookie on every request so the user
//   stays signed in seamlessly.
// - Redirects unauthenticated requests for protected pages to /auth/login.
// - Leaves /auth/* and static assets alone.

import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"

const PUBLIC_PATH_PREFIXES = [
  "/auth",                         // login + callback + signout
  "/_next",
  "/favicon",
]

function isPublicPath(pathname) {
  if (PUBLIC_PATH_PREFIXES.some(p => pathname === p || pathname.startsWith(p))) return true
  // Static files (anything with a file extension).
  return /\.[a-zA-Z0-9]+$/.test(pathname)
}

export async function middleware(request) {
  let response = NextResponse.next({ request: { headers: request.headers } })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
        },
      },
    }
  )

  // This call refreshes the session if needed.
  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = "/auth/login"
    url.searchParams.set("next", pathname)
    return NextResponse.redirect(url)
  }

  // Signed-in user landing on /auth/login or /auth/signup → bounce home.
  if (user && (pathname === "/auth/login" || pathname === "/auth/signup")) {
    const url = request.nextUrl.clone()
    url.pathname = "/"
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    // Run on every request except files in public assets folder.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}
