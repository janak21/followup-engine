-- Migration: Add public RLS policies for tenant_credentials table
-- Created at: 2026-06-12T15:38:00+05:30

-- 1. tenant_credentials
create policy "Allow public select on tenant_credentials" on tenant_credentials for select using (true);
create policy "Allow public insert on tenant_credentials" on tenant_credentials for insert with check (true);
create policy "Allow public update on tenant_credentials" on tenant_credentials for update using (true);
create policy "Allow public delete on tenant_credentials" on tenant_credentials for delete using (true);
