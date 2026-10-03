-- Performance hardening: consolidate redundant permissive RLS policies.
--
-- The Supabase advisor flags tables with multiple permissive policies for the
-- same role+action. The common pattern here is one ALL policy for the service
-- role plus one SELECT policy for tenant-scoped users. Because an ALL policy
-- also applies to SELECT, the effective SELECT path is evaluated through two
-- policies. This migration splits the service-role policy by command and
-- merges the SELECT path into a single policy, preserving exact visibility.
--
-- Equivalence for each pattern is documented inline. Auth calls are wrapped
-- in (select ...) so the auth_rls_initplan fix remains in place.

-- ============================================================
-- Pattern A: service-role ALL + tenant SELECT
-- Tables: actions, error_logs, events, import_batches, journeys,
--         leads, retell_agents, retell_phone_numbers, senders,
--         suppressions, templates, tenant_credentials
--
-- Original SELECT admission: service_role OR tenant_id matches JWT tenant_id
-- Original DML admission:   service_role only
-- New SELECT admission:     same single OR expression
-- New DML admission:        same service_role-only expression, split by cmd
-- ============================================================

-- public.actions
 drop policy if exists "service role full access" on public.actions;
 drop policy if exists "tenants see own actions" on public.actions;
create policy "tenants and service role see actions" on public.actions for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts actions" on public.actions for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates actions" on public.actions for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes actions" on public.actions for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.error_logs
 drop policy if exists "service role full access" on public.error_logs;
 drop policy if exists "tenants see own error_logs" on public.error_logs;
create policy "tenants and service role see error_logs" on public.error_logs for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts error_logs" on public.error_logs for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates error_logs" on public.error_logs for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes error_logs" on public.error_logs for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.events
 drop policy if exists "service role full access" on public.events;
 drop policy if exists "tenants see own events" on public.events;
create policy "tenants and service role see events" on public.events for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts events" on public.events for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates events" on public.events for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes events" on public.events for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.import_batches
 drop policy if exists "service role full access" on public.import_batches;
 drop policy if exists "tenants see own import_batches" on public.import_batches;
create policy "tenants and service role see import_batches" on public.import_batches for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts import_batches" on public.import_batches for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates import_batches" on public.import_batches for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes import_batches" on public.import_batches for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.journeys
 drop policy if exists "service role full access" on public.journeys;
 drop policy if exists "tenants see own journeys" on public.journeys;
create policy "tenants and service role see journeys" on public.journeys for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts journeys" on public.journeys for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates journeys" on public.journeys for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes journeys" on public.journeys for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.leads
 drop policy if exists "service role full access" on public.leads;
 drop policy if exists "tenants see own leads" on public.leads;
create policy "tenants and service role see leads" on public.leads for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts leads" on public.leads for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates leads" on public.leads for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes leads" on public.leads for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.retell_agents
 drop policy if exists "service role full access" on public.retell_agents;
 drop policy if exists "tenants see own retell_agents" on public.retell_agents;
create policy "tenants and service role see retell_agents" on public.retell_agents for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts retell_agents" on public.retell_agents for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates retell_agents" on public.retell_agents for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes retell_agents" on public.retell_agents for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.retell_phone_numbers
 drop policy if exists "service role full access" on public.retell_phone_numbers;
 drop policy if exists "tenants see own retell_phone_numbers" on public.retell_phone_numbers;
create policy "tenants and service role see retell_phone_numbers" on public.retell_phone_numbers for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts retell_phone_numbers" on public.retell_phone_numbers for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates retell_phone_numbers" on public.retell_phone_numbers for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes retell_phone_numbers" on public.retell_phone_numbers for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.senders
 drop policy if exists "service role full access" on public.senders;
 drop policy if exists "tenants see own senders" on public.senders;
create policy "tenants and service role see senders" on public.senders for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts senders" on public.senders for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates senders" on public.senders for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes senders" on public.senders for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.suppressions
 drop policy if exists "service role full access" on public.suppressions;
 drop policy if exists "tenants see own suppressions" on public.suppressions;
create policy "tenants and service role see suppressions" on public.suppressions for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts suppressions" on public.suppressions for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates suppressions" on public.suppressions for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes suppressions" on public.suppressions for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.templates
 drop policy if exists "service role full access" on public.templates;
 drop policy if exists "tenants see own templates" on public.templates;
