# Follow-Up Engine: guide for coding agents

A multi-tenant engine that follows up with leads over email (Gmail), SMS (Twilio) and AI voice calls (Retell). Supabase Postgres holds the data and the work queue, `pg_cron` dispatches due work to Deno Edge Functions, and a Next.js dashboard manages it all. See `README.md` for the product overview.

## Setting the project up for a user

Run these from the repo root. Check the result of each step before moving on. Prerequisites: Docker running, the Supabase CLI, Node.js 20.9 or later.

1. **Start Supabase.** `supabase start`. This applies every migration in `supabase/migrations/` and runs `supabase/seed.sql`.
   Check: `supabase status` lists the API URL. If a migration fails, stop and report the file and the error; don't edit migrations to get past it.

2. **Serve the Edge Functions.** Run this as a long-lived background process:
   ```bash
   cp supabase/functions/.env.example supabase/functions/.env
   supabase functions serve
   ```
   Check: the output ends with `Using supabase-edge-runtime`.

3. **Write the dashboard env and start it.** Run this as a long-lived background process:
   ```bash
   supabase status -o env \
     --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
     --override-name auth.anon_key=NEXT_PUBLIC_SUPABASE_ANON_KEY \
     --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY \
     | grep -E '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)=' > dashboard/.env.local
   echo 'INTERNAL_DISPATCH_KEY=local-dev-dispatch-key' >> dashboard/.env.local
   cd dashboard && npm install && npm run dev
   ```
   Check: `dashboard/.env.local` has 4 lines, and `npm run dev` prints a local URL. If port 3000 is taken, Next picks another one; use the port it prints.

4. **Tell the user how to sign in.** They sign up at `<dashboard url>/auth/signup` with `demo@example.com` and any password of 8 or more characters. That email has a seeded owner invite for the demo workspace. Any other email signs up but lands on "No workspace yet".
   To check it without a browser:
   ```bash
   docker exec supabase_db_followup-engine psql -U postgres -tAc \
     "select u.email, m.role from auth.users u join tenant_members m on m.user_id = u.id"
   ```

5. **Optional end-to-end check.** After the user adds a lead on the Leads page with the "Demo Email Journey", the cron dispatcher calls `dispatch-gmail-email` within 30 seconds. It answers "No sender available". After three retries over a few minutes, the action becomes `failed_permanent` and appears under "Needs attention" on the dashboard. That's the expected result until a Gmail sender is connected on the Settings page.
   ```bash
   docker exec supabase_db_followup-engine psql -U postgres -tAc \
     "select action_type, status, retry_count, error_message from actions"
   ```

Reset to a clean database with `supabase db reset`. Shut down with `supabase stop`.

Real sends need the user's own Gmail, Twilio and Retell accounts, which they add per workspace on the dashboard's Settings page. Never invent credentials or ask the user to paste secrets into chat.

## Where things are

- `supabase/migrations/`: schema, RPCs and cron jobs. The `actions` table is the single work queue. `dispatch_pending_actions()` (run by `pg_cron`) claims due rows and calls the Edge Functions through `pg_net`.
- `supabase/functions/`: one Deno function per provider direction.
  - Outbound: `dispatch-gmail-email`, `dispatch-twilio-sms`, `dispatch-retell-call`.
  - Inbound and status: `poll-gmail-inbox`, `twilio-inbound`, `twilio-status`, `twilio-status-poll`, `retell-result`.
  - Other: `generate-ai-reply`, `notify-operator`, `journey-trigger`.
  - Shared signature checks live in `_shared/`.
- `supabase/config.toml`: local stack config. Functions that authenticate callers themselves have `verify_jwt = false`.
- `dashboard/src/app/`: Next.js App Router pages, plus API routes under `api/`. Server code uses the service-role client from `src/utils/supabase.js` and must scope every query to the caller's tenant (`getTenantId`, `requireOperator`).
- `dashboard/tests/`: `node --test` suites, mostly static checks over the source, e.g. that API routes are tenant-scoped.
- `docs/decisions/`: why the architecture is the way it is. `docs/runbooks/`: deploying to a hosted project.

## Checks

From `dashboard/`, run all of these before saying a change is done:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

For database changes, also run `supabase db reset` and confirm every migration and the seed apply cleanly.

## Rules

- **Migrations:** never edit or rename a migration that has shipped. Add a new, later-timestamped file instead. Write migrations to be idempotent (`if not exists`, `create or replace`), because they must replay cleanly on a brand-new project.
- **Grants:** new tables, functions and sequences need explicit grants. Supabase no longer grants Data API access implicitly. Enable RLS on every new public table, and keep secret-returning functions callable by `service_role` only.
- **Tenant isolation:** every dashboard API route resolves the tenant from the session and filters by it. Never trust a `tenant_id` sent by the client.
- **Seed data:** `supabase/seed.sql` is local-only demo data. Keep its names, emails and phone numbers obviously fake.
- **Secrets:** don't commit `.env`, `.env.local` or real provider credentials.
