-- Phase 1 (run-centric journeys): journey_runs becomes the enrollment record.
-- Adds per-run step state and enforces at most ONE running run per
-- (tenant, lead, journey). Re-entry after exit = new row. Event-workflow runs
-- with lead_id NULL are unaffected (NULLs are distinct in unique indexes).

alter table public.journey_runs
  add column if not exists current_step integer not null default 0,
  add column if not exists next_action_at timestamptz,
  add column if not exists responded boolean not null default false;

create unique index if not exists journey_runs_one_running_per_lead_journey
  on public.journey_runs (tenant_id, lead_id, journey_id)
  where status = 'running';

create index if not exists journey_runs_lead_running_idx
  on public.journey_runs (tenant_id, lead_id)
  where status = 'running';
