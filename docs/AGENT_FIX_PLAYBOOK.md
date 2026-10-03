# Follow-Up Engine — Agent Fix Playbook

Orchestrator: Claude (review) · Implementers: Claude Code / Codex / OpenCode / open-source models.

## How to use this file

Run tickets **in order**. Do not start ticket N+1 until ticket N passes its "Definition of Done"
and I (the reviewer) have approved the diff. Each ticket is a **complete, self-contained prompt** —
paste everything inside the fenced ```PROMPT block``` into your coding agent. Do not summarize or
paraphrase it; the wording is deliberate.

Global rules that apply to every ticket (the agent must obey these even if not repeated):

- **Do not** change files outside the "Files you may touch" list without stopping and asking.
- **Do not** invent new dependencies, frameworks, or abstractions. Use what the repo already uses.
- **Do not** refactor unrelated code, rename things, or "clean up" while fixing. Minimal correct diff only.
- **Do not** delete or weaken existing security checks, tests, or RLS policies.
- Every ticket ends by running `npm run test` in `dashboard/` and `npm run lint`; both must pass.
- If a required fact is unknown, **stop and report** what you need. Never guess a schema column,
  env var name, or function signature — read the actual file/migration first.
- Output at the end of every ticket: (1) list of files changed, (2) a short diff summary,
  (3) exact commands you ran and their results, (4) anything you were unsure about.

Repo layout the agent needs to know:
- Dashboard (Next.js App Router, JS not TS): `dashboard/src/app/api/**/route.js`, utils in `dashboard/src/utils/`.
- Supabase SQL engine: `supabase/migrations/*.sql` (append-only; never edit an applied migration — add a new one).
- Edge functions (Deno): `supabase/functions/<name>/index.ts`.
- Tests: `dashboard/tests/*.test.mjs` run via `node --test`.

Priority order:
1. TICKET-01 — API tenant isolation + role guards (CRITICAL)
2. TICKET-02 — Kill anon-auth bypass in production (CRITICAL)
3. TICKET-03 — Remove hardcoded tenant + mockDb fallback from prod paths (CRITICAL)
4. TICKET-04 — Twilio inbound/status signature validation (CRITICAL)
5. TICKET-05 — Retell webhook shared-secret auth (CRITICAL)
6. TICKET-06 — Encrypt provider secrets at rest (HIGH)
7. TICKET-07 — Make tenant switcher real, or remove the claim (HIGH)
8. TICKET-08 — Resolve `actions.updated_at` schema bug (HIGH)
9. TICKET-09 — Add FK indexes + fix RLS initplan/duplicate policies (MEDIUM)
10. TICKET-10 — Decompose the 6,260-line journey builder (MEDIUM, do last)

---

## TICKET-01 — Enforce tenant isolation and role guards on every API route

