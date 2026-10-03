-- Phase 7: the two core cron jobs existed only as hand-run SQL in dev. A
-- fresh project replaying this repo now gets a working engine. Idempotent:
-- existing jobs are left untouched, and missing jobs are created.

do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'dispatch-pending-actions') then
    perform cron.schedule(
      'dispatch-pending-actions',
      '30 seconds',
      'select public.dispatch_pending_actions(''cron-worker'', 50);'
    );
  end if;

  if not exists (select 1 from cron.job where jobname = 'poll-gmail-inbox') then
    perform cron.schedule(
      'poll-gmail-inbox',
      '* * * * *',
      $cmd$
      select net.http_post(
        url     := public.get_functions_base_url() || '/functions/v1/poll-gmail-inbox',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || public.get_internal_dispatch_key()
        ),
        body                 := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
      $cmd$
    );
  end if;
end
$do$;

-- Align dev's existing poller with the portable command.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'poll-gmail-inbox'
              and command not like '%get_functions_base_url%') then
    perform cron.unschedule('poll-gmail-inbox');
    perform cron.schedule(
      'poll-gmail-inbox',
      '* * * * *',
      $cmd$
      select net.http_post(
        url     := public.get_functions_base_url() || '/functions/v1/poll-gmail-inbox',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || public.get_internal_dispatch_key()
        ),
        body                 := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
      $cmd$
    );
  end if;
end
$do$;
