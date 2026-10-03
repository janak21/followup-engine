-- Phase 2: actions is the single queue. Event-native steps may run before a
-- lead exists, so lead_id becomes nullable — but every lead-touching type
-- still requires it. journey_runs.lead_id is the handoff: create/find-lead
-- handlers set it, and advance_journey stamps it onto subsequent actions.

alter table public.actions
  alter column lead_id drop not null;

alter table public.actions
  add constraint actions_lead_required_types check (
    lead_id is not null
    or action_type in (
      'create_lead_from_payload',
      'find_lead_from_payload',
      'conditional_split',
      'wait',
      'http_request',
      'exit_flow',
      'team_alert'
    )
  );

-- Leadless actions can only be located via run; index the pair.
create index if not exists actions_run_pending_idx
  on public.actions (run_id, status)
  where run_id is not null;
