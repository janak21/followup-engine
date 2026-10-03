-- Performance hardening: add btree indexes on foreign key columns flagged by
-- the Supabase performance advisor (unindexed_foreign_keys). Naming convention
-- is idx_<table>_<column>. All statements are idempotent.

create index if not exists idx_ai_reply_events_agent_id
  on public.ai_reply_events (agent_id);

create index if not exists idx_ai_reply_events_inbound_event_id
  on public.ai_reply_events (inbound_event_id);

create index if not exists idx_ai_reply_events_outbound_action_id
  on public.ai_reply_events (outbound_action_id);

create index if not exists idx_events_action_id
  on public.events (action_id);

create index if not exists idx_google_oauth_states_sender_id
  on public.google_oauth_states (sender_id);

create index if not exists idx_google_oauth_states_tenant_id
  on public.google_oauth_states (tenant_id);

create index if not exists idx_import_batches_tenant_id
  on public.import_batches (tenant_id);

create index if not exists idx_journey_versions_tenant_id
  on public.journey_versions (tenant_id);

create index if not exists idx_journey_webhook_samples_result_run_id
  on public.journey_webhook_samples (result_run_id);

create index if not exists idx_journeys_ai_agent_id
  on public.journeys (ai_agent_id);

create index if not exists idx_leads_assigned_sender_id
  on public.leads (assigned_sender_id);

create index if not exists idx_leads_source_batch_id
  on public.leads (source_batch_id);

create index if not exists idx_suppressions_lead_id
  on public.suppressions (lead_id);

create index if not exists idx_tenant_invites_invited_by
  on public.tenant_invites (invited_by);

create index if not exists idx_tenant_invites_tenant_id
  on public.tenant_invites (tenant_id);

create index if not exists idx_tenant_members_invited_by
  on public.tenant_members (invited_by);

create index if not exists idx_tenants_default_ai_agent_id
  on public.tenants (default_ai_agent_id);
