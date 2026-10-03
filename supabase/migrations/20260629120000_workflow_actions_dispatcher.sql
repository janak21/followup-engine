-- Narrow event workflow dispatcher.
--
-- This intentionally processes only leadless event workflow actions:
-- create_lead_from_payload and find_lead_from_payload. Unsupported workflow
-- action types are failed permanently so provider-sending action types cannot
-- be accidentally executed or retried forever.

create or replace function public.dispatch_pending_workflow_actions(
  p_worker_id text default 'workflow-worker',
  p_batch_size integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.workflow_actions%rowtype;
  v_result jsonb;
  v_processed integer := 0;
  v_completed integer := 0;
  v_failed integer := 0;
  v_unsupported integer := 0;
  v_stale_recovered integer := 0;
  v_batch_size integer := greatest(coalesce(p_batch_size, 50), 0);
  v_worker_id text := coalesce(nullif(btrim(p_worker_id), ''), 'workflow-worker');
begin
  update public.workflow_actions
     set status = 'pending',
         locked_by = null,
         locked_until = null,
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'stale_recovered_at', now(),
           'stale_recovered_by', v_worker_id
         )
   where id in (
     select id
       from public.workflow_actions
      where status = 'in_progress'
        and locked_until is not null
        and locked_until < now()
      order by locked_until, created_at
      limit 100
      for update skip locked
   );
  get diagnostics v_stale_recovered = row_count;

  if v_batch_size = 0 then
    return jsonb_build_object(
      'processed', 0,
      'completed', 0,
      'failed', 0,
      'unsupported', 0,
      'stale_recovered', v_stale_recovered
    );
  end if;

  for v_action in
    update public.workflow_actions
       set status = 'in_progress',
           locked_by = v_worker_id,
           locked_until = now() + interval '5 minutes'
     where id in (
       select id
         from public.workflow_actions
        where status = 'pending'
          and run_at <= now()
          and (next_retry_at is null or next_retry_at <= now())
          and (locked_until is null or locked_until < now())
        order by run_at, created_at
        limit v_batch_size
        for update skip locked
     )
     returning *
  loop
    v_processed := v_processed + 1;

    if v_action.action_type = 'create_lead_from_payload' then
      begin
        v_result := public.process_workflow_create_lead_action(v_action.id);

        if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
          v_completed := v_completed + 1;
        else
          v_failed := v_failed + 1;
        end if;
      exception
        when others then
          update public.workflow_actions
             set status = 'failed_permanent',
                 failed_at = coalesce(failed_at, now()),
                 locked_by = null,
                 locked_until = null,
                 last_error = left(sqlerrm, 2000),
                 result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                   'failed_permanent_at', now(),
                   'failure_message', left(sqlerrm, 2000),
                   'failed_by', 'dispatch_pending_workflow_actions'
                 )
           where id = v_action.id;
          v_failed := v_failed + 1;
      end;
    elsif v_action.action_type = 'find_lead_from_payload' then
      begin
        v_result := public.process_workflow_find_lead_action(v_action.id);

        if coalesce(v_result ->> 'status', '') in ('completed', 'already_completed') then
          v_completed := v_completed + 1;
        else
          v_failed := v_failed + 1;
        end if;
      exception
        when others then
          update public.workflow_actions
             set status = 'failed_permanent',
                 failed_at = coalesce(failed_at, now()),
                 locked_by = null,
                 locked_until = null,
                 last_error = left(sqlerrm, 2000),
                 result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                   'failed_permanent_at', now(),
                   'failure_message', left(sqlerrm, 2000),
                   'failed_by', 'dispatch_pending_workflow_actions'
                 )
           where id = v_action.id;
          v_failed := v_failed + 1;
      end;
    else
      update public.workflow_actions
         set status = 'failed_permanent',
             failed_at = coalesce(failed_at, now()),
             locked_by = null,
             locked_until = null,
             last_error = 'Unsupported workflow action type',
             result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
               'failed_permanent_at', now(),
               'failure_message', 'Unsupported workflow action type',
               'unsupported_action_type', v_action.action_type,
               'failed_by', 'dispatch_pending_workflow_actions'
             )
       where id = v_action.id;

      v_failed := v_failed + 1;
      v_unsupported := v_unsupported + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'completed', v_completed,
    'failed', v_failed,
    'unsupported', v_unsupported,
    'stale_recovered', v_stale_recovered
  );
end;
$$;
