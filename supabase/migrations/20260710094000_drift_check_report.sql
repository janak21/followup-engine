-- Phase 7: advisory drift-check report for repo/deployed parity and launch
-- readiness. Called by scripts/drift-check.mjs with the service-role key.

create or replace function public.drift_check_report()
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'applied_migrations', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object('version', version, 'name', name)
          order by version
        ),
        '[]'::jsonb
      )
      from supabase_migrations.schema_migrations
    ),
    'url_leak_functions', (
      select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind = 'f'
        and p.proname <> 'get_functions_base_url'
        and pg_get_functiondef(p.oid) like '%' || 'vadyuww' || 'qlgejfyohcydz' || '%'
    ),
    'public_executable_function_count', (
      select count(*)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind = 'f'
        and (
          has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        )
    ),
    'cron_jobnames', (
      select coalesce(jsonb_agg(jobname order by jobname), '[]'::jsonb)
      from cron.job
    )
  );
$$;

revoke execute on function public.drift_check_report() from public, anon, authenticated;
grant execute on function public.drift_check_report() to service_role;
