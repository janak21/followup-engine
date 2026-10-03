# Production Launch Runbook

Use this runbook for a new production Supabase project. Dev project
`your-project-ref` remains a sandbox; tenant data is onboarded fresh.

## 0. Dev Inventory

1. Dev URL leak scan before Phase 7 returned only `dispatch_pending_actions`; after Phase 7 it returns only `get_functions_base_url`, which is the intentional fallback.
2. Dev cron jobs: `dispatch-pending-actions`, `poll-gmail-inbox`, `ops-alert-scan`, `prune-engine-history`.
3. Dev Vault secrets: `internal_dispatch_key`. Prod also needs `functions_base_url` and `ops_slack_webhook_url`.
4. Dev storage buckets: `csv-uploads`, private.
5. Active edge functions: `dispatch-gmail-email`, `dispatch-retell-call`, `dispatch-twilio-sms`, `generate-ai-reply`, `journey-trigger`, `poll-gmail-inbox`, `retell-result`, `twilio-inbound`, `twilio-status`, `twilio-status-poll`, `notify-operator`.
6. Deleted edge function check: `dispatch-workflow-http-request` is not deployed.
7. Edge env vars in use: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_DISPATCH_KEY`.
8. Dashboard env vars in use: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_DISPATCH_KEY`, `NEXT_PUBLIC_WEBHOOK_BASE_URL`, `ALLOW_ANON_TENANT`.
9. Auth setting: leaked-password protection is OFF in dev; turn it ON for prod and dev.
10. Known dev migration-history caveat: dev was MCP-applied over time and has historical migration name drift. Do not `supabase db push` against dev. Prod is replayed fresh from repo files.

## 1. Create Prod Project

1. In Supabase Dashboard, create a new project.
2. Select Postgres 17.
3. Choose the production region closest to clients.
4. Record the project ref as `<prod-ref>`.

## 2. Replay Schema

1. Install/login Supabase CLI.
2. From repo root:

```bash
supabase link --project-ref <prod-ref>
supabase db push
```

3. Alternative: apply each `supabase/migrations/*.sql` file in order through MCP `apply_migration`.
4. Do not edit historical migrations to make prod replay pass; add repair migrations only.

## 3. Vault Secrets

1. Set `internal_dispatch_key` to a new random secret.
2. Set `functions_base_url` to `https://<prod-ref>.supabase.co`.
3. Set `ops_slack_webhook_url` to the production Slack incoming webhook.

## 4. Edge Functions

1. Deploy each function with `verify_jwt=false`; internal functions perform their own bearer checks.
2. Set env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_DISPATCH_KEY`.
3. Deploy: `dispatch-gmail-email`, `dispatch-retell-call`, `dispatch-twilio-sms`, `generate-ai-reply`, `journey-trigger`, `poll-gmail-inbox`, `retell-result`, `twilio-inbound`, `twilio-status`, `twilio-status-poll`, `notify-operator`.

## 5. Auth Settings

1. Enable leaked-password protection in Supabase Auth.
2. Disable public signups unless explicitly needed.
3. Repeat leaked-password protection enablement in dev.

## 6. Storage

1. Verify `csv-uploads` exists.
2. Verify it is private.
3. Verify upload/read policies still match the dashboard import flow.

## 7. External Webhooks

1. Twilio inbound webhook: set the phone number "A MESSAGE COMES IN" URL to `https://<prod-ref>.supabase.co/functions/v1/twilio-inbound`.
2. Twilio status callbacks: set send/status callback URLs to `https://<prod-ref>.supabase.co/functions/v1/twilio-status`.
3. Retell post-call webhook: set to `https://<prod-ref>.supabase.co/functions/v1/retell-result`.
4. Google OAuth redirect URIs: add the production dashboard origin callback URL for each Workspace OAuth client.
5. `resolve_tenant_by_phone` depends on tenant sender/phone configuration; verify prod tenant phone rows before smoke tests.

## 8. Dashboard Env

1. Set `NEXT_PUBLIC_SUPABASE_URL=https://<prod-ref>.supabase.co`.
2. Set `NEXT_PUBLIC_SUPABASE_ANON_KEY=<prod anon key>`.
3. Set `SUPABASE_SERVICE_ROLE_KEY=<prod service role key>`.
4. Set `INTERNAL_DISPATCH_KEY` to match Vault `internal_dispatch_key`.
5. Set `NEXT_PUBLIC_WEBHOOK_BASE_URL` to the production dashboard/webhook base when used.
6. If `SUPABASE_SERVICE_ROLE_KEY` is missing, hardened RPC grants will surface permission errors in server routes.

## 9. Backups

1. Enable PITR/backups in Supabase Dashboard.
2. Select the paid tier/window required by the launch risk profile.

## 10. Smoke Suite

1. Run drift-check:

```bash
cd dashboard
npm run drift-check
```

2. Verify cron jobs:

```sql
select jobname, schedule, command from cron.job order by jobname;
select public.scan_and_alert_ops();
select public.prune_engine_history();
```

3. Verify dispatcher:

```sql
select count(*) from public.dispatch_pending_actions('prod-smoke', 50);
select public.get_functions_base_url();
```

4. Create a synthetic wait-journey enrollment and confirm cron completes it.
5. Send a Twilio inbound webhook test and confirm `twilio-inbound` records an event.
6. Send a Retell result test and confirm `retell-result` records outcome state.
7. Insert a fake `severity='error'` row, run `scan_and_alert_ops()`, confirm Slack receives the alert, then delete the fake row.

## 11. Tenant Onboarding

1. Create tenant row.
2. Configure Twilio, Retell, Gmail OAuth, and AI provider credentials.
3. Configure senders and OAuth connection.
4. Set timezone and business hours.
5. Import suppressions.
6. Publish first journey.
7. Enroll one test lead and verify call/SMS/email behavior end to end.
