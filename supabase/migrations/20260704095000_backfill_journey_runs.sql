-- Phase 1 backfill: every lead currently active in a journey gets a running
-- journey_run, and its in-flight actions are linked to that run. Idempotent
-- via the backfill idempotency key.

insert into public.journey_runs (
  tenant_id, journey_id, journey_key, journey_version,
  mode, trigger_type, status, lead_id,
  current_step, next_action_at, idempotency_key
)
select l.tenant_id, j.id, l.journey_template, j.version,
       'lead_journey', 'backfill', 'running', l.id,
       coalesce(l.current_step, 0), l.next_action_at,
       'backfill:' || l.id::text || ':' || l.journey_template
  from public.leads l
  join lateral (
    select id, version from public.journeys j
     where j.tenant_id = l.tenant_id and j.journey_key = l.journey_template and j.active
     order by version desc limit 1
  ) j on true
 where l.journey_status = 'active'
   and coalesce(l.journey_template, '') <> ''
   -- guard: skip leads that already got a running run for this journey via the
   -- new RPC — inserting would violate journey_runs_one_running_per_lead_journey,
   -- which the on-conflict clause below does NOT arbitrate.
   and not exists (
     select 1 from public.journey_runs r
      where r.tenant_id = l.tenant_id
        and r.lead_id = l.id
        and r.journey_key = l.journey_template
        and r.status = 'running'
   )
on conflict (tenant_id, idempotency_key) where idempotency_key is not null
do nothing;

update public.actions a
   set run_id = r.id
  from public.journey_runs r
 where a.run_id is null
   and a.status in ('pending', 'in_progress')
   and r.tenant_id = a.tenant_id
   and r.lead_id = a.lead_id
   and r.status = 'running'
   and r.trigger_type = 'backfill';
