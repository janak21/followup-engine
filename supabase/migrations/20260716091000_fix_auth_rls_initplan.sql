-- Performance hardening: fix auth_rls_initplan warnings.
--
-- The Supabase performance advisor flags RLS policies that call auth.role(),
-- auth.uid(), or auth.jwt() directly, because those functions are evaluated
-- once per row. Wrapping them in (select auth.<fn>()) forces PostgreSQL to
-- treat them as stable scalar subqueries and evaluate them once per query.
--
-- This migration drops and recreates every flagged policy with identical
-- USING / WITH CHECK semantics; only the auth-call wrapping changes.

-- public.actions
 drop policy if exists "service role full access" on public.actions;
create policy "service role full access" on public.actions as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own actions" on public.actions;
create policy "tenants see own actions" on public.actions as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.ai_agent_knowledge
 drop policy if exists "service role full access" on public.ai_agent_knowledge;
create policy "service role full access" on public.ai_agent_knowledge as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));

-- public.ai_agents
 drop policy if exists "service role full access" on public.ai_agents;
create policy "service role full access" on public.ai_agents as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));

-- public.ai_reply_events
 drop policy if exists "service role full access" on public.ai_reply_events;
create policy "service role full access" on public.ai_reply_events as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));

-- public.audit_log
 drop policy if exists "audit_log_member_read" on public.audit_log;
create policy "audit_log_member_read" on public.audit_log as PERMISSIVE for SELECT to public using (((tenant_id IS NULL) OR (EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = audit_log.tenant_id) AND (m.user_id = (select auth.uid())))))));

-- public.error_logs
 drop policy if exists "service role full access" on public.error_logs;
create policy "service role full access" on public.error_logs as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own error_logs" on public.error_logs;
create policy "tenants see own error_logs" on public.error_logs as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.events
 drop policy if exists "service role full access" on public.events;
create policy "service role full access" on public.events as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own events" on public.events;
create policy "tenants see own events" on public.events as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.google_oauth_states
 drop policy if exists "service role full access" on public.google_oauth_states;
create policy "service role full access" on public.google_oauth_states as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));

-- public.import_batches
 drop policy if exists "service role full access" on public.import_batches;
create policy "service role full access" on public.import_batches as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own import_batches" on public.import_batches;
create policy "tenants see own import_batches" on public.import_batches as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.journey_versions
 drop policy if exists "service role full access on journey_versions" on public.journey_versions;
create policy "service role full access on journey_versions" on public.journey_versions as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));

-- public.journey_webhook_samples
 drop policy if exists "service role full access on samples" on public.journey_webhook_samples;
create policy "service role full access on samples" on public.journey_webhook_samples as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));

-- public.journeys
 drop policy if exists "service role full access" on public.journeys;
create policy "service role full access" on public.journeys as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own journeys" on public.journeys;
create policy "tenants see own journeys" on public.journeys as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.lead_segments
 drop policy if exists "lead_segments_member_read" on public.lead_segments;
create policy "lead_segments_member_read" on public.lead_segments as PERMISSIVE for SELECT to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid()))))));
 drop policy if exists "lead_segments_operator_write" on public.lead_segments;
create policy "lead_segments_operator_write" on public.lead_segments as PERMISSIVE for ALL to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))))) with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));

-- public.leads
 drop policy if exists "service role full access" on public.leads;
create policy "service role full access" on public.leads as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own leads" on public.leads;
create policy "tenants see own leads" on public.leads as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.retell_agents
 drop policy if exists "service role full access" on public.retell_agents;
create policy "service role full access" on public.retell_agents as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own retell_agents" on public.retell_agents;
create policy "tenants see own retell_agents" on public.retell_agents as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.retell_phone_numbers
 drop policy if exists "service role full access" on public.retell_phone_numbers;
create policy "service role full access" on public.retell_phone_numbers as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own retell_phone_numbers" on public.retell_phone_numbers;
create policy "tenants see own retell_phone_numbers" on public.retell_phone_numbers as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.senders
 drop policy if exists "service role full access" on public.senders;
create policy "service role full access" on public.senders as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own senders" on public.senders;
create policy "tenants see own senders" on public.senders as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.suppressions
 drop policy if exists "service role full access" on public.suppressions;
create policy "service role full access" on public.suppressions as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own suppressions" on public.suppressions;
create policy "tenants see own suppressions" on public.suppressions as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.templates
 drop policy if exists "service role full access" on public.templates;
create policy "service role full access" on public.templates as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own templates" on public.templates;
create policy "tenants see own templates" on public.templates as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.tenant_credentials
 drop policy if exists "service role full access" on public.tenant_credentials;
create policy "service role full access" on public.tenant_credentials as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own tenant_credentials" on public.tenant_credentials;
create policy "tenants see own tenant_credentials" on public.tenant_credentials as PERMISSIVE for SELECT to public using (((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));

-- public.tenant_invites
 drop policy if exists "tenant_invites_member_read" on public.tenant_invites;
create policy "tenant_invites_member_read" on public.tenant_invites as PERMISSIVE for SELECT to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid()))))));
 drop policy if exists "tenant_invites_owner_write" on public.tenant_invites;
create policy "tenant_invites_owner_write" on public.tenant_invites as PERMISSIVE for ALL to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))))) with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));

-- public.tenant_members
 drop policy if exists "tenant_members_owner_write" on public.tenant_members;
create policy "tenant_members_owner_write" on public.tenant_members as PERMISSIVE for ALL to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_members.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = 'owner'::text))))) with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_members.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = 'owner'::text)))));
 drop policy if exists "tenant_members_self_read" on public.tenant_members;
create policy "tenant_members_self_read" on public.tenant_members as PERMISSIVE for SELECT to public using ((user_id = (select auth.uid())));

-- public.tenant_usage_daily
 drop policy if exists "tenant_usage_member_read" on public.tenant_usage_daily;
create policy "tenant_usage_member_read" on public.tenant_usage_daily as PERMISSIVE for SELECT to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_usage_daily.tenant_id) AND (m.user_id = (select auth.uid()))))));

-- public.tenants
 drop policy if exists "service role full access" on public.tenants;
create policy "service role full access" on public.tenants as PERMISSIVE for ALL to public using (((select auth.role()) = 'service_role'::text));
 drop policy if exists "tenants see own row" on public.tenants;
create policy "tenants see own row" on public.tenants as PERMISSIVE for SELECT to public using (((id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
