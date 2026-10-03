-- Launch repair 8/n: dashboard RPCs missing on prod (backfill no-op, see
-- repair 5). Bodies from the repo backfill file, md5-verified against dev
-- after apply.
--
-- Applied to follow-up-prod via Supabase MCP on 2026-07-05.

-- ########################################################
-- journey_funnel
-- ########################################################
CREATE OR REPLACE FUNCTION public.journey_funnel(p_journey_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_j journeys;
  v_steps jsonb;
  v_step_summary jsonb;
  v_total int;
begin
  select * into v_j from journeys where id = p_journey_id;
  if not found then return jsonb_build_object('error','journey_not_found'); end if;
  v_steps := coalesce(v_j.spec->'steps','[]'::jsonb);

  select count(*) into v_total
    from leads
   where tenant_id = v_j.tenant_id and journey_template = v_j.journey_key;

  with steps_arr as (
    select (s->>'index')::int as idx,
           s->>'type' as step_type,
           coalesce(s->>'action_name', s->>'template_key', s->>'type') as label
      from jsonb_array_elements(v_steps) s
  ),
  per_lead_step as (
    select a.lead_id,
           a.step_index,
           min(a.created_at) as reached_at
      from actions a
      join leads l on l.id = a.lead_id
     where l.tenant_id = v_j.tenant_id
       and l.journey_template = v_j.journey_key
     group by a.lead_id, a.step_index
  ),
  per_step_counts as (
    select step_index, count(*)::int as reached_count
      from per_lead_step
     group by step_index
  ),
  outcomes as (
    select a.step_index,
           a.status,
           count(*)::int as n
      from actions a
      join leads l on l.id = a.lead_id
     where l.tenant_id = v_j.tenant_id
       and l.journey_template = v_j.journey_key
     group by a.step_index, a.status
  ),
  outcome_agg as (
    select step_index,
           jsonb_object_agg(status, n) as by_status,
           coalesce(sum(n) filter (where status='completed'), 0)::int as completed_count,
           coalesce(sum(n) filter (where status in ('failed','failed_permanent')), 0)::int as failed_count,
           coalesce(sum(n) filter (where status='cancelled'), 0)::int as cancelled_count,
           coalesce(sum(n) filter (where status='pending'), 0)::int as pending_count
      from outcomes group by step_index
  ),
  time_per_lead as (
    select lead_id, step_index, reached_at,
           lag(reached_at) over (partition by lead_id order by step_index) as prev_at
      from per_lead_step
  ),
  median_time as (
    select step_index,
           percentile_cont(0.5) within group (
             order by extract(epoch from (reached_at - prev_at))
           ) as median_seconds_from_prev
      from time_per_lead
     where prev_at is not null
     group by step_index
  )
  select jsonb_agg(
           jsonb_build_object(
             'step_index',                 s.idx,
             'type',                       s.step_type,
             'label',                      s.label,
             'reached_count',              coalesce(pc.reached_count, 0),
             'completed_count',            coalesce(oa.completed_count, 0),
             'failed_count',               coalesce(oa.failed_count, 0),
             'cancelled_count',            coalesce(oa.cancelled_count, 0),
             'pending_count',              coalesce(oa.pending_count, 0),
             'by_status',                  coalesce(oa.by_status, '{}'::jsonb),
             'median_seconds_from_prev',   mt.median_seconds_from_prev
           ) order by s.idx
         )
    into v_step_summary
    from steps_arr s
    left join per_step_counts pc on pc.step_index = s.idx
    left join outcome_agg     oa on oa.step_index = s.idx
    left join median_time     mt on mt.step_index = s.idx;

  return jsonb_build_object(
    'journey_key', v_j.journey_key,
    'name',        v_j.name,
    'total_leads', coalesce(v_total, 0),
    'steps',       coalesce(v_step_summary, '[]'::jsonb)
  );
end;
$function$;


-- ########################################################
-- dashboard_summary
-- ########################################################
CREATE OR REPLACE FUNCTION public.dashboard_summary(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pipeline       jsonb;
  v_channels       jsonb;
  v_call_outcomes  jsonb;
  v_recent_replies jsonb;
begin
  select jsonb_object_agg(journey_status, n)
    into v_pipeline
    from (
      select journey_status, count(*) n
        from leads
       where tenant_id = p_tenant_id
       group by journey_status
    ) p;

  with last30 as (
    select * from events
     where tenant_id = p_tenant_id
       and created_at > now() - interval '30 days'
  ), by_channel as (
    select channel,
           count(*) filter (where direction = 'outbound') as sent,
           count(*) filter (where direction = 'inbound')  as replied,
           count(*) filter (
             where direction = 'outbound'
               and (
                    (channel = 'email' and (raw_payload->>'bounce')::bool = true)
                 or (channel = 'sms'   and sms_status = 'failed')
                 or (channel = 'call'  and call_outcome in ('failed','no_answer','busy','invalid_number'))
               )
           ) as failed
      from last30
     where channel in ('email','sms','call')
     group by channel
  )
  select jsonb_object_agg(channel, jsonb_build_object('sent', sent, 'replied', replied, 'failed', failed))
    into v_channels
    from by_channel;

  select jsonb_object_agg(coalesce(call_outcome,'unknown'), n)
    into v_call_outcomes
    from (
      select call_outcome, count(*) n
        from events
       where tenant_id = p_tenant_id
         and channel = 'call'
         and created_at > now() - interval '30 days'
       group by call_outcome
    ) c;

  select jsonb_agg(j order by at desc)
    into v_recent_replies
    from (
      select jsonb_build_object(
        'id',        e.id,
        'lead_id',   e.lead_id,
        'lead_name', trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')),
        'channel',   e.channel,
        'body',      left(coalesce(e.body,''), 280),
        'from',      e.from_address,
        'at',        e.created_at
      ) as j, e.created_at as at
        from events e
        join leads  l on l.id = e.lead_id   -- INNER join: must be a lead in our system
       where e.tenant_id = p_tenant_id
         and e.direction = 'inbound'
         and coalesce((e.raw_payload->>'bounce')::bool, false) = false
       order by e.created_at desc
       limit 10
    ) sub;

  return jsonb_build_object(
    'pipeline',       coalesce(v_pipeline,        '{}'::jsonb),
    'channels_30d',   coalesce(v_channels,        '{}'::jsonb),
    'call_outcomes',  coalesce(v_call_outcomes,   '{}'::jsonb),
    'recent_replies', coalesce(v_recent_replies,  '[]'::jsonb)
  );
end;
$function$;


-- ########################################################
-- error_groups
-- ########################################################
CREATE OR REPLACE FUNCTION public.error_groups(p_tenant_id uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(signature text, workflow_name text, count integer, first_seen timestamp with time zone, last_seen timestamp with time zone, severity text, sample_id uuid, sample_message text, sample_raw jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with normalized as (
    select id, workflow_name, severity, error_message, raw_error, created_at,
           left(
             regexp_replace(
               regexp_replace(
                 regexp_replace(coalesce(error_message,'(no message)'),
                   '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 'UUID', 'g'),
                 '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*', 'TS', 'g'),
               '\d{4,}', 'N', 'g'),
             120
           ) as sig
      from error_logs
     where tenant_id = p_tenant_id
       and created_at > now() - interval '90 days'
  ),
  grouped as (
    select sig, workflow_name, count(*) as cnt,
           min(created_at) as first_seen, max(created_at) as last_seen,
           max(severity) as severity,
           (array_agg(id order by created_at desc))[1] as sample_id,
           (array_agg(error_message order by created_at desc))[1] as sample_message,
           (array_agg(raw_error order by created_at desc))[1] as sample_raw
      from normalized
     group by sig, workflow_name
  )
  select sig, workflow_name, cnt, first_seen, last_seen, severity,
         sample_id, sample_message, sample_raw
    from grouped
   order by last_seen desc
   limit p_limit;
$function$;


do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('journey_funnel','dashboard_summary','error_groups')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
