-- Supabase stopped auto-granting Data API access to new tables on 2026-05-30
-- (auto_expose_new_tables defaults to false). Projects created before that got
-- these grants implicitly; on a fresh project every dashboard query fails with
-- "permission denied for table ...". Grant them explicitly.
--
-- service_role: the dashboard's server-side client.
-- authenticated: the browser client (realtime on leads). Every public table has
-- RLS enabled, so policies still decide which rows a signed-in user sees.
-- anon gets nothing: the app never reads tables without a session.

grant select, insert, update, delete on all tables in schema public to service_role, authenticated;
grant usage, select on all sequences in schema public to service_role, authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role, authenticated;
alter default privileges in schema public
  grant usage, select on sequences to service_role, authenticated;
