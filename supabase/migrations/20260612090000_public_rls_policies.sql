-- Migration: Add public RLS policies for dashboard visibility of database records
-- Created at: 2026-06-12T13:42:00+05:30

-- 1. tenants
create policy "Allow public select on tenants" on tenants for select using (true);

-- 2. senders
create policy "Allow public select on senders" on senders for select using (true);

-- 3. templates
create policy "Allow public select on templates" on templates for select using (true);
create policy "Allow public insert/update/delete on templates" on templates for all using (true);

-- 4. journeys
create policy "Allow public select on journeys" on journeys for select using (true);

-- 5. leads
create policy "Allow public select on leads" on leads for select using (true);
create policy "Allow public insert/update/delete on leads" on leads for all using (true);

-- 6. actions
create policy "Allow public select on actions" on actions for select using (true);
create policy "Allow public insert/update/delete on actions" on actions for all using (true);

-- 7. events
create policy "Allow public select on events" on events for select using (true);
