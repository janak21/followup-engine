-- Migration: process_due_waits
-- A single SQL entry point the W-DISPATCH workflow (or pg_cron) can call once
-- per tick. It walks every wait action whose run_at <= now() and advances each
-- journey one step. Waits never need to leave Postgres — there's no provider
-- I/O — so we resolve them inline before the action-routing fan-out sees them.
--
-- Returns the number of waits processed so callers can log throughput.
--
-- Created at: 2026-06-16T12:01:00Z

create or replace function process_due_waits()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_count int := 0;
begin
  for v_id in
    select id from actions
     where action_type = 'wait'
       and status = 'pending'
       and run_at <= now()
     order by run_at
     -- Cap per-tick volume so a backlog can't lock the dispatcher loop.
     limit 500
     for update skip locked
  loop
    begin
      perform process_wait_action(v_id);
      v_count := v_count + 1;
    exception when others then
      -- Don't blow up the whole batch on a single bad action — log and skip.
      insert into error_logs (tenant_id, workflow_name, error_message, raw_error, created_at)
        select tenant_id,
               'process_due_waits',
               sqlerrm,
               jsonb_build_object('action_id', v_id, 'sqlstate', sqlstate),
               now()
          from actions where id = v_id;
    end;
  end loop;
  return v_count;
end;
$$;

-- Convenience: if Supabase pg_cron is enabled, schedule this every minute.
-- Comment out if you prefer to drive it from W-DISPATCH instead.
-- select cron.schedule('process_due_waits_every_minute', '* * * * *',
--   $$ select process_due_waits(); $$);
