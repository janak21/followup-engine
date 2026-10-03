-- Migration: Add RLS policies for csv-uploads storage bucket and import_batches table
-- Created at: 2026-06-12T11:31:00+05:30

-- 1. Enable RLS and add policies for import_batches
create policy "Allow public insert on import_batches" on import_batches for insert with check (true);
create policy "Allow public select on import_batches" on import_batches for select using (true);
create policy "Allow public update on import_batches" on import_batches for update using (true);

-- 2. Add policies for storage.objects under the csv-uploads bucket
create policy "Allow public insert on storage.objects for csv-uploads" on storage.objects for insert with check (bucket_id = 'csv-uploads');
create policy "Allow public select on storage.objects for csv-uploads" on storage.objects for select using (bucket_id = 'csv-uploads');
create policy "Allow public update on storage.objects for csv-uploads" on storage.objects for update using (bucket_id = 'csv-uploads');
