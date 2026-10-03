-- Migration: Add public RLS policies for events, error_logs, and suppressions tables
-- Created at: 2026-06-12T15:35:00+05:30

-- 1. events
create policy "Allow public insert on events" on events for insert with check (true);
create policy "Allow public update on events" on events for update using (true);
create policy "Allow public delete on events" on events for delete using (true);

-- 2. error_logs
create policy "Allow public select on error_logs" on error_logs for select using (true);
create policy "Allow public insert on error_logs" on error_logs for insert with check (true);
create policy "Allow public update on error_logs" on error_logs for update using (true);
create policy "Allow public delete on error_logs" on error_logs for delete using (true);

-- 3. suppressions
create policy "Allow public select on suppressions" on suppressions for select using (true);
create policy "Allow public insert on suppressions" on suppressions for insert with check (true);
create policy "Allow public update on suppressions" on suppressions for update using (true);
create policy "Allow public delete on suppressions" on suppressions for delete using (true);



