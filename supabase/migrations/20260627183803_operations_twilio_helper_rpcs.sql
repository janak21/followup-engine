-- Operations dashboard and Twilio status-poll helper RPCs.
--
-- These wrappers are intentionally conservative:
--   * pg_cron / pg_net metadata is queried only through dynamic SQL after
--     checking to_regclass(), so missing extension schemas return an empty set.
--   * Twilio SID polling is tenant-scoped through the outbound event/action row.
--   * Credential resolution returns credentials only for the tenant that
--     produced the matching Twilio event.

CREATE OR REPLACE FUNCTION public.ops_cron_summary()
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  active boolean,
  last_status text,
  last_start timestamptz,
  last_end timestamptz,
  last_return_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
begin
  if to_regclass('cron.job') is null then
    return;
  end if;

  if to_regclass('cron.job_run_details') is null then
    return query execute
      'select j.jobid::bigint,
              j.jobname::text,
              j.schedule::text,
              j.active::boolean,
              null::text as last_status,
              null::timestamptz as last_start,
              null::timestamptz as last_end,
              null::text as last_return_message
         from cron.job j
        order by j.jobname';
    return;
  end if;

  return query execute
    'select j.jobid::bigint,
            j.jobname::text,
            j.schedule::text,
            j.active::boolean,
            d.status::text as last_status,
            d.start_time::timestamptz as last_start,
            d.end_time::timestamptz as last_end,
            d.return_message::text as last_return_message
       from cron.job j
       left join lateral (
         select r.status, r.start_time, r.end_time, r.return_message
           from cron.job_run_details r
          where r.jobid = j.jobid
          order by r.start_time desc nulls last
          limit 1
       ) d on true
      order by j.jobname';
end;
$$;

CREATE OR REPLACE FUNCTION public.ops_pg_net_recent(p_since interval DEFAULT '1 hour'::interval, p_limit integer DEFAULT 30)
RETURNS TABLE (
  id bigint,
  created timestamptz,
  status_code integer,
  is_error boolean,
  url text,
  content_preview text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
begin
  if to_regclass('net._http_response') is null then
    return;
  end if;

  return query execute
    'select r.id::bigint,
            r.created::timestamptz,
            r.status_code::integer,
            (coalesce(r.timed_out, false) or r.error_msg is not null or coalesce(r.status_code, 0) >= 400)::boolean as is_error,
            null::text as url,
            left(
              regexp_replace(
                coalesce(nullif(r.error_msg, ''''), r.content, ''''),
                ''(?i)(authorization|bearer|token|secret|password|api[_-]?key)[^,;[:space:]}\]]*'',
                ''\1=[redacted]'',
                ''g''
              ),
              500
            )::text as content_preview
       from net._http_response r
      where r.created >= now() - $1
      order by r.created desc
      limit $2'
    using coalesce(p_since, '1 hour'::interval), v_limit;
end;
$$;

CREATE OR REPLACE FUNCTION public.list_stale_twilio_sids(p_max integer DEFAULT 200)
RETURNS TABLE (
  provider_id text,
  tenant_id uuid,
  event_id uuid,
  action_id uuid,
  delivery_status text,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  select e.provider_id,
         e.tenant_id,
         e.id as event_id,
         e.action_id,
         e.delivery_status,
         e.created_at
    from public.events e
    left join public.actions a on a.id = e.action_id and a.tenant_id = e.tenant_id
   where e.provider = 'twilio'
     and e.channel = 'sms'
     and e.direction = 'outbound'
     and e.provider_id is not null
     and e.created_at >= now() - interval '7 days'
     and e.created_at <= now() - interval '5 minutes'
     and coalesce(e.delivery_status, lower(e.raw_payload->>'initial_status'), 'queued')
         in ('queued', 'accepted', 'sending', 'sent', 'scheduled')
     and coalesce(a.status, 'completed') not in ('failed', 'failed_permanent', 'cancelled')
   order by e.created_at asc
   limit greatest(1, least(coalesce(p_max, 200), 1000));
$$;

CREATE OR REPLACE FUNCTION public.resolve_twilio_creds_for_sid(p_sid text)
RETURNS TABLE (
  tenant_id uuid,
  has_creds boolean,
  account_sid text,
  auth_token text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  with matched_event as (
    select e.tenant_id
      from public.events e
      left join public.actions a on a.id = e.action_id and a.tenant_id = e.tenant_id
     where e.provider = 'twilio'
       and e.channel = 'sms'
       and e.direction = 'outbound'
       and e.provider_id = p_sid
       and (a.id is null or a.tenant_id = e.tenant_id)
     order by e.created_at desc
     limit 1
  ),
  matched_creds as (
    select m.tenant_id,
           c.config->>'account_sid' as account_sid,
           c.config->>'auth_token' as auth_token
      from matched_event m
      left join public.tenant_credentials c
        on c.tenant_id = m.tenant_id
       and c.provider = 'twilio'
       and c.active = true
     order by c.created_at desc nulls last
     limit 1
  )
  select tenant_id,
         (nullif(account_sid, '') is not null and nullif(auth_token, '') is not null) as has_creds,
         account_sid,
         auth_token
    from matched_creds;
$$;

REVOKE ALL ON FUNCTION public.ops_cron_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_cron_summary() FROM anon;
REVOKE ALL ON FUNCTION public.ops_cron_summary() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_cron_summary() TO service_role;

REVOKE ALL ON FUNCTION public.ops_pg_net_recent(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_pg_net_recent(interval, integer) FROM anon;
REVOKE ALL ON FUNCTION public.ops_pg_net_recent(interval, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_pg_net_recent(interval, integer) TO service_role;

REVOKE ALL ON FUNCTION public.list_stale_twilio_sids(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_stale_twilio_sids(integer) FROM anon;
REVOKE ALL ON FUNCTION public.list_stale_twilio_sids(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_stale_twilio_sids(integer) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_twilio_creds_for_sid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_twilio_creds_for_sid(text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_twilio_creds_for_sid(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_twilio_creds_for_sid(text) TO service_role;
