-- Repair fresh production replay after the large historical function-backfill
-- migration was recorded as a no-op due MCP transport limits.
create or replace function public.get_internal_dispatch_key()
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = 'internal_dispatch_key'
   order by created_at desc
   limit 1;
$$;

revoke execute on function public.get_internal_dispatch_key() from public, anon, authenticated;
grant execute on function public.get_internal_dispatch_key() to service_role;
