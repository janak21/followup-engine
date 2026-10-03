-- Create table journey_webhook_samples if it does not exist
create table if not exists journey_webhook_samples (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid references journeys(id) on delete cascade not null,
  received_at timestamp with time zone default now() not null,
  payload jsonb,
  headers jsonb,
  result_status text,
  result_reason text,
  result_lead_id uuid,
  result_action_id uuid,
  result_message text
);
