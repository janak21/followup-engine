-- Seed Data for Phase 0

-- 1. Insert seed tenant
insert into tenants (id, name, slug, status, timezone, business_hours, dedup_key, team_alert_email)
values (
  '00000000-0000-0000-0000-000000000001',
  'Internal',
  'internal',
  'active',
  'America/New_York',
  '{"start":"09:00","end":"17:00","days":["Mon","Tue","Wed","Thu","Fri"]}'::jsonb,
  'email',
  'alerts@example.com'
) on conflict (slug) do nothing;

-- 2. Insert seed templates
insert into templates (tenant_id, template_key, channel, subject, body, variables)
values (
  '00000000-0000-0000-0000-000000000001',
  'demo_email_1',
  'email',
  'Hello from Example Co',
  'Hi {{first_name}},\n\nThis is a test email from the new Follow-Up Engine.\n\nBest,\nJanak',
  '["first_name"]'::jsonb
) on conflict (tenant_id, template_key, version) do update 
set subject = excluded.subject,
    body = excluded.body,
    variables = excluded.variables;

insert into templates (tenant_id, template_key, channel, subject, body, variables)
values (
  '00000000-0000-0000-0000-000000000001',
  'demo_email_2',
  'email',
  'Follow up from Example Co',
  'Hi {{first_name}},\n\nJust following up on my last email. Let me know if you have any questions.\n\nBest,\nJanak',
  '["first_name"]'::jsonb
) on conflict (tenant_id, template_key, version) do update 
set subject = excluded.subject,
    body = excluded.body,
    variables = excluded.variables;

-- 3. Insert seed journey
insert into journeys (tenant_id, journey_key, name, spec)
values (
  '00000000-0000-0000-0000-000000000001',
  'demo_journey_1',
  'Demo Email Journey',
  '{
    "key": "demo_journey_1",
    "name": "Demo Email Journey",
    "trigger": "lead.enrolled",
    "steps": [
      {
        "index": 0,
        "type": "email",
        "template_key": "demo_email_1",
        "delay": { "amount": 0, "unit": "minutes" },
        "business_hours_only": false,
        "on_outcome": {
          "sent": { "next_step": 1 }
        }
      },
      {
        "index": 1,
        "type": "email",
        "template_key": "demo_email_2",
        "delay": { "amount": 5, "unit": "minutes" },
        "business_hours_only": false,
        "on_outcome": {
          "sent": { "exit": "completed" }
        }
      }
    ],
    "exit_conditions": []
  }'::jsonb
) on conflict (tenant_id, journey_key, version) do update 
set name = excluded.name,
    spec = excluded.spec;

-- 4. Local-only setup. Seeds run on `supabase start` / `supabase db reset`,
--    never on `supabase db push`, so none of this reaches a hosted project.

-- The cron dispatcher reaches Edge Functions through the local API gateway
-- container and signs each call with the internal dispatch key. The key must
-- match INTERNAL_DISPATCH_KEY in supabase/functions/.env.
select vault.create_secret('http://supabase_kong_followup-engine:8000', 'functions_base_url')
 where not exists (select 1 from vault.secrets where name = 'functions_base_url');
select vault.create_secret('local-dev-dispatch-key', 'internal_dispatch_key')
 where not exists (select 1 from vault.secrets where name = 'internal_dispatch_key');

-- Signing up as demo@example.com makes you owner of the seed workspace
-- (the trg_consume_invites trigger on auth.users turns the invite into a membership).
insert into tenant_invites (tenant_id, email, role)
values ('00000000-0000-0000-0000-000000000001', 'demo@example.com', 'owner')
on conflict (email, tenant_id) do nothing;
