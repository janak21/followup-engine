# Follow-Up Engine

A multi-tenant engine that follows up with leads over email, SMS and AI voice calls, and keeps every reply, call result and next step in one place.

You define a journey (for example: email now, SMS after a day, an AI voice call if there's still no reply). The engine works out when each step should go out, sends it through the right provider, stops when the lead responds, and hands the lead to a person when it needs one.

![Dashboard walkthrough: follow-up overview, leads list and a lead's timeline, journeys, the visual journey builder, AI reply agents and custom fields](docs/followup-engine-demo.gif)

## What it does

- **Email, SMS and voice in one journey.** Gmail for email, Twilio for SMS, Retell AI for voice calls. Each tenant brings its own credentials and sender pool.
- **Voice agent calls with the results recorded.** Calls go out through Retell with the lead's details passed in as dynamic variables. Call results come back on a webhook and are matched to the lead by a `followup_lead_id` stamped on every outbound call.
- **Replies stop the sequence.** Inbound email, SMS and call outcomes cancel pending outbound steps, and email follow-ups reply in the same thread.
- **Business hours and rescheduling.** Steps that would land outside a tenant's business hours, or that fail, are moved to the next valid window.
- **Webhook triggers.** External systems can enrol leads through a webhook. A playground in the dashboard tests JSON paths against sample payloads.
- **Operator handoff.** When a lead needs a person, the engine alerts the team instead of carrying on blindly.
- **Visual journey builder.** Waits, conditional splits, custom fields and per-tenant templates, edited in the dashboard.

## How it's built

```
Dashboard (Next.js)  ──>  Supabase Postgres  ──>  Edge Functions  ──>  Gmail / Twilio / Retell
                          · leads, journeys,       · dispatch-*          (outbound)
                            runs, actions          · poll-gmail-inbox
                          · RPCs + pg_cron         · twilio-inbound      <── replies, call results
                            dispatcher             · retell-result           (inbound)
```

- **Dashboard** (`dashboard/`): Next.js and React with Tailwind and shadcn/ui. It covers tenants, leads, journeys, templates, senders, operations and analytics.
- **Database** (`supabase/migrations/`): Postgres schema and RPCs. The `actions` table is the single work queue, and `pg_cron` with `pg_net` dispatches due actions.
- **Edge Functions** (`supabase/functions/`): one function per provider direction. That's three outbound dispatchers (Gmail, Twilio, Retell), inbound handlers for SMS, email and call results, status polling, AI reply generation, and operator alerts.

The engine first ran on an external workflow runtime and was moved to native Postgres and Edge Functions. The reasoning for each step is written up in [`docs/decisions/`](docs/decisions/).

## Running it locally

```bash
# database
cd supabase
supabase start
supabase db push

# dashboard (set Supabase URL and keys in dashboard/.env.local)
cd ../dashboard
npm install
npm run dev
```

Provider credentials (Gmail, Twilio, Retell) are added per tenant in the dashboard. Edge Function secrets are set with `supabase secrets set`.

## Tests

```bash
cd dashboard
npm test
```

## Notes

Names, emails and phone numbers in seeds, fixtures and examples are made up.

## License

All rights reserved. The source is shared so people can read it; it isn't licensed for reuse.