```PROMPT
ROLE: You are a senior backend engineer fixing a multi-tenant authorization vulnerability in a
Next.js (App Router, JavaScript) app backed by Supabase. You make the smallest correct change and
you do not touch anything outside the listed files.

CONTEXT (verified facts about this repo):
- Every API route uses a single service-role Supabase client from `dashboard/src/utils/supabase.js`,
  which BYPASSES Postgres RLS. Therefore tenant isolation depends ENTIRELY on each route explicitly
  filtering by tenant_id and checking role. Some routes fail to do this. That is the bug.
- The correct tenant for a request is resolved by `getTenantId(request)` in
  `dashboard/src/utils/tenant.js`. It returns the signed-in user's tenant_id (or throws Unauthorized).
- Role guarding for mutations uses `requireOperator(request)` from `dashboard/src/utils/role.js`.
  Pattern already used elsewhere: `const g = await requireOperator(request); if (g) return g;`
- Read-context resolution is `resolveRequestContext()` in `dashboard/src/utils/role.js`, returning
  `{ user, tenantId, role }`.

TASK: Audit and fix EVERY file matching `dashboard/src/app/api/**/route.js` so that:
  (a) Every handler (GET/POST/PUT/PATCH/DELETE) resolves the tenant via `getTenantId(request)`
      (or `resolveRequestContext`) and filters ALL database reads and writes with
      `.eq('tenant_id', tenantId)`.
  (b) No handler accepts a tenant id, tenant scope, or row id from the request body/query and uses it
      to bypass the resolved tenant. If a body contains an `id` for the tenant being edited, IGNORE it
      and use the resolved tenantId. Cross-tenant writes must be impossible.
  (c) Every state-changing handler (POST/PUT/PATCH/DELETE) calls `requireOperator(request)` first.
  (d) Any route that currently hardcodes a tenant UUID (e.g. the constant
      `'00000000-0000-0000-0000-000000000001'`) is changed to use the resolved tenantId instead.

KNOWN OFFENDERS you MUST fix (confirm by reading each; there may be more — audit all routes):
  - `dashboard/src/app/api/actions/route.js` — GET has no tenant filter and no auth. Add both.
  - `dashboard/src/app/api/tenants/route.js` — GET returns ALL tenants to ANY user. Restrict GET so a
    user only sees tenants they are a member of (join `tenant_members` on the current user id). Keep
    POST guarded by requireOperator.
  - `dashboard/src/app/api/tenant/route.js` — PUT reads `id` from the body and updates that tenant.
    Remove that; always update the tenant returned by `getTenantId(request)`. Ignore body `id`.
  - `dashboard/src/app/api/leads/[id]/route.js` — replace the hardcoded DEFAULT_TENANT_ID constant with
    the resolved tenantId in every query (GET/PUT/DELETE and the nested actions/events reads).

METHOD:
  1. List every file under `dashboard/src/app/api/` named `route.js`.
  2. For each, for each exported handler, verify (a)-(d). Produce a table: file | method | had_tenant_filter | had_guard | action_taken.
  3. Apply the minimal edits. Reuse the exact helper import style already present in sibling routes.
  4. Do NOT change response shapes, status codes, or business logic beyond adding the guard + filter.

DEFINITION OF DONE:
  - `grep -rL "getTenantId\|resolveRequestContext" dashboard/src/app/api --include=route.js` returns only
    routes that legitimately need no tenant (list them explicitly and justify each: e.g. /healthcheck).
  - Every POST/PUT/PATCH/DELETE handler contains a `requireOperator` call.
  - No route contains a hardcoded tenant UUID.
  - Add a test file `dashboard/tests/api-tenant-isolation.test.mjs` that asserts, by static analysis of
    the route source files (read the files as text), that: no `route.js` under api/ contains the string
    `00000000-0000-0000-0000-000000000001`, and every file exporting POST/PUT/PATCH/DELETE also contains
    `requireOperator`. Keep it simple and deterministic.
  - `npm run test` and `npm run lint` pass in `dashboard/`.

FORBIDDEN: introducing per-request Supabase clients scoped by user JWT (that is a larger redesign — not
now), changing RLS, editing migrations, touching edge functions, or altering the UI.

OUTPUT: the audit table, the diff summary, and the test results.
```

**Reviewer check (me):** re-grep for the hardcoded UUID; open `actions/route.js`, `tenants/route.js`,
`tenant/route.js`, `leads/[id]/route.js` and confirm each read/write is tenant-filtered; confirm no
body-supplied tenant id path remains.

---

## TICKET-02 — Make `ALLOW_ANON_TENANT` impossible in production

```PROMPT
ROLE: Senior backend engineer. Minimal correct change only.

CONTEXT (verified): `ALLOW_ANON_TENANT=1` makes the API skip auth and fall back to the first tenant.
It is read in `dashboard/src/utils/tenant.js` (isDevAnonAllowed) and `dashboard/src/utils/role.js`
(requireOperator / resolveRequestContext). It is currently set to 1 in `dashboard/.env.local`. There is
NO safeguard preventing it from being enabled in a production deployment. This is a full authentication
bypass switch.

TASK:
  1. Create `dashboard/src/utils/env.js` exporting a single function `isAnonTenantAllowed()` that returns
     true ONLY when `process.env.ALLOW_ANON_TENANT === '1'` AND `process.env.NODE_ENV !== 'production'`.
  2. Replace every direct read of `ALLOW_ANON_TENANT` in `tenant.js` and `role.js` with a call to
     `isAnonTenantAllowed()`.
  3. Add a hard boot guard: create `dashboard/src/utils/assertSafeEnv.js` exporting `assertSafeEnv()`
     that throws an Error with a clear message if `NODE_ENV === 'production'` AND
     `ALLOW_ANON_TENANT === '1'`. Call `assertSafeEnv()` at module load inside `dashboard/src/utils/env.js`
     so importing env utilities in a prod build with the flag on crashes immediately and loudly.
  4. Do not remove the flag from `.env.local` (dev needs it), but add a comment above it:
     `# DEV ONLY. Never set in production. Enforced by assertSafeEnv().`

DEFINITION OF DONE:
  - `grep -rn "ALLOW_ANON_TENANT" dashboard/src` shows the raw env var read ONLY inside `env.js`
    (and the assert). tenant.js and role.js call the helper.
  - Add `dashboard/tests/anon-tenant-guard.test.mjs` that unit-tests `isAnonTenantAllowed()` and
    `assertSafeEnv()` by setting process.env values in-test: production+flag → assert throws;
    development+flag → allowed true; production without flag → allowed false.
  - `npm run test` and `npm run lint` pass.

