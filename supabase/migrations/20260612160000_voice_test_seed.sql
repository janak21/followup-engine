-- Migration: Seed test_voice_journey for Retell verification
-- Created at: 2026-06-12T16:35:00+05:30

insert into journeys (tenant_id, journey_key, name, spec, active)
values (
  '00000000-0000-0000-0000-000000000001',
  'test_voice_journey',
  'Test Voice Journey',
  '{
    "key": "test_voice_journey",
    "name": "Test Voice Journey",
    "trigger": "lead.enrolled",
    "steps": [
      {
        "index": 0,
        "type": "call",
        "template_key": "demo_call_1",
        "delay": { "amount": 0, "unit": "minutes" },
        "business_hours_only": false,
        "on_outcome": {
          "answered": { "exit": "completed" },
          "no_answer": { "next_step": 1 },
          "voicemail": { "next_step": 1 }
        }
      },
      {
        "index": 1,
        "type": "sms",
        "template_key": "demo_sms_1",
        "delay": { "amount": 5, "unit": "minutes" },
        "business_hours_only": false,
        "on_outcome": {
          "delivered": { "exit": "completed" }
        }
      }
    ],
    "exit_conditions": []
  }'::jsonb,
  true
) on conflict (tenant_id, journey_key, version) do update
set spec = excluded.spec,
    name = excluded.name,
    active = excluded.active;
