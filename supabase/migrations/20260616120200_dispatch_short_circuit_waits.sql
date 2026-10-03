-- Migration: dispatch_pending_actions short-circuits wait actions
-- The W-DISPATCH workflow polls this RPC every tick. Wait actions have no
-- provider I/O — there is nothing for n8n to do — so we resolve them inline
-- here and exclude them from the returned set. This keeps n8n's routing
-- switch simple and prevents waits from consuming a route output that does
-- not exist.
--
-- Created at: 2026-06-16T12:02:00Z

create or replace function dispatch_pending_actions(worker_id text, batch_size int default 20)
returns setof actions
language plpgsql
volatile
as $$
declare
  v_wait_id uuid;
begin
  -- 1) Resolve any waits whose run_at has passed. These never leave Postgres.
  --    Bounded so a backlog cannot starve the action loop.
  for v_wait_id in
    select id from actions
     where action_type = 'wait'
       and status = 'pending'
       and run_at <= now()
     order by run_at
     limit 500
     for update skip locked
  loop
    begin
      perform process_wait_action(v_wait_id);
    exception when others then
      insert into error_logs (tenant_id, workflow_name, error_message, raw_error, created_at)
        select tenant_id,
               'dispatch_pending_actions:wait',
               sqlerrm,
               jsonb_build_object('action_id', v_wait_id, 'sqlstate', sqlstate),
               now()
          from actions where id = v_wait_id;
    end;
  end loop;

  -- 2) Return non-wait pending actions for n8n to route as before.
  return query
    update actions
       set status = 'in_progress',
           locked_until = now() + interval '5 minutes',
           locked_by = worker_id
     where id in (
       select id
         from actions
        where run_at <= now()
          and status = 'pending'
          and action_type <> 'wait'
          and (locked_until is null or locked_until < now())
        order by run_at
        limit batch_size
        for update skip locked
     )
    returning *;
end;
$$;
