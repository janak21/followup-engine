-- Phase 7: ops alerting. Every 5 minutes, scan for (a) new severity=error
-- rows, (b) stale dispatcher heartbeat, (c) new failed_permanent actions.
-- Posts to Slack via notify-operator when ops_slack_webhook_url is set.

create table if not exists public.ops_alert_state (
  id integer primary key default 1 check (id = 1),
  last_scanned_at timestamptz not null default now(),
  last_heartbeat_alert_at timestamptz
);
insert into public.ops_alert_state (id) values (1) on conflict do nothing;

create or replace function public.scan_and_alert_ops()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_state public.ops_alert_state%rowtype;
  v_webhook text;
  v_errors integer;
  v_failed integer;
  v_last_tick timestamptz;
  v_lines text := '';
  v_now timestamptz := now();
begin
  select decrypted_secret into v_webhook
    from vault.decrypted_secrets where name = 'ops_slack_webhook_url' limit 1;
  if v_webhook is null then
    return jsonb_build_object('status', 'no_webhook_configured');
  end if;

  select * into v_state from public.ops_alert_state where id = 1 for update;

  select count(*) into v_errors
    from public.error_logs
   where severity = 'error' and created_at > v_state.last_scanned_at;

  select count(*) into v_failed
    from public.actions
   where status = 'failed_permanent' and completed_at > v_state.last_scanned_at;

  select max(d.start_time) into v_last_tick
    from cron.job j join cron.job_run_details d on d.jobid = j.jobid
   where j.jobname = 'dispatch-pending-actions' and d.status = 'succeeded';

  if v_errors > 0 then
    v_lines := v_lines || format(':rotating_light: %s new engine error(s) since %s'
      || E'\n', v_errors, to_char(v_state.last_scanned_at, 'HH24:MI'));
  end if;
  if v_failed > 0 then
    v_lines := v_lines || format(':x: %s action(s) failed permanently' || E'\n', v_failed);
  end if;
  if v_last_tick is not null and v_last_tick < v_now - interval '5 minutes'
     and (v_state.last_heartbeat_alert_at is null
          or v_state.last_heartbeat_alert_at < v_now - interval '30 minutes') then
    v_lines := v_lines || format(':heartbeat: dispatcher last succeeded %s - STALLED?' || E'\n',
      to_char(v_last_tick, 'YYYY-MM-DD HH24:MI'));
    update public.ops_alert_state set last_heartbeat_alert_at = v_now where id = 1;
  end if;

  update public.ops_alert_state set last_scanned_at = v_now where id = 1;

  if v_lines = '' then
    return jsonb_build_object('status', 'quiet');
  end if;

  perform net.http_post(
    url := public.get_functions_base_url() || '/functions/v1/notify-operator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.get_internal_dispatch_key()
    ),
    body := jsonb_build_object('webhook_url', v_webhook, 'text',
      '*Follow-Up Engine* ' || E'\n' || v_lines),
    timeout_milliseconds := 15000
  );

  return jsonb_build_object('status', 'alerted', 'errors', v_errors, 'failed', v_failed);
end;
$$;

revoke execute on function public.scan_and_alert_ops() from public, anon, authenticated;
grant execute on function public.scan_and_alert_ops() to service_role;

do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'ops-alert-scan') then
    perform cron.schedule('ops-alert-scan', '*/5 * * * *',
      'select public.scan_and_alert_ops();');
  end if;
end
$do$;
