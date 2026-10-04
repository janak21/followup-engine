-- Repair production security advisor findings after fresh replay.
-- These tables are dashboard/backend-managed and should not be publicly
-- readable through the Data API.
alter table public.ai_agents enable row level security;
alter table public.ai_agent_knowledge enable row level security;
alter table public.ai_reply_events enable row level security;
alter table public.journey_webhook_samples enable row level security;
alter table public.journey_triggers enable row level security;
alter table public.ops_alert_state enable row level security;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'ai_agents',
    'ai_agent_knowledge',
    'ai_reply_events',
    'journey_webhook_samples',
    'journey_triggers',
    'ops_alert_state'
  ]
  loop
    if not exists (
      select 1
        from pg_policies
       where schemaname = 'public'
         and tablename = v_table
         and policyname = 'service role full access'
    ) then
      execute format(
        'create policy "service role full access" on public.%I for all to service_role using (true) with check (true)',
        v_table
      );
    end if;
  end loop;
end $$;
