-- Repair fresh production replay before 20260613100000_complete_rls_rollback.
-- Earlier migrations can already create these policies; the historical
-- rollback migration recreates them without conditional guards.
drop policy if exists "tenants see own error_logs" on error_logs;
drop policy if exists "service role full access on storage.objects" on storage.objects;
drop policy if exists "tenants see own storage.objects for csv-uploads" on storage.objects;
