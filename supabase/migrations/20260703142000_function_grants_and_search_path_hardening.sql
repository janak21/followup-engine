-- Security hardening (advisor lints: SECURITY DEFINER functions executable by
-- anon/authenticated, and 0011 function_search_path_mutable).
--
-- Applied to follow-up-dev via Supabase MCP on 2026-07-03.
--
-- 1) Engine RPCs (advance_journey, process_inbound_email, dispatch_*, ...)
--    are executable by anon + authenticated via the default PUBLIC grant.
--    All legitimate callers use the service_role key (dashboard API routes,
--    edge functions) or run as the function owner (pg_cron). Verified on
--    2026-07-03: no RLS policy, storage policy, or browser-side code invokes
--    any public-schema function as anon/authenticated (policies use auth.*
--    only; all dashboard .rpc() calls live in server-side API routes).
--    Note: trigger firing does not require invoker EXECUTE, so trigger
--    functions are safe to revoke too.
--
-- 2) Pin search_path on the 5 functions flagged as mutable.
--
-- Caveat: dashboard/src/utils/supabase.js falls back to the ANON key when
-- SUPABASE_SERVICE_ROLE_KEY is unset — after this migration such a
-- misconfigured deploy fails loudly on RPC calls instead of silently running
-- as anon. That is the desired behavior, but confirm the env var is set.
--
-- Future migrations that add functions get PUBLIC execute again by default;
-- re-run the advisor after schema changes (or extend this pattern).

do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;

  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname in (
         'set_updated_at',
         'dispatch_pending_actions',
         'leads_canonicalize_phone',
         'infer_custom_field_type',
         'reset_per_enrollment_flags_on_journey_change'
       )
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
          where c like 'search_path=%'
       )
  loop
    execute format('alter function %s set search_path = public', f.sig);
  end loop;
end
$do$;
