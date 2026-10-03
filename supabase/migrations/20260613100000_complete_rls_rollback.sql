-- Migration: Complete database RLS rollback, dropping all public policies and keeping service role + tenant JWT policies
-- Created at: 2026-06-13T10:00:00+05:30

-- 1. Drop all "Allow public ..." policies in public schema
drop policy if exists "Allow public select on tenant_credentials" on tenant_credentials;
drop policy if exists "Allow public insert on tenant_credentials" on tenant_credentials;
drop policy if exists "Allow public update on tenant_credentials" on tenant_credentials;
drop policy if exists "Allow public delete on tenant_credentials" on tenant_credentials;

drop policy if exists "Allow public select on suppressions" on suppressions;
drop policy if exists "Allow public insert on suppressions" on suppressions;
drop policy if exists "Allow public update on suppressions" on suppressions;
drop policy if exists "Allow public delete on suppressions" on suppressions;

drop policy if exists "Allow public select on error_logs" on error_logs;
drop policy if exists "Allow public insert on error_logs" on error_logs;
drop policy if exists "Allow public update on error_logs" on error_logs;
drop policy if exists "Allow public delete on error_logs" on error_logs;

drop policy if exists "Allow public insert on events" on events;
drop policy if exists "Allow public update on events" on events;
drop policy if exists "Allow public delete on events" on events;

drop policy if exists "Allow public insert on import_batches" on import_batches;
drop policy if exists "Allow public select on import_batches" on import_batches;
drop policy if exists "Allow public update on import_batches" on import_batches;

-- 2. Drop all "Allow public ..." policies in storage schema
drop policy if exists "Allow public insert on storage.objects for csv-uploads" on storage.objects;
drop policy if exists "Allow public select on storage.objects for csv-uploads" on storage.objects;
drop policy if exists "Allow public update on storage.objects for csv-uploads" on storage.objects;

-- 3. Add missing "tenants see own" select policy for error_logs
create policy "tenants see own error_logs" on error_logs 
  for select using (tenant_id::text = auth.jwt() ->> 'tenant_id');

-- 4. Add service role and tenant select policies for storage.objects under csv-uploads
create policy "service role full access on storage.objects" on storage.objects 
  for all to service_role using (true) with check (true);

create policy "tenants see own storage.objects for csv-uploads" on storage.objects 
  for select using (bucket_id = 'csv-uploads' and (storage.foldername(name))[1] = auth.jwt() ->> 'tenant_id');
