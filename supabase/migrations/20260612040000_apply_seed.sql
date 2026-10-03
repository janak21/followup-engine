-- Apply updated seed data (demo_journey_1 spec and demo_email_2 template) to remote database

-- 1. Insert/update seed tenant
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

-- 2. Insert/update seed template 1
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

-- 3. Insert/update seed template 2
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

-- 4. Insert/update seed journey spec
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