create policy "tenants and service role see templates" on public.templates for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts templates" on public.templates for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates templates" on public.templates for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes templates" on public.templates for delete to public using (((select auth.role()) = 'service_role'::text));

-- public.tenant_credentials
 drop policy if exists "service role full access" on public.tenant_credentials;
 drop policy if exists "tenants see own tenant_credentials" on public.tenant_credentials;
create policy "tenants and service role see tenant_credentials" on public.tenant_credentials for select to public using (((select auth.role()) = 'service_role'::text) or ((tenant_id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts tenant_credentials" on public.tenant_credentials for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates tenant_credentials" on public.tenant_credentials for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes tenant_credentials" on public.tenant_credentials for delete to public using (((select auth.role()) = 'service_role'::text));

-- ============================================================
-- Pattern B: membership-based read + operator/owner write
--
-- For SELECT, the write policy's condition is a subset of the read policy's
-- condition, so they merge into a single SELECT policy. DML stays split by
-- command with the stricter write condition.
-- ============================================================

-- public.lead_segments
-- Original SELECT: member_read (any member) OR operator_write (owner/admin/member) -> any member
-- Original DML:    operator_write (owner/admin/member)
 drop policy if exists "lead_segments_member_read" on public.lead_segments;
 drop policy if exists "lead_segments_operator_write" on public.lead_segments;
create policy "lead_segments_member_read" on public.lead_segments for select to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid()))))));
create policy "lead_segments_operator_write_insert" on public.lead_segments for insert to public with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));
create policy "lead_segments_operator_write_update" on public.lead_segments for update to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))))) with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));
create policy "lead_segments_operator_write_delete" on public.lead_segments for delete to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = lead_segments.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));

-- public.tenant_invites
-- Original SELECT: member_read (any member) OR owner_write (owner/admin/member) -> any member
-- Original DML:    owner_write (owner/admin/member)
 drop policy if exists "tenant_invites_member_read" on public.tenant_invites;
 drop policy if exists "tenant_invites_owner_write" on public.tenant_invites;
create policy "tenant_invites_member_read" on public.tenant_invites for select to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid()))))));
create policy "tenant_invites_owner_write_insert" on public.tenant_invites for insert to public with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));
create policy "tenant_invites_owner_write_update" on public.tenant_invites for update to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))))) with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));
create policy "tenant_invites_owner_write_delete" on public.tenant_invites for delete to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_invites.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))));

-- public.tenant_members
-- Original SELECT: self_read (user_id = auth.uid()) OR owner_write (is owner)
-- Original DML:    owner_write (is owner)
 drop policy if exists "tenant_members_owner_write" on public.tenant_members;
 drop policy if exists "tenant_members_self_read" on public.tenant_members;
create policy "tenant_members_read" on public.tenant_members for select to public using ((user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_members.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = 'owner'::text)))));
create policy "tenant_members_owner_write_insert" on public.tenant_members for insert to public with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_members.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = 'owner'::text)))));
create policy "tenant_members_owner_write_update" on public.tenant_members for update to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_members.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = 'owner'::text))))) with check ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_members.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = 'owner'::text)))));
create policy "tenant_members_owner_write_delete" on public.tenant_members for delete to public using ((EXISTS ( SELECT 1
   FROM tenant_members m
  WHERE ((m.tenant_id = tenant_members.tenant_id) AND (m.user_id = (select auth.uid())) AND (m.role = 'owner'::text)))));

-- ============================================================
-- Pattern C: tenants table (service-role ALL + tenant SELECT on id)
-- ============================================================

-- public.tenants
 drop policy if exists "service role full access" on public.tenants;
 drop policy if exists "tenants see own row" on public.tenants;
create policy "tenants and service role see tenants" on public.tenants for select to public using (((select auth.role()) = 'service_role'::text) or ((id)::text = ((select auth.jwt()) ->> 'tenant_id'::text)));
create policy "service role inserts tenants" on public.tenants for insert to public with check (((select auth.role()) = 'service_role'::text));
create policy "service role updates tenants" on public.tenants for update to public using (((select auth.role()) = 'service_role'::text)) with check (((select auth.role()) = 'service_role'::text));
create policy "service role deletes tenants" on public.tenants for delete to public using (((select auth.role()) = 'service_role'::text));