FORBIDDEN: touching API routes, SQL, or edge functions. This is a 3-file utility change plus a test.

OUTPUT: files changed, diff summary, test results.
```

---

## TICKET-03 — Remove hardcoded tenant + mockDb fallback from production API paths

```PROMPT
ROLE: Senior backend engineer. Minimal correct change only.

CONTEXT (verified): Several API routes (`dashboard/src/app/api/leads/route.js`,
`.../templates/route.js`, `.../templates/folders/route.js`, `.../journeys/route.js`,
`.../journeys/folders/route.js`) import from `dashboard/src/utils/mockDb.js` and silently return fake
in-memory fixture data (e.g. lead "Sarah Jenkins") when they detect Supabase is "not configured". In
production this converts a misconfiguration into silently-wrong data instead of a loud failure.

TASK:
  1. For each route importing `mockDb`, remove the mock fallback branch. When Supabase is not configured,
     return HTTP 503 with `{ error: "Supabase not configured" }` — the same pattern already used by
     routes like `tenant/route.js` (`isSupabaseConfigured()` → 503). Do NOT serve fixture data.
  2. Keep `mockDb.js` in the repo but ensure it is imported by ZERO files under
     `dashboard/src/app/api/`. (It may remain for local UI storybook/demo use only.)
  3. Verify no remaining hardcoded tenant UUID exists in these routes (coordinate with TICKET-01).

DEFINITION OF DONE:
  - `grep -rln "mockDb" dashboard/src/app/api` returns nothing.
  - Each affected route returns 503 (not fixtures) when unconfigured.
  - Existing tests still pass; add no fixture-dependent behavior.
  - `npm run test` and `npm run lint` pass.

FORBIDDEN: deleting mockDb.js, changing non-API imports of it, altering response schemas beyond the
503 path.

OUTPUT: files changed, diff summary, grep proof, test results.
```

---

## TICKET-04 — Validate Twilio signatures on inbound and status webhooks

```PROMPT
ROLE: Senior engineer working in Supabase Edge Functions (Deno + TypeScript). You implement Twilio's
official request-signature validation. Minimal correct change only.

CONTEXT (verified):
- `supabase/functions/twilio-inbound/index.ts` receives Twilio's inbound-SMS webhook (form-urlencoded)
  and calls the RPC `process_inbound_sms`. It performs NO authenticity check. Anyone who knows the URL
  can forge inbound SMS, trigger opt-outs, cancel journeys.
- `supabase/functions/twilio-status/index.ts` receives delivery-status callbacks. Same gap.
- The tenant's Twilio credentials live in `tenant_credentials.config` with keys `account_sid` and
  `auth_token` (confirmed: dispatch-twilio-sms reads `cred.config.account_sid` / `cred.config.auth_token`).
