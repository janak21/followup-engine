// Auth resolution for Next.js → Supabase Edge Function calls.
//
// Edge functions accept either:
//   1. INTERNAL_DISPATCH_KEY — a stable shared secret we control (set
//      in Postgres Vault + Edge Function secrets + Next.js .env.local)
//   2. SUPABASE_SERVICE_ROLE_KEY — Supabase's auto-injected key, can be
//      rotated by Supabase / dashboard ops without warning
//
// Prefer INTERNAL_DISPATCH_KEY because it eliminates the failure mode
// where Supabase rotates the service role key and we forget to update
// .env.local. SERVICE_ROLE_KEY is a graceful fallback for installs that
// haven't set the dispatch key yet.
//
// Throws if neither is configured — calls would hit 401 anyway, better
// to fail loudly with a clear message at the route boundary.

export function getEdgeAuthHeader() {
  const dispatchKey   = process.env.INTERNAL_DISPATCH_KEY;
  const serviceRole   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = dispatchKey || serviceRole;
  if (!token) {
    throw new Error(
      'Neither INTERNAL_DISPATCH_KEY nor SUPABASE_SERVICE_ROLE_KEY is set. Add INTERNAL_DISPATCH_KEY (recommended — same value as your Postgres Vault secret of the same name) to .env.local and restart.',
    );
  }
  return `Bearer ${token}`;
}

export function getEdgeFunctionUrl(slug) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set.');
  return `${base}/functions/v1/${slug}`;
}

export function isUsingDispatchKey() {
  return !!process.env.INTERNAL_DISPATCH_KEY;
}
