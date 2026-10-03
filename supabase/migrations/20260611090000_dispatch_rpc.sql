create or replace function dispatch_pending_actions(worker_id text, batch_size int default 20)
returns setof actions
language sql
volatile
as $$
  update actions
  set status = 'in_progress',
      locked_until = now() + interval '5 minutes',
      locked_by = worker_id
  where id in (
    select id
    from actions
    where run_at <= now()
      and status = 'pending'
      and (locked_until is null or locked_until < now())
    order by run_at
    limit batch_size
    for update skip locked
  )
  returning *;
$$;