- Functions run with `verify_jwt=false` (correct — Twilio can't send a Supabase JWT).

TASK: Implement Twilio's X-Twilio-Signature validation in BOTH functions.
  Twilio's algorithm: HMAC-SHA1 over (full request URL + sorted POST params concatenated as key+value),
  keyed by the account's auth_token, then base64. Compare (constant-time) to the `X-Twilio-Signature`
  header. Reference: Twilio "Validating Signatures from Twilio" — implement it directly in Deno using
  Web Crypto (`crypto.subtle.importKey`/`sign` with HMAC SHA-1); do NOT add an npm/JSR SDK dependency
  unless the repo already uses one.

  Sequencing problem to solve carefully: the signature needs the auth_token, but the tenant is resolved
  from the phone number INSIDE the RPC. Resolve as follows:
  1. Parse the form body (do not consume the stream twice).
  2. Determine the destination number: for inbound, the `To` field; for status, the `From`/`To` per
     Twilio's payload. Look up the tenant + Twilio credentials by that number using an existing resolver
     RPC if one exists (search migrations for `resolve_tenant_by_phone` or similar; if none returns the
     credential, add a minimal SECURITY DEFINER SQL function in a NEW migration file that returns
     account_sid/auth_token for a given phone number — do not edit existing migrations).
  3. Reconstruct the exact public URL Twilio signed. Use the configured function base URL
     (`SUPABASE_URL` + `/functions/v1/<name>`); if a proxy alters the path, read from the `X-Forwarded-*`
     / request URL. Document the assumption in a comment.
  4. Validate the signature. On failure return HTTP 403 and DO NOT call the mutating RPC.
  5. On success, proceed exactly as today.
  6. Add an env escape hatch `TWILIO_SIGNATURE_ENFORCEMENT` — when set to `"log_only"` the function logs
     validation failures but still processes (for a safe rollout window); default (unset) = enforce/reject.
     Log every failure to `error_logs` with a clear message.

DEFINITION OF DONE:
  - Both functions reject a request with a missing/invalid signature (403) when enforcement is on.
  - A correctly signed request still succeeds end-to-end.
  - No new third-party dependency added unless already present.
  - Add a Deno-independent unit test in `dashboard/tests/twilio-signature.test.mjs` ONLY if the signing
    helper can be extracted to a pure function importable without Deno; otherwise include a self-contained
    manual test vector (URL + params + token + expected signature from Twilio's docs) in a comment and a
    small standalone script under `scripts/` that verifies it with Node's crypto. State which you did.
  - Provide the exact Twilio Console configuration note (which URL to set) in the function's header comment.

FORBIDDEN: disabling verify_jwt changes, editing already-applied migrations, weakening any other check,
processing the RPC before signature validation passes (except in explicit log_only mode).

OUTPUT: files changed (incl. any new migration), the test vector result, diff summary, rollout note.
```

---

## TICKET-05 — Add shared-secret authentication to the Retell result webhook

```PROMPT
ROLE: Senior Edge Functions engineer (Deno/TS). Minimal correct change.

CONTEXT (verified): `supabase/functions/retell-result/index.ts` receives Retell's post-call webhook and
calls RPC `process_retell_call_result`, which writes call outcome/transcript and splats
`call_analysis.custom_analysis_data` into `leads.custom_fields` and advances the journey. Its own header
comment admits auth is "intentionally off" and relies on call_id being "unguessable". That is not
authentication.

TASK: Add verification of the webhook's authenticity.
  1. Determine Retell's supported mechanism from Retell's current webhook docs: they support a signing
     secret (`X-Retell-Signature`) over the raw body. Implement HMAC verification with Web Crypto using a
     secret stored in the Edge Function env var `RETELL_WEBHOOK_SECRET` (and, if Retell signs per-agent,
     fall back to the tenant's stored retell secret). If — and only if — you cannot confirm Retell exposes
     a signature, implement a required static shared-secret header `X-Followup-Webhook-Token` compared
     constant-time to env `RETELL_WEBHOOK_TOKEN`, and configure that token in the Retell webhook URL/header.
     State clearly which mechanism you used and why.
  2. On verification failure: 403, do not call the RPC, log to `error_logs`.
  3. Add the same `..._ENFORCEMENT=log_only` escape hatch as TICKET-04 for safe rollout.
  4. Update the function header comment to document the chosen mechanism and required Retell config.

DEFINITION OF DONE:
  - Unsigned/incorrect requests are rejected (403) under enforcement.
  - Valid requests still process unchanged.
  - No new dependency unless already present.
  - Rollout + config note in the header comment.

FORBIDDEN: leaving any code path that mutates leads/journeys before verification passes (except log_only).

OUTPUT: mechanism chosen + justification, files changed, diff summary.
```

---

## TICKET-06 — Encrypt provider secrets at rest

```PROMPT
ROLE: Senior Postgres/Supabase engineer. You are moving plaintext secrets into encrypted storage without
breaking the running engine. Careful, staged, reversible.

CONTEXT (verified): `tenant_credentials.config` (JSONB) stores plaintext secrets: `google_client_secret`,
OpenAI/OpenRouter `api_key`, Retell `api_key`, Twilio `auth_token`. These are read by Edge Functions and
SQL RPCs (e.g. get_email_payload, dispatch-*). Any DB read exposes every client's provider keys.

TASK (staged — implement all stages but keep each behind the next so nothing breaks):
  1. Enable Supabase Vault (or pgsodium) if not already enabled — add a NEW migration; do not edit
     existing ones. Confirm availability with `list_extensions` before assuming.
  2. Add a helper layer: SECURITY DEFINER SQL functions `set_tenant_secret(tenant_id, provider, key, value)`
     and `get_tenant_secret(tenant_id, provider, key)` that write/read via Vault, returning the decrypted
     value only to service_role callers. Grant EXECUTE to service_role only; REVOKE from anon/authenticated.
  3. Migrate existing values: a one-time migration that copies each secret from `config` into Vault via the
     setter, then NULLs the plaintext secret keys in `config` (keep non-secret keys like `from_number`,
     `agent_id`, `account_sid`, `google_client_id`). Do this in the same transaction with a verification
     SELECT; if any row fails to round-trip, RAISE and roll back.
  4. Update every reader (SQL RPCs and Edge Functions) that currently reads a secret from `config` to call
     `get_tenant_secret(...)` instead. Search exhaustively:
     `grep -rn "auth_token\|api_key\|client_secret" supabase/functions supabase/migrations`.
  5. Update the write path (dashboard `POST /api/credentials`) so new secrets go through the setter and are
     never persisted in plaintext `config`. The `GET /api/credentials` must never return secret values
     (confirm it already selects only non-secret columns — it does today; keep it that way).

DEFINITION OF DONE:
  - `select config from tenant_credentials` contains NO secret material (only non-sensitive keys).
  - Sending an email, SMS, Retell call, and AI reply all still work in DEV against the migrated data
    (state how you verified — e.g. a dispatch dry-run or reading the payload RPC output).
  - Secret getter is not executable by anon/authenticated (prove with a grants query).
  - No plaintext secret is ever logged.

CRITICAL SAFETY: Do this in DEV (project your-project-ref) first. Do NOT run against prod
(xlvthuuinxbpyinviqvp) — the reviewer will promote it. Every migration must be idempotent and reversible.
If Vault is unavailable, STOP and report rather than inventing your own crypto.

OUTPUT: migration files, list of every reader you updated, grants proof, verification method + result.
```

---

## TICKET-06b — Stop returning sender OAuth secrets to any client (CRITICAL, do before 07)

Discovered during TICKET-06 review and verified on DEV: the `senders` table has plaintext columns
`google_refresh_token`, `google_access_token`, `google_client_secret`. `GET /api/settings` runs
`.select('*')` on `senders` (settings/route.js lines 28 and 169) and returns the rows to the dashboard
frontend, which reads `google_client_secret` back at `settings/page.jsx:545`. Long-lived Gmail OAuth
refresh tokens are being shipped to the browser. This is the same vulnerability class TICKET-06 just fixed,
on a different table. It must be closed before a client touches the app.

```PROMPT
ROLE: Senior full-stack engineer. You are closing a secret-exposure leak. Minimal, surgical change.
Do NOT start a data migration — that is a separate ticket. This ticket only stops secrets from leaving
the server.

CONTEXT (verified against the live DEV database and the code):
- Table `public.senders` has plaintext secret columns: `google_refresh_token`, `google_access_token`,
  `google_client_secret`.
- `dashboard/src/app/api/settings/route.js` selects `senders` with `.select('*')` at TWO places
  (around line 28 in GET, and around line 169). Both return sender rows to the client in the response.
- The frontend `dashboard/src/app/settings/page.jsx` consumes `s.google_client_secret` (around line 545)
  to repopulate an editable form field, and checks `sender.google_refresh_token` only for a
  boolean "connected?" state (around line 1378). `dashboard/src/lib/senderHealth.js` (~line 25) also only
  checks `google_refresh_token` for presence (boolean).
- Other routes are already safe: `senders/route.js` uses an explicit non-secret column list;
  `oauth/google/callback/route.js` and `senders/[id]/test-send/route.js` select secrets but use them
  SERVER-SIDE only (confirm they do not return them in a response — if either does, fix that too).

TASK:
  1. Define ONE canonical safe column list for client-facing sender reads. The three secret columns above
     — plus any other credential-bearing column you find on `senders` (audit the table schema; e.g.
     tokens, secrets) — must NOT be in it. Include a derived boolean `google_connected` (true when a
     refresh token exists) so the UI keeps its connected/disconnected indicator WITHOUT receiving the token.
     Compute that boolean server-side (e.g. `google_refresh_token is not null`) and strip the raw column.
  2. Replace BOTH `.select('*')` on senders in `settings/route.js` with the safe column list. Never return
     the raw secret columns. If the UI needs to show "a client secret is set", return a boolean
     `google_client_secret_set` (server-side computed), never the value.
  3. Update `settings/page.jsx` so it no longer expects `google_client_secret` (or any secret) back from
     the server. Where line ~545 repopulates the secret into a form field, change it to: leave the input
     blank with a placeholder like "•••••• (saved)" when `google_client_secret_set` is true, and only send
     a new value on save if the user actually typed one. Preserve the connected indicator using the new
     `google_connected` / `google_client_secret_set` booleans.
  4. Grep the whole `dashboard/src` for any other place a secret column is read from an API response and
     apply the same treatment. Grep every API route for `.select('*')` on any table that has secret
     columns (`senders`, `tenant_credentials`) and fix those too.

DEFINITION OF DONE:
  - `grep -rn "select('\*')" dashboard/src/app/api` returns no result for `senders` or `tenant_credentials`.
  - The `GET /api/settings` JSON response contains NONE of: `google_refresh_token`, `google_access_token`,
    `google_client_secret` (verify by reading the code path; if you can run the route in DEV, capture the
    response and grep it).
  - The settings UI still shows: which senders are Google-connected, and whether a client secret is saved —
    using booleans, not secret values.
  - Add `dashboard/tests/no-secret-egress.test.mjs`: static analysis over `dashboard/src/app/api/**/route.js`
    asserting no route selects `*` from `senders` or `tenant_credentials`, and that `settings/route.js`
    source does not contain the three secret column names in any `.select(...)` call.
  - `npm run test` and `npm run lint` pass.

FORBIDDEN: migrating/altering columns (that is TICKET-06c), changing OAuth logic, touching edge functions,
or weakening the connected-state UX. Server-side secret USE (in callback/test-send) stays; only client
EGRESS is removed.

OUTPUT: the safe column list, files changed, grep proofs, test results, and confirmation the two
`select('*')` sites are gone.
```

**Reviewer check (me):** re-grep for `select('*')` on senders; read the `/api/settings` response shape;
confirm no secret column name appears in any client-facing select; confirm the UI booleans replace the raw
values.

---

## TICKET-06c — Migrate `senders` OAuth secrets into Vault + rework token write-back (HIGH)

Follow-on to TICKET-06 and 06b. After 06b, sender secrets no longer leave the server, but they are still
stored as plaintext columns and read directly by edge functions and the OAuth write-back path. This ticket
moves them into Vault, mirroring the `tenant_credentials` approach.

```PROMPT
ROLE: Senior Postgres/Supabase engineer. Staged, reversible secret migration for per-sender OAuth
credentials. Same discipline as the tenant_credentials Vault migration already in this repo — study those
migrations first and follow their exact patterns.

PRECONDITION: TICKET-06 (tenant_credentials → Vault) and TICKET-06b (stop secret egress) are merged.
Read the existing helpers `set_tenant_secret` / `get_tenant_secret` and the three 20260713* migrations;
reuse their naming and structure.

CONTEXT (verified): `public.senders` stores plaintext `google_refresh_token`, `google_access_token`,
`google_client_secret` (and `google_token_expires_at`, non-secret). These are read/written by:
  - `supabase/functions/dispatch-gmail-email/index.ts`
  - `supabase/functions/poll-gmail-inbox/index.ts`
  - `dashboard/src/app/api/senders/[id]/test-send/route.js`
  - `dashboard/src/app/api/oauth/google/start/route.js` and `.../callback/route.js`
The OAuth path REFRESHES tokens and writes the new access/refresh token back — this write-back loop is the
hard part and must go through the secret setter, not a column UPDATE.

TASK (all via NEW migrations; never edit applied ones; idempotent; DEV only):
  1. Add per-sender secret helpers OR reuse the existing ones with a sender-scoped name convention
     (e.g. `sender_secret:<sender_id>:<key>`). Decide and justify. Keep them SECURITY DEFINER,
     `search_path` pinned, EXECUTE revoked from anon/authenticated/public, granted to service_role only.
  2. Data migration: for each sender row, copy each plaintext secret into Vault via the setter, round-trip
     verify in the same transaction (RAISE + rollback on mismatch), then NULL the plaintext columns.
     Idempotent: skip rows already migrated. Do NOT drop the columns yet (keep for rollback); a later
     cleanup migration can drop them once prod is confirmed.
  3. Update every reader listed above to fetch secrets via the getter instead of the column.
  4. Rework the OAuth token write-back (callback + any refresh path) so refreshed access/refresh tokens are
     written via the setter, and the plaintext columns are never repopulated.
  5. Confirm nothing logs a decrypted secret.

DEFINITION OF DONE:
  - `select google_refresh_token, google_access_token, google_client_secret from senders` returns all NULL
    in DEV after migration; the values are present in Vault under the sender-scoped names.
  - Gmail dispatch, inbox poll, test-send, and OAuth callback all read/write via the getter/setter (show
    the changed lines).
  - A token refresh in DEV writes the new token to Vault, not the column (verify by inspecting Vault before
    and after, or by reading the write path).
  - Secret getter not executable by anon/authenticated (grants query proof).
  - `npm run test`, `npm run lint` pass; no plaintext secret logged.

CRITICAL SAFETY: DEV project (your-project-ref) only. Reviewer promotes to prod. Every migration
idempotent and reversible; do not drop columns in this ticket. If Vault is unavailable, STOP and report.

OUTPUT: migration files, every reader/writer updated, the OAuth write-back rework, Vault before/after proof,
grants proof, verification method + result.
```

---

## TICKET-07 — Make the tenant switcher functional (or remove the claim)

```PROMPT
ROLE: Senior full-stack engineer. Decide the smallest correct path and implement it.

CONTEXT (verified): `dashboard/src/components/TenantSwitcher.jsx` sets a `tenant_id` cookie on switch, but
NO server code reads that cookie. `getTenantId()` in `dashboard/src/utils/tenant.js` always returns the
user's earliest `tenant_members` row. So switching changes the label only; data does not change. The README
advertises "Multi-Tenant Switcher & Isolation". This is a correctness + honesty gap.

PRECONDITION: TICKET-01 must be merged first (tenant isolation must be real before multi-tenant switching
is safe).

TASK — implement Option A (make it real). Only fall back to Option B if you find a blocking constraint and
report it.

Option A (preferred):
  1. When a user switches tenant, set a signed/httpOnly `active_tenant_id` cookie via a small server route
     (`POST /api/tenant/active`) that FIRST verifies the user is actually a member of that tenant
     (`tenant_members` join). Reject otherwise (403). Never trust a raw client cookie for membership.
  2. Change `getTenantId(request)` so that: if the `active_tenant_id` cookie is present AND the user is a
     member of it, use it; otherwise fall back to the earliest membership. Membership must be re-verified
     server-side on every request — the cookie is a hint, not an authorization.
  3. Update `TenantSwitcher.jsx` to call the new route instead of writing the cookie directly with
     document.cookie.

Option B (only if A is blocked): remove the switcher UI and delete the "switcher" claim from README until
it's built. Report why A was infeasible.

DEFINITION OF DONE:
  - Switching to a tenant the user belongs to changes the data returned by API routes (verify with one
    route, e.g. /api/leads).
  - Switching (or forging the cookie) to a tenant the user does NOT belong to returns that user's real
    tenant data or 403 — never the foreign tenant's data.
  - Add `dashboard/tests/active-tenant-membership.test.mjs` covering the membership-verification logic
    (extract it into a pure, testable helper).
  - `npm run test`, `npm run lint` pass.

FORBIDDEN: trusting the cookie without server-side membership re-verification. That would re-introduce the
isolation bug.

OUTPUT: which option, why, files changed, verification, test results.
```

---

## TICKET-08 — Resolve the `actions.updated_at` schema/error bug

```PROMPT
ROLE: Senior Postgres engineer. Diagnose before you fix. Do not patch symptoms.

CONTEXT (verified): DEV `error_logs` has 923 occurrences of
`column "updated_at" of relation "actions" does not exist`, workflow_name
`dispatch_pending_actions:inline:wait`, all timestamped on/before 2026-07-03. I confirmed on PROD that
table `public.actions` has NO `updated_at` column, yet 17 public functions reference `updated_at` in
their bodies. The errors stopped after 2026-07-03, which suggests the failing code path was changed, but
the schema mismatch may still be reachable.

TASK:
  1. Determine the REAL root cause. For each of the 17 functions whose body references `updated_at` and
     touches `actions`, read the function and decide: does it write/read `actions.updated_at`? Produce a
     list: function name | references actions.updated_at? | still callable in current engine? | verdict.
     Use the live DB (dev project your-project-ref) to introspect `pg_proc.prosrc`.
  2. Decide the correct fix — exactly ONE of:
       (a) The column SHOULD exist (other code expects it): add it via a NEW migration
           `alter table actions add column updated_at timestamptz` + a `set_updated_at` trigger consistent
           with how other tables do it (search for existing `set_updated_at()` usage), OR
       (b) The column should NOT exist and the references are dead: rewrite the offending function(s) in a
           NEW migration to stop referencing it.
     Justify the choice with evidence from step 1. Do not do both.
  3. Whichever path: ensure `dispatch_pending_actions` and any wait/resume path no longer raise.

DEFINITION OF DONE:
  - A written root-cause statement (not a guess) backed by the function audit table.
  - One new migration implementing the chosen fix; existing migrations untouched.
  - Proof the error path is gone: run the relevant RPC in dev and show no error, or show the function
    source no longer references the missing column.
  - No new errors introduced in `error_logs` after your change (check after a dispatcher tick).

CRITICAL SAFETY: apply to DEV only. Reviewer promotes to prod.

OUTPUT: audit table, root-cause statement, chosen fix + justification, migration file, verification.
```

---

## TICKET-09 — Add FK indexes and fix RLS performance advisors

```PROMPT
ROLE: Senior Postgres engineer. Performance hardening, behavior-preserving.

CONTEXT (verified via Supabase advisors on prod xlvthuuinxbpyinviqvp): the database has
`unindexed_foreign_keys` on many tables (incl. leads, events, actions, journeys, suppressions,
tenant_members, journey_versions, journey_webhook_samples, ai_reply_events, import_batches, and more),
`auth_rls_initplan` warnings on ~20 tables (RLS policies evaluate auth.* per row instead of once), and
`multiple_permissive_policies` (stacked permissive policies) on most tables. Invisible at current volume,
but will degrade dispatch and dashboard queries under real lead load.

TASK (all via NEW migrations; never edit applied ones; each migration idempotent with IF NOT EXISTS):
  1. Add a btree index on every reported unindexed foreign key column. Name them `idx_<table>_<column>`.
     Pull the exact list from `get_advisors(type=performance)` — do not rely on this description; read the
     live advisor output and cover ALL reported entries.
  2. Fix `auth_rls_initplan`: rewrite the flagged RLS policies to wrap auth calls so they evaluate once —
     replace `auth.<fn>()` with `(select auth.<fn>())` in policy expressions. Preserve identical logic;
     this is purely a performance rewrite. Recreate each policy in a new migration (drop + create with the
     same name and same USING/WITH CHECK semantics, just wrapped).
  3. Fix `multiple_permissive_policies`: where a table has several permissive policies for the same
     role+action that are redundant, consolidate into one. ONLY consolidate when the combined logic is
     provably equivalent (OR of the conditions). If unsure for a given table, leave it and report it —
     do not risk changing access semantics.

DEFINITION OF DONE:
  - Re-run advisors on dev after applying: `unindexed_foreign_keys` cleared; `auth_rls_initplan` cleared;
    `multiple_permissive_policies` reduced (list any intentionally left, with reason).
  - Prove RLS semantics unchanged: for at least `leads`, `actions`, `events`, show the policy USING/WITH
    CHECK expressions before and after are logically equivalent.
  - Existing `npm run test` still passes.

CRITICAL SAFETY: DEV first. Do NOT alter which rows a policy admits — only how the expression is evaluated.
If any consolidation could change visibility, skip it and report.

OUTPUT: the advisor deltas (before/after counts), migration files, the equivalence proof for the sampled
tables, list of anything deliberately skipped.
```

---

## TICKET-10 — Decompose the journey builder (do this last)

```PROMPT
ROLE: Senior frontend engineer. Behavior-preserving refactor of one oversized React file. Zero functional
change. This is a structure-only ticket.

CONTEXT (verified): `dashboard/src/app/journeys/builder/page.jsx` is ~6,260 lines and mixes canvas
rendering, node/step configuration panels, the step-type registry, save/publish controls, and validation
wiring in one file. It is unreviewable and merge-hostile. Related helpers already exist in
`dashboard/src/lib/journeyStepTypes.js` and `journeyValidation.js` — reuse them; do not duplicate.

TASK: Split the file into cohesive modules WITHOUT changing any behavior, markup output, or state logic:
  1. First, produce a component/responsibility map of the current file (sections + line ranges + what each
     does + shared state it reads/writes). Share it and STOP for reviewer approval BEFORE editing.
  2. After approval, extract into e.g.:
       - `builder/components/Canvas.jsx`
       - `builder/components/NodePanel.jsx` (step/node config editors)
       - `builder/components/SaveControls.jsx` (save/publish/last-saved status)
       - `builder/hooks/useJourneyState.js` (the reducer/state + persistence effects)
     Keep `page.jsx` as a thin composition root. Lift shared state into the hook or props; do not introduce
     a new global state library.
  3. Preserve every prop, callback name, URL query-param behavior, and DOM structure. The rendered output
     must be identical.

DEFINITION OF DONE:
  - `page.jsx` is under ~400 lines and only composes children.
  - No file in the builder exceeds ~800 lines.
  - `npm run build` succeeds; `npm run test` and `npm run lint` pass.
  - Manual parity checklist (you fill in): create a journey, add each node type, save, publish, reload via
    query param — all behave exactly as before. Report each as pass.

FORBIDDEN: changing behavior, styling, node types, validation rules, or adding dependencies. If you
discover a bug while refactoring, DO NOT fix it here — note it separately.

OUTPUT: the responsibility map (before edits), then after approval: file tree of new modules, diff summary,
build/test/lint results, parity checklist.
```

---

## Reviewer workflow (me, per ticket)

For each returned diff I will: (1) re-run the ticket's Definition-of-Done greps/queries myself against the
code and the live DB, (2) check the agent didn't touch out-of-scope files, (3) confirm tests/lint pass,
(4) for SQL tickets, verify against DEV before you promote to PROD. Only then start the next ticket.

Promotion to prod (xlvthuuinxbpyinviqvp) is a separate explicit step I control — no agent runs migrations
against prod.
