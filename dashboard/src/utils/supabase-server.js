// Server-side Supabase client. Reads & writes auth cookies via Next.js
// `cookies()`. Use this in Server Components and Route Handlers when you need
// the *user* identity (RLS will apply auth.uid()).
//
// For privileged server-side operations that must bypass RLS, keep using the
// service-role client in `src/utils/supabase.js`.

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component — cookies are read-only there.
            // The middleware will refresh the session on the next request.
          }
        },
      },
    }
  )
}

// Helper: return the auth user for the current request, or null.
export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}
