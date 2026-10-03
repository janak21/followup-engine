# ADR 001: Legacy Multi-Tenant Credential Routing and Resolution

Status: Superseded by the native Supabase dispatcher and Edge Function provider paths.

## Context
The `followup-engine` needed to support a multi-tenant model where adding a new tenant took under 60 minutes via SQL only, without requiring workflow code modifications in the legacy external runtime.
Each tenant will have their own communications credentials (e.g., Gmail accounts, Twilio credentials, and Retell AI agents).

## Decision
Historical decision: credentials were routed dynamically using expressions inside legacy workflows based on metadata returned by the database. Current native dispatch reads provider credentials directly from Supabase tables and Edge Function runtime secrets.

1. **Email Channel (Gmail):**
   - The database RPC `get_email_payload` selects a sender from the `senders` pool for the tenant (caching it on `leads.assigned_sender_id` to ensure thread continuity).
   - The payload returned to the legacy workflow included `gmail_credential_name`.
   - The legacy Gmail node used an expression-based credential:
     - ID: `={{ $json.gmail_credential_id }}` (left empty/evaluates to empty)
     - Name: `={{ $json.gmail_credential_name }}`
   - The legacy runtime matched credentials dynamically by Name if ID was blank.

2. **SMS and Call Channels (Twilio / Retell AI):**
   - The database RPCs `get_sms_payload` and `get_call_payload` look up active tenant credentials from the `tenant_credentials` table by provider key.
   - The returned payloads include `twilio_credential_name` / `retell_credential_name` and config attributes (like `from_number` or `agent_id`).
   - Workflows reference these names dynamically for authorization.

## Consequences
- **Zero-Code Onboarding:** Tenants could be fully onboarded by inserting database rows and configuring a matching credential name in the legacy workflow runtime.
- **Strict Isolation:** Senders and tenant credentials are filtered by the action's `tenant_id` at the SQL schema level, ensuring no cross-talk or leak.
- **Fail Loudly:** If a tenant does not have a configured credential or sender, the RPC returns `no_sender` or raises an exception, causing the system to retry or log an error instead of using a silent mock fallback.
