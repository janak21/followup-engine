# Phase 1: Run-Centric Journeys (Multi-Enrollment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move lead-journey enrollment state off the `leads` row and onto `journey_runs`, so one lead can be enrolled in multiple journeys concurrently (GHL parity), with one shared enrollment RPC used by every enrollment path.

**Architecture:** `journey_runs` becomes the enrollment record (one row per enrollment, one *running* run per lead+journey, re-entry allowed after exit). A new `enroll_lead_in_journey` RPC is the single write path for manual create, bulk enroll, and webhook enrollment. `advance_journey` updates the run's `current_step`/`status` and only *mirrors* to the legacy lead columns when the run matches `leads.journey_template` (keeps the existing UI working untouched this phase). `should_dispatch` blocks actions whose run is no longer running. The event-workflow queue (`workflow_actions`) is intentionally untouched this phase.

**Tech Stack:** Supabase Postgres 17 (plpgsql migrations in `supabase/migrations/`), Next.js App Router API routes (JS), `node --test` for JS unit tests.

---

## Environment & Working Agreements

- **Repo:** `<repo-root>` (branch `main`). The working tree has unrelated uncommitted changes — **only ever `git add` the specific files named in each commit step. Never `git add -A`.**
- **Applying migrations:** save the file under `supabase/migrations/`, then apply the same SQL to the dev project `your-project-ref` via Supabase MCP `apply_migration` (migration name = file name without timestamp/extension). This is the project's established workflow — repo file and deployed DB must always match.
- **SQL verification:** run the given queries via Supabase MCP `execute_sql` against `your-project-ref`. Expected results are stated per step.
- **JS tests:** `cd dashboard && npm test` (runs `node --test tests/*.test.mjs`).
- **Dev-data caution:** dev tenants have real Gmail/Twilio/Retell credentials. End-to-end tests must only use the synthetic wait→exit journeys created in Task 8 — never enroll test leads into `e2e_multi_channel_test` or `email_test_oauth`.

## Locked Design Decisions

1. **One running run per (tenant, lead, journey)** — enforced by partial unique index. Re-enrollment after a run exits is allowed (creates a new run). Concurrent runs in *different* journeys are allowed. This matches GHL's default re-entry semantics.
2. **Legacy lead columns become a mirror.** `leads.journey_template/journey_status/current_step/next_action_at` keep being written, but only by the run whose `journey_key` equals `leads.journey_template` (or by legacy run-less actions). Dashboard UI is unchanged this phase.
3. **Stop-on-response stays lead-level.** A reply still cancels all pending outbound for the lead across all runs (current safety behavior, `cancel_pending_on_engagement`). Affected runs are now marked `responded` instead of being left `running`. Making this per-run is a later product decision.
4. **Lead-level identity guards stay lead-level:** `opt_out`, suppressions, `callback_requested`, business hours.
5. **Event workflows (`workflow_actions`, `advance_workflow_run`) are out of scope** — Phase 2 merges the queues.

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260704090000_journey_runs_enrollment_columns.sql` | Create: run-state columns + unique active-run index |
| `supabase/migrations/20260704091000_enroll_lead_in_journey.sql` | Create: the single enrollment RPC |
| `supabase/migrations/20260704092000_advance_journey_run_centric.sql` | Create: run-centric `advance_journey` |
| `supabase/migrations/20260704093000_run_aware_guards.sql` | Create: `should_dispatch` + guard + `cancel_pending_on_engagement` run-awareness |
| `supabase/migrations/20260704094000_webhook_enroll_via_rpc.sql` | Create: `process_journey_webhook` delegates enrollment to the RPC |
| `supabase/migrations/20260704095000_backfill_journey_runs.sql` | Create: runs for currently-active leads; link their pending actions |
| `dashboard/src/lib/bulkEnroll.js` | Modify: per-journey (not global) already-active skip |
| `dashboard/tests/bulk-enroll.test.mjs` | Modify: tests for the new eligibility rule |
| `dashboard/src/app/api/leads/bulk-enroll/route.js` | Modify: enroll via RPC; query active runs |
| `dashboard/src/app/api/leads/route.js` | Modify: manual-create enrolls via RPC |
| `docs/decisions/002-run-centric-journeys.md` | Create: decision record |

---

### Task 1: Run-state columns + one-active-run index

**Files:**
- Create: `supabase/migrations/20260704090000_journey_runs_enrollment_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1 (run-centric journeys): journey_runs becomes the enrollment record.
-- Adds per-run step state and enforces at most ONE running run per
-- (tenant, lead, journey). Re-entry after exit = new row. Event-workflow runs
-- with lead_id NULL are unaffected (NULLs are distinct in unique indexes).

alter table public.journey_runs
  add column if not exists current_step integer not null default 0,
  add column if not exists next_action_at timestamptz,
  add column if not exists responded boolean not null default false;

create unique index if not exists journey_runs_one_running_per_lead_journey
  on public.journey_runs (tenant_id, lead_id, journey_id)
  where status = 'running';

create index if not exists journey_runs_lead_running_idx
  on public.journey_runs (tenant_id, lead_id)
  where status = 'running';
```

- [ ] **Step 2: Apply to dev**

Apply via MCP `apply_migration` with name `journey_runs_enrollment_columns` and the SQL above.
Expected: `{"success": true}`

- [ ] **Step 3: Verify schema**

Run via `execute_sql`:

```sql
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='journey_runs'
      and column_name in ('current_step','next_action_at','responded')) as new_cols,
  (select count(*) from pg_indexes
    where schemaname='public' and tablename='journey_runs'
      and indexname='journey_runs_one_running_per_lead_journey') as uniq_idx;
```

Expected: `new_cols = 3`, `uniq_idx = 1`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260704090000_journey_runs_enrollment_columns.sql
git commit -m "feat(engine): journey_runs enrollment columns + one-active-run index"
```

---

### Task 2: `enroll_lead_in_journey` RPC

**Files:**
- Create: `supabase/migrations/20260704091000_enroll_lead_in_journey.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Single enrollment entry point for lead journeys. Used by: manual lead
-- create, bulk enroll, process_journey_webhook (and anything future).
-- Creates a journey_run + the step-0 action (run-scoped idempotency),
-- mirrors legacy lead columns, and enforces one running run per journey
-- via the partial unique index from 20260704090000.

create or replace function public.enroll_lead_in_journey(
  p_tenant_id uuid,
  p_lead_id uuid,
  p_journey_key text,
  p_source text default 'manual',
  p_raw_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lead public.leads%rowtype;
  v_journey public.journeys%rowtype;
  v_step0 jsonb;
  v_run_id uuid;
  v_existing_run_id uuid;
  v_action_id uuid;
begin
  select * into v_lead
    from public.leads
   where id = p_lead_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'lead_not_found');
  end if;

  if v_lead.opt_out then
    return jsonb_build_object('status', 'lead_opted_out');
  end if;

  select * into v_journey
    from public.journeys
   where tenant_id = p_tenant_id
     and journey_key = p_journey_key
     and active
   order by version desc
   limit 1;
  if not found then
    return jsonb_build_object('status', 'journey_not_found');
  end if;

  select s into v_step0
    from jsonb_array_elements(coalesce(v_journey.spec -> 'steps', '[]'::jsonb)) s
   where (s ->> 'index')::integer = 0
   limit 1;
  if v_step0 is null then
    return jsonb_build_object('status', 'no_first_step');
  end if;

  insert into public.journey_runs (
    tenant_id, journey_id, journey_key, journey_version,
    mode, trigger_type, status, lead_id,
    current_step, next_action_at, raw_payload
  ) values (
    p_tenant_id, v_journey.id, v_journey.journey_key, v_journey.version,
    'lead_journey', coalesce(nullif(trim(p_source), ''), 'manual'), 'running', p_lead_id,
    0, now(), coalesce(p_raw_payload, '{}'::jsonb)
  )
  on conflict (tenant_id, lead_id, journey_id) where status = 'running'
  do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select id into v_existing_run_id
      from public.journey_runs
     where tenant_id = p_tenant_id
       and lead_id = p_lead_id
       and journey_id = v_journey.id
       and status = 'running'
     limit 1;
    return jsonb_build_object(
      'status', 'already_active',
      'run_id', v_existing_run_id
    );
  end if;

  insert into public.actions (
    tenant_id, lead_id, run_id, action_type, step_index, template_key,
    run_at, status, idempotency_key, payload
  ) values (
    p_tenant_id, p_lead_id, v_run_id, v_step0 ->> 'type', 0, v_step0 ->> 'template_key',
    now(), 'pending',
    'run:' || v_run_id::text || ':0',
    jsonb_build_object(
      'enrolled_via', v_journey.journey_key,
      'enrolled_by', coalesce(nullif(trim(p_source), ''), 'manual'),
      'step_spec', v_step0
    )
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_action_id;

  -- Legacy mirror: keep the lead columns pointing at this (most recent)
  -- enrollment so the existing dashboard keeps working during Phase 1.
  update public.leads
     set journey_template = v_journey.journey_key,
         journey_status = 'active',
         current_step = 0,
         next_action_at = now(),
         updated_at = now()
   where id = p_lead_id;

  return jsonb_build_object(
    'status', 'enrolled',
    'run_id', v_run_id,
    'action_id', v_action_id,
    'journey_key', v_journey.journey_key
  );
end;
$$;

revoke execute on function public.enroll_lead_in_journey(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.enroll_lead_in_journey(uuid, uuid, text, text, jsonb)
  to service_role;
```

- [ ] **Step 2: Apply to dev**

Apply via `apply_migration`, name `enroll_lead_in_journey`. Expected: `{"success": true}`.

- [ ] **Step 3: Verify behavior with a throwaway lead (no real sends — journey lookup only)**

```sql
-- setup: temp lead + two synthetic journeys (wait -> wait -> end; two steps so
-- Task 3 can prove run.current_step advances). Durations are 0 — a step-0 wait
-- action executes on the next tick regardless of duration (the duration applies
-- when a wait is scheduled as a NEXT step).
with t as (select id from tenants order by created_at limit 1),
ins_lead as (
  insert into leads (tenant_id, first_name, email, source, journey_status)
  select id, 'Phase1 Test', 'phase1-test@example.invalid', 'phase1_verify', 'new' from t
  returning id, tenant_id
),
j1 as (
  insert into journeys (tenant_id, journey_key, name, version, active, spec)
  select tenant_id, 'phase1_verify_a', 'Phase1 Verify A', 1, true,
    '{"steps":[{"index":0,"type":"wait","duration":{"amount":0,"unit":"minutes"},"on_outcome":{"default":{"next_step":1}}},{"index":1,"type":"wait","duration":{"amount":0,"unit":"minutes"},"on_outcome":{"default":{"exit":"completed"}}}]}'::jsonb
  from ins_lead returning id
),
j2 as (
  insert into journeys (tenant_id, journey_key, name, version, active, spec)
  select tenant_id, 'phase1_verify_b', 'Phase1 Verify B', 1, true,
    '{"steps":[{"index":0,"type":"wait","duration":{"amount":0,"unit":"minutes"},"on_outcome":{"default":{"next_step":1}}},{"index":1,"type":"wait","duration":{"amount":0,"unit":"minutes"},"on_outcome":{"default":{"exit":"completed"}}}]}'::jsonb
  from ins_lead returning id
)
select l.id as lead_id, l.tenant_id from ins_lead l;
```

Then, substituting the returned ids — **one statement, so the live 30s cron cannot interleave between the calls**:

```sql
select enroll_lead_in_journey('<tenant_id>', '<lead_id>', 'phase1_verify_a', 'verify') as first,
       enroll_lead_in_journey('<tenant_id>', '<lead_id>', 'phase1_verify_b', 'verify') as second,
       enroll_lead_in_journey('<tenant_id>', '<lead_id>', 'phase1_verify_a', 'verify') as third;
```

Expected: `first` and `second` return `"status": "enrolled"` with distinct `run_id`s; `third` returns `"status": "already_active"` with the same `run_id` as `first`. Then:

```sql
select count(*) as total_runs
  from journey_runs
 where lead_id = '<lead_id>';
```

Expected: `total_runs = 2` (status may already be `completed` if the cron ticked — that's fine; the duplicate-guard proof is `third = already_active`, and two distinct runs for one lead **is the multi-enrollment proof**).

Keep the lead/journeys/runs in place — Task 3 and Task 8 reuse them. Record the ids in the task notes.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260704091000_enroll_lead_in_journey.sql
git commit -m "feat(engine): enroll_lead_in_journey RPC — single enrollment path, multi-journey capable"
```

---

### Task 3: Run-centric `advance_journey`

**Files:**
- Create: `supabase/migrations/20260704092000_advance_journey_run_centric.sql`

The body below is the deployed version (from `20260629123033_audit_fix_event_bridge_continuation.sql`) with three behavior changes, marked `-- PHASE1:`:
1. Lead-column writes are mirrored **only** when the action has no run (legacy) or the run's journey matches `leads.journey_template`.
2. On non-terminal advance, the run's `current_step`/`next_action_at` are updated.
3. Terminal exits also set `journey_runs.responded = true` when the exit is `responded`.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1: advance_journey is run-centric. Runs own step state; lead columns
-- are a compat mirror written only when the run matches lead.journey_template
-- (or the action predates runs). Behavior for legacy run-less actions is
-- unchanged.

create or replace function public.advance_journey(
  p_action_id uuid,
  p_outcome text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_lead public.leads%rowtype;
  v_tenant public.tenants%rowtype;
  v_run public.journey_runs%rowtype;
  v_journey public.journeys%rowtype;
  v_steps jsonb;
  v_current_step jsonb;
  v_next_step jsonb;
  v_exit text;
  v_next_index integer;
  v_delay_amount numeric;
  v_delay_unit text;
  v_run_at timestamptz;
  v_new_action_id uuid;
  v_wait_mode text;
  v_until_iso text;
  v_on_passed text;
  v_on_passed_step integer;
  v_aw jsonb;
  v_clamp_tz text;
  v_next_type text;
  v_has_event_run boolean := false;
  v_terminal_status text;
  v_mirror boolean := true;  -- PHASE1: whether lead columns mirror this run
begin
  update public.actions
     set result = coalesce(result, '{}'::jsonb)
                  || jsonb_build_object(
                    'advanced_at', now(),
                    'advanced_outcome', p_outcome
                  )
   where id = p_action_id
     and not (coalesce(result, '{}'::jsonb) ? 'advanced_at')
  returning * into v_action;

  if not found then
    return null;
  end if;

  select * into v_lead
    from public.leads
   where id = v_action.lead_id
   for update;

  if not found then
    update public.actions
       set status = 'failed_permanent',
           error_message = 'lead not found',
           last_error = 'lead not found',
           locked_until = null,
           locked_by = null
     where id = v_action.id;
    return null;
  end if;

  select * into v_tenant
    from public.tenants
   where id = v_action.tenant_id;

  v_clamp_tz := coalesce(nullif(v_lead.timezone, ''), v_tenant.timezone);

  if v_action.run_id is not null then
    select * into v_run
      from public.journey_runs
     where id = v_action.run_id
       and tenant_id = v_action.tenant_id
     for update;

    if found then
      v_has_event_run := true;

      if v_run.journey_id is not null then
        select * into v_journey
          from public.journeys
         where id = v_run.journey_id
           and tenant_id = v_run.tenant_id
         limit 1;
      end if;

      if v_journey.id is null and nullif(trim(coalesce(v_run.journey_key, '')), '') is not null then
        select * into v_journey
          from public.journeys
         where tenant_id = v_run.tenant_id
           and journey_key = v_run.journey_key
           and active
         order by version desc
         limit 1;
      end if;
    end if;
  end if;

  if v_journey.id is null then
    select * into v_journey
      from public.journeys
     where tenant_id = v_lead.tenant_id
       and journey_key = v_lead.journey_template
       and active
     order by version desc
     limit 1;
  end if;

  -- PHASE1: mirror lead columns only for the lead's primary journey.
  if v_has_event_run and v_journey.id is not null
     and coalesce(v_journey.journey_key, '') <> coalesce(v_lead.journey_template, '') then
    v_mirror := false;
  end if;

  if v_journey.id is null then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'failed',
             failed_at = coalesce(failed_at, now()),
             last_error = 'journey_not_found'
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_steps := coalesce(v_journey.spec -> 'steps', '[]'::jsonb);

  select s into v_current_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::integer = v_action.step_index
   limit 1;

  if v_current_step is null and v_action.payload ? 'step_spec' then
    v_current_step := v_action.payload -> 'step_spec';
  end if;

  if v_current_step is null or v_current_step = 'null'::jsonb then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'failed',
             failed_at = coalesce(failed_at, now()),
             last_error = 'current_step_not_found'
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_exit := v_current_step -> 'on_outcome' -> p_outcome ->> 'exit';
  if v_exit is not null then
    v_terminal_status := case when v_exit in ('finished') then 'completed' else v_exit end;

    if v_mirror then
      update public.leads
         set journey_status = v_exit,
             next_action_at = null,
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = v_terminal_status,
             responded = responded or (v_terminal_status = 'responded'),  -- PHASE1
             completed_at = case when v_terminal_status = 'completed' then coalesce(completed_at, now()) else completed_at end,
             failed_at = case when v_terminal_status = 'failed' then coalesce(failed_at, now()) else failed_at end,
             last_error = case when v_terminal_status = 'failed' then coalesce(last_error, 'Journey exited with failed status.') else null end
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_next_index := nullif(v_current_step -> 'on_outcome' -> p_outcome ->> 'next_step', '')::integer;
  if v_next_index is null then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             next_action_at = null,
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'completed',
             completed_at = coalesce(completed_at, now()),
             last_error = null
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  select s into v_next_step
    from jsonb_array_elements(v_steps) s
   where (s ->> 'index')::integer = v_next_index
   limit 1;

  if v_next_step is null or v_next_step = 'null'::jsonb then
    if v_mirror then
      update public.leads
         set journey_status = 'completed',
             next_action_at = null,
             updated_at = now()
       where id = v_lead.id;
    end if;

    if v_has_event_run then
      update public.journey_runs
         set status = 'completed',
             completed_at = coalesce(completed_at, now()),
             last_error = null
       where id = v_run.id
         and status not in ('completed', 'failed', 'cancelled');
    end if;

    return null;
  end if;

  v_next_type := v_next_step ->> 'type';

  if v_next_type in ('wait', 'wait_reply') then
    v_wait_mode := coalesce(v_next_step ->> 'mode', 'duration');
    v_aw := v_next_step -> 'advance_window';

    if v_wait_mode = 'until' then
      v_until_iso := v_next_step -> 'until' ->> 'datetime';

      if v_until_iso is null then
        v_run_at := now();
      else
        v_run_at := v_until_iso::timestamptz;

        if v_run_at <= now() then
          if v_next_type = 'wait' then
            v_on_passed := coalesce(v_next_step ->> 'on_passed', 'continue');
            v_on_passed_step := nullif(v_next_step ->> 'on_passed_step', '')::integer;

            if v_on_passed = 'exit' then
              if v_mirror then
                update public.leads
                   set journey_status = 'completed',
                       next_action_at = null,
                       updated_at = now()
                 where id = v_lead.id;
              end if;

              if v_has_event_run then
                update public.journey_runs
                   set status = 'completed',
                       completed_at = coalesce(completed_at, now()),
                       last_error = null
                 where id = v_run.id
                   and status not in ('completed', 'failed', 'cancelled');
              end if;

              return null;
            elsif v_on_passed = 'goto' and v_on_passed_step is not null then
              select s into v_next_step
                from jsonb_array_elements(v_steps) s
               where (s ->> 'index')::integer = v_on_passed_step
               limit 1;

              if v_next_step is null then
                if v_mirror then
                  update public.leads
                     set journey_status = 'completed',
                         next_action_at = null,
                         updated_at = now()
                   where id = v_lead.id;
                end if;

                if v_has_event_run then
                  update public.journey_runs
                     set status = 'completed',
                         completed_at = coalesce(completed_at, now()),
                         last_error = null
                   where id = v_run.id
                     and status not in ('completed', 'failed', 'cancelled');
                end if;

                return null;
              end if;

              v_next_index := v_on_passed_step;
              v_next_type := v_next_step ->> 'type';
              v_run_at := now();
            elsif v_on_passed = 'skip_outbound' then
              update public.leads
                 set custom_fields = coalesce(custom_fields, '{}'::jsonb)
                                     || jsonb_build_object('_skip_outbound_until_wait', true)
               where id = v_lead.id;
              v_run_at := now();
            else
              v_run_at := now();
            end if;
          else
            v_run_at := now();
          end if;
        end if;
      end if;
    else
      v_delay_amount := coalesce(
        (v_next_step -> 'duration' ->> 'amount')::numeric,
        (v_next_step -> 'delay' ->> 'amount')::numeric,
        case when v_next_type = 'wait_reply' then 12 else 0 end
      );
      v_delay_unit := coalesce(
        v_next_step -> 'duration' ->> 'unit',
        v_next_step -> 'delay' ->> 'unit',
        case when v_next_type = 'wait_reply' then 'hours' else 'minutes' end
      );
      v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
    end if;

    if v_aw is not null and coalesce((v_aw ->> 'enabled')::boolean, false) then
      v_run_at := public.clamp_to_advance_window(v_run_at, v_aw, v_clamp_tz);
    end if;
  else
    v_delay_amount := coalesce((v_next_step -> 'delay' ->> 'amount')::numeric, 0);
    v_delay_unit := coalesce(v_next_step -> 'delay' ->> 'unit', 'minutes');
    v_run_at := now() + (v_delay_amount::text || ' ' || v_delay_unit)::interval;
  end if;

  insert into public.actions (
    tenant_id,
    lead_id,
    action_type,
    step_index,
    template_key,
    run_at,
    status,
    idempotency_key,
    payload,
    run_id
  ) values (
    v_lead.tenant_id,
    v_lead.id,
    v_next_step ->> 'type',
    v_next_index,
    v_next_step ->> 'template_key',
    v_run_at,
    'pending',
    v_lead.id::text || ':' || v_journey.journey_key || ':' || v_next_index::text || ':' || p_action_id::text,
    jsonb_build_object(
      'enrolled_via', v_journey.journey_key,
      'step_spec', v_next_step,
      'continued_from_run_id', v_action.run_id
    ),
    v_action.run_id
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_new_action_id;

  if v_mirror then
    update public.leads
       set current_step = v_next_index,
           next_action_at = v_run_at,
           updated_at = now()
     where id = v_lead.id;
  end if;

  if v_has_event_run then
    update public.journey_runs
       set current_step = v_next_index,      -- PHASE1
           next_action_at = v_run_at,        -- PHASE1
           last_error = null
     where id = v_run.id
       and status not in ('completed', 'failed', 'cancelled');
  end if;

  return v_new_action_id;
end;
$$;

revoke execute on function public.advance_journey(uuid, text)
  from public, anon, authenticated;
grant execute on function public.advance_journey(uuid, text)
  to service_role;
```

- [ ] **Step 2: Apply to dev**

Apply via `apply_migration`, name `advance_journey_run_centric`. Expected: `{"success": true}`.

- [ ] **Step 3: Verify — fresh runs advance run-state through the NEW advance_journey**

The Task 2 runs were advanced by the *old* function and are likely already `completed`. Re-enroll (re-entry after exit is allowed — this itself verifies re-entry) in one statement:

```sql
select enroll_lead_in_journey('<tenant_id>', '<lead_id>', 'phase1_verify_a', 'verify3') as a,
       enroll_lead_in_journey('<tenant_id>', '<lead_id>', 'phase1_verify_b', 'verify3') as b;
```

Expected: both `"status": "enrolled"` (new run ids — re-entry works).

Flush twice (step 0 wait completes → advance schedules step 1 at now → second flush completes step 1), or just wait 60s for two cron ticks:

```sql
select count(*) from dispatch_pending_actions('phase1-verify', 50);
select count(*) from dispatch_pending_actions('phase1-verify', 50);
```

Then:

```sql
select journey_key, status, current_step, responded
  from journey_runs
 where lead_id = '<lead_id from Task 2>'
   and trigger_type = 'verify3'
 order by journey_key;

select journey_template, journey_status, current_step
  from leads
 where id = '<lead_id from Task 2>';
```

Expected: both `verify3` runs have `status = 'completed'` **and `current_step = 1`** — the run itself carried the step state (the PHASE1 change). The lead row shows `journey_template = 'phase1_verify_b'` (last enrolled), `journey_status = 'completed'`, `current_step = 1` — mirrored only from the matching run.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260704092000_advance_journey_run_centric.sql
git commit -m "feat(engine): advance_journey updates run state; lead columns become compat mirror"
```

---

### Task 4: Run-aware dispatch guards + engagement cancel

**Files:**
- Create: `supabase/migrations/20260704093000_run_aware_guards.sql`

Three complete function replacements. `should_dispatch` base is the deployed body (backfill migration line 1050); `dispatch_guard_external_action` base is `20260627092000` (adds `run_not_active` to the permanent-cancel list); `cancel_pending_on_engagement` base is the deployed body (backfill line 2072, adds run `responded` marking).

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1: dispatch guards know about runs.
-- 1) should_dispatch blocks actions whose journey_run is no longer running.
-- 2) dispatch_guard_external_action cancels (not retries) those actions.
-- 3) cancel_pending_on_engagement marks affected runs responded instead of
--    leaving them running forever.

create or replace function public.should_dispatch(p_action_id uuid)
returns table(can_dispatch boolean, reason text, reschedule_to timestamp with time zone)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action actions;
  v_lead leads;
  v_tenant tenants;
  v_run_status text;
  v_bh jsonb;
  v_now_local timestamp;
  v_local_time time;
  v_local_dow text;
  v_business_days jsonb;
  v_start time;
  v_end time;
  v_suppressed int;
begin
  select * into v_action from actions where id = p_action_id;
  select * into v_lead from leads where id = v_action.lead_id;
  select * into v_tenant from tenants where id = v_action.tenant_id;

  -- PHASE1: an action belonging to a non-running run never dispatches.
  if v_action.run_id is not null then
    select status into v_run_status from journey_runs where id = v_action.run_id;
    if v_run_status is not null and v_run_status <> 'running' then
      return query select false, 'run_not_active', null::timestamptz;
      return;
    end if;
  end if;

  if v_action.action_type = 'wait' then
    return query select true, null::text, null::timestamptz;
    return;
  end if;

  if v_lead.opt_out then
    return query select false, 'lead_opt_out', null::timestamptz;
    return;
  end if;
  if v_lead.responded and v_action.action_type <> 'team_alert' then
    return query select false, 'lead_responded', null::timestamptz;
    return;
  end if;
  if v_lead.callback_requested and v_action.action_type <> 'team_alert' then
    return query select false, 'callback_requested', null::timestamptz;
    return;
  end if;

  if coalesce((v_lead.custom_fields ->> '_skip_outbound_until_wait')::bool, false)
     and v_action.action_type in ('email','sms','call') then
    return query select false, 'skip_outbound_until_wait', null::timestamptz;
    return;
  end if;

  if coalesce((v_tenant.channel_pauses ->> v_action.action_type)::bool, false) then
    return query select false, 'channel_paused', null::timestamptz;
    return;
  end if;

  select count(*) into v_suppressed
    from suppressions
   where tenant_id = v_action.tenant_id
     and (channel is null or channel = v_action.action_type)
     and (
       (v_action.action_type = 'email' and email = v_lead.email)
       or (v_action.action_type in ('sms','call') and phone_e164 = v_lead.phone_e164)
     );
  if v_suppressed > 0 then
    return query select false, 'suppressed', null::timestamptz;
    return;
  end if;

  if v_tenant.status <> 'active' then
    return query select false, 'tenant_inactive', null::timestamptz;
    return;
  end if;

  if v_action.action_type in ('call', 'sms') then
    v_bh := v_tenant.business_hours;
    v_business_days := v_bh -> 'days';
    v_start := (v_bh ->> 'start')::time;
    v_end := (v_bh ->> 'end')::time;
    v_now_local := (now() at time zone v_tenant.timezone);
    v_local_time := v_now_local::time;
    v_local_dow := to_char(v_now_local, 'Dy');

    if not (v_business_days @> to_jsonb(v_local_dow))
       or v_local_time < v_start
       or v_local_time > v_end then
      return query select false, 'outside_business_hours',
        next_business_window(v_tenant.timezone, v_tenant.business_hours);
      return;
    end if;
  end if;

  return query select true, null::text, null::timestamptz;
end;
$$;

create or replace function public.dispatch_guard_external_action(
  p_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard record;
  v_reason text;
  v_reschedule_to timestamptz;
  v_permanent_reasons text[] := array[
    'lead_opt_out',
    'lead_responded',
    'callback_requested',
    'skip_outbound_until_wait',
    'suppressed',
    'tenant_inactive',
    'run_not_active'  -- PHASE1
  ];
begin
  select can_dispatch, reason, reschedule_to
    into v_guard
    from public.should_dispatch(p_action_id)
   limit 1;

  if not found or coalesce(v_guard.can_dispatch, false) then
    return jsonb_build_object('can_dispatch', true);
  end if;

  v_reason := coalesce(v_guard.reason, 'should_dispatch_blocked');
  v_reschedule_to := v_guard.reschedule_to;

  if v_reschedule_to is not null then
    update public.actions
       set status = 'pending',
           run_at = v_reschedule_to,
           next_retry_at = null,
           locked_until = null,
           locked_by = null,
           last_skip_reason = v_reason,
           reschedule_count = coalesce(reschedule_count, 0) + 1,
           error_message = left(v_reason, 2000),
           last_error = left(v_reason, 2000)
     where id = p_action_id;

    insert into public.error_logs (
      tenant_id, workflow_name, error_message, raw_error, severity, status
    )
    select tenant_id, 'dispatch_pending_actions:guard_rescheduled',
           'Dispatch deferred by should_dispatch: ' || v_reason,
           jsonb_build_object(
             'action_id', p_action_id,
             'reason', v_reason,
             'reschedule_to', v_reschedule_to
           ),
           'info', 'open'
      from public.actions
     where id = p_action_id;

    return jsonb_build_object(
      'can_dispatch', false,
      'status', 'rescheduled',
      'reason', v_reason,
      'reschedule_to', v_reschedule_to
    );
  end if;

  update public.actions
     set status = case when v_reason = any(v_permanent_reasons)
                       then 'cancelled'
                       else 'pending'
                  end,
         run_at = case when v_reason = any(v_permanent_reasons)
                       then run_at
                       else now() + interval '15 minutes'
                  end,
         locked_until = null,
         locked_by = null,
         last_skip_reason = v_reason,
         reschedule_count = case when v_reason = any(v_permanent_reasons)
                                 then reschedule_count
                                 else coalesce(reschedule_count, 0) + 1
                            end,
         error_message = left(v_reason, 2000),
         last_error = left(v_reason, 2000)
   where id = p_action_id;

  insert into public.error_logs (
    tenant_id, workflow_name, error_message, raw_error, severity, status
  )
  select tenant_id,
         case when v_reason = any(v_permanent_reasons)
              then 'dispatch_pending_actions:guard_cancelled'
              else 'dispatch_pending_actions:guard_deferred'
         end,
         'Dispatch blocked by should_dispatch: ' || v_reason,
         jsonb_build_object('action_id', p_action_id, 'reason', v_reason),
         'info', 'open'
    from public.actions
   where id = p_action_id;

  return jsonb_build_object(
    'can_dispatch', false,
    'status', case when v_reason = any(v_permanent_reasons) then 'cancelled' else 'deferred' end,
    'reason', v_reason
  );
end;
$$;

create or replace function public.cancel_pending_on_engagement(
  p_lead_id uuid,
  p_engagement text,
  p_reason text default null::text,
  p_source_action_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lead leads;
  v_msg text;
  v_cancelled_ids uuid[];
  v_cancelled_count int := 0;
begin
  select * into v_lead from leads where id = p_lead_id;
  if not found then
    return jsonb_build_object('status','lead_not_found');
  end if;

  v_msg := 'Cancelled by engagement: ' || p_engagement ||
           case when p_reason is not null then ' — ' || p_reason else '' end;

  with cancelled as (
    update actions
       set status        = 'cancelled',
           error_message = v_msg,
           locked_until  = null,
           locked_by     = null
     where lead_id    = p_lead_id
       and status     = 'pending'
       and action_type not in ('team_alert','wait_reply')
       and (p_source_action_id is null or id <> p_source_action_id)
     returning id
  )
  select array_agg(id), count(*)::int
    from cancelled
    into v_cancelled_ids, v_cancelled_count;

  -- PHASE1: runs whose pending work was cancelled by engagement are
  -- 'responded', not silently stuck 'running'.
  update journey_runs jr
     set status = 'responded',
         responded = true,
         completed_at = coalesce(jr.completed_at, now())
   where jr.status = 'running'
     and jr.id in (
       select distinct a.run_id
         from actions a
        where a.id = any(coalesce(v_cancelled_ids, '{}'::uuid[]))
          and a.run_id is not null
     );

  if v_cancelled_count > 0 then
    insert into events (tenant_id, lead_id, channel, direction, provider, body, raw_payload)
    values (
      v_lead.tenant_id, p_lead_id, 'system', 'internal', 'engine',
      v_msg || ' (' || v_cancelled_count || ' action' ||
        case when v_cancelled_count = 1 then '' else 's' end || ' cancelled)',
      jsonb_build_object(
        'engagement',       p_engagement,
        'reason',           p_reason,
        'source_action_id', p_source_action_id,
        'cancelled_ids',    to_jsonb(v_cancelled_ids),
        'cancelled_count',  v_cancelled_count
      )
    );

    insert into error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (
      v_lead.tenant_id,
      'engagement_cancel',
      v_msg || ' (' || v_cancelled_count || ' cancelled)',
      jsonb_build_object(
        'lead_id',          p_lead_id,
        'engagement',       p_engagement,
        'cancelled_ids',    to_jsonb(v_cancelled_ids),
        'cancelled_count',  v_cancelled_count
      ),
      'info', 'open'
    );
  end if;

  return jsonb_build_object(
    'status',           'success',
    'cancelled_count',  v_cancelled_count,
    'cancelled_ids',    to_jsonb(coalesce(v_cancelled_ids, '{}'::uuid[]))
  );
end;
$$;

do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('should_dispatch', 'dispatch_guard_external_action', 'cancel_pending_on_engagement')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
```

- [ ] **Step 2: Apply to dev**

Apply via `apply_migration`, name `run_aware_guards`. Expected: `{"success": true}`.

- [ ] **Step 3: Verify `run_not_active` blocking**

```sql
-- give the Task-2 lead a pending action on the already-completed run A
insert into actions (tenant_id, lead_id, run_id, action_type, step_index, run_at, status, idempotency_key, payload)
select r.tenant_id, r.lead_id, r.id, 'email', 1, now(), 'pending',
       'run:' || r.id::text || ':guard-test',
       '{"step_spec":{"index":1,"type":"email"}}'::jsonb
  from journey_runs r
 where r.lead_id = '<lead_id from Task 2>' and r.journey_key = 'phase1_verify_a'
returning id;

select * from should_dispatch('<returned action id>');
```

Expected: `can_dispatch = false, reason = 'run_not_active'`. Then clean up:

```sql
delete from actions where idempotency_key like 'run:%:guard-test';
```

Expected: 1 row deleted.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260704093000_run_aware_guards.sql
git commit -m "feat(engine): run-aware should_dispatch, guard cancel, engagement marks runs responded"
```

---

### Task 5: Webhook enrollment through the RPC

**Files:**
- Create: `supabase/migrations/20260704094000_webhook_enroll_via_rpc.sql`

`process_journey_webhook` keeps all its lead-matching/mapping/sample logic but delegates run+action creation to `enroll_lead_in_journey` (both the stamped-lead branch and the identifier branch). This also covers the `journey-trigger` edge function, which calls this RPC. The body below is the deployed version with the two `insert into actions` blocks and direct `journey_template` writes replaced.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1: webhook enrollment goes through enroll_lead_in_journey, so a
-- webhook hit creates a journey_run like every other enrollment path.
-- Lead matching, field mapping, and sample capture are unchanged.

create or replace function public.process_journey_webhook(
  p_token text,
  p_payload jsonb,
  p_headers jsonb default '{}'::jsonb,
  p_auth_header text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_journey journeys;
  v_mapping jsonb;
  v_lead_field text;
  v_map_entry  jsonb;
  v_lead_first text;
  v_lead_last  text;
  v_lead_email text;
  v_lead_phone text;
  v_lead_id    uuid;
  v_existing_lead leads;
  v_custom_fields jsonb := '{}'::jsonb;
  v_path text;
  v_val  text;
  v_provided_token text;
  v_sample_id uuid;
  v_result jsonb;
  v_enroll jsonb;
  v_action_id uuid;

  v_stamped_lead_id_text text;
  v_stamped_lead_id      uuid;
begin
  select * into v_journey from journeys where webhook_token = p_token and active = true;
  if not found then
    return jsonb_build_object('status','failed','reason','journey_not_found_for_token');
  end if;

  if v_journey.webhook_auth_mode = 'bearer' then
    if p_auth_header is null then
      return jsonb_build_object('status','auth_failed','reason','missing_authorization_header');
    end if;
    v_provided_token := trim(regexp_replace(p_auth_header, '^[Bb]earer\s+', ''));
    if v_provided_token is null or v_provided_token = ''
       or v_provided_token <> coalesce(v_journey.webhook_secret, '') then
      return jsonb_build_object('status','auth_failed','reason','invalid_secret');
    end if;
  end if;

  insert into journey_webhook_samples (journey_id, payload, headers)
       values (v_journey.id, p_payload, p_headers) returning id into v_sample_id;
  delete from journey_webhook_samples
   where id in (
     select id from journey_webhook_samples
      where journey_id = v_journey.id
      order by received_at desc offset 20);

  v_stamped_lead_id_text := coalesce(
    _extract_json_path(p_payload, 'metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'followup_lead_id'),
    _extract_json_path(p_payload, 'body.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'body.call.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'body.call.dynamic_variables.followup_lead_id'),
    _extract_json_path(p_payload, 'call.metadata.followup_lead_id'),
    _extract_json_path(p_payload, 'call.dynamic_variables.followup_lead_id')
  );

  if v_stamped_lead_id_text is not null and v_stamped_lead_id_text <> '' then
    begin
      v_stamped_lead_id := v_stamped_lead_id_text::uuid;
    exception when others then
      v_stamped_lead_id := null;
    end;

    if v_stamped_lead_id is not null then
      select * into v_existing_lead
        from leads
       where id = v_stamped_lead_id and tenant_id = v_journey.tenant_id;

      if found then
        v_lead_id := v_existing_lead.id;
        update leads
           set raw_payload = p_payload,
               updated_at  = now()
         where id = v_lead_id;

        -- PHASE1: run-centric enrollment (re-entry allowed; running run reused)
        v_enroll := enroll_lead_in_journey(
          v_journey.tenant_id, v_lead_id, v_journey.journey_key, 'webhook', p_payload
        );
        v_action_id := nullif(v_enroll ->> 'action_id', '')::uuid;

        v_result := jsonb_build_object(
          'status','success', 'lead_id', v_lead_id, 'action_id', v_action_id,
          'run_id', nullif(v_enroll ->> 'run_id', '')::uuid,
          'enroll_status', v_enroll ->> 'status',
          'journey_key', v_journey.journey_key, 'matched_via','followup_lead_id'
        );
        update journey_webhook_samples
           set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
               result_message='Lead matched via followup_lead_id, enrollment: ' || coalesce(v_enroll ->> 'status', 'unknown')
         where id = v_sample_id;
        return v_result;
      end if;
      v_result := jsonb_build_object(
        'status','sample_captured_no_lead', 'reason','stamped_lead_id_not_found',
        'message','followup_lead_id=' || v_stamped_lead_id_text || ' did not match any lead in this tenant.'
      );
      update journey_webhook_samples
         set result_status='sample_captured_no_lead', result_reason='stamped_lead_id_not_found',
             result_message=v_result->>'message'
       where id = v_sample_id;
      return v_result;
    end if;
  end if;

  v_mapping := coalesce(v_journey.spec->'webhook_mapping', '{}'::jsonb);

  for v_lead_field, v_map_entry in select * from jsonb_each(v_mapping) loop
    if jsonb_typeof(v_map_entry) = 'string' then v_path := v_map_entry #>> '{}';
    else v_path := v_map_entry->>'from'; end if;
    v_val := _extract_json_path(p_payload, v_path);
    if v_val is null then continue; end if;

    if v_lead_field = 'first_name' then v_lead_first := v_val;
    elsif v_lead_field = 'last_name' then v_lead_last := v_val;
    elsif v_lead_field = 'email' then v_lead_email := lower(v_val);
    elsif v_lead_field in ('phone','phone_e164','phone_raw') then v_lead_phone := v_val;
    elsif v_lead_field like 'custom.%' then
      v_custom_fields := v_custom_fields || jsonb_build_object(substring(v_lead_field from 8), v_val);
    end if;
  end loop;

  if v_lead_email is null then v_lead_email := lower(coalesce(p_payload->>'email','')); end if;
  if v_lead_first is null then v_lead_first := coalesce(p_payload->>'first_name', p_payload->>'firstName',''); end if;
  if v_lead_last  is null then v_lead_last  := coalesce(p_payload->>'last_name',  p_payload->>'lastName',''); end if;
  if v_lead_phone is null then v_lead_phone := coalesce(p_payload->>'phone',      p_payload->>'phoneNumber',''); end if;
  if v_lead_email = '' then v_lead_email := null; end if;
  if v_lead_first = '' then v_lead_first := null; end if;
  if v_lead_last  = '' then v_lead_last  := null; end if;
  if v_lead_phone = '' then v_lead_phone := null; end if;

  if v_lead_email is null and v_lead_phone is null then
    v_result := jsonb_build_object('status','sample_captured_no_lead','reason','no_identifier',
      'message','Sample captured but no identifier was resolved. Stamp followup_lead_id on outbound, or configure webhook_mapping for new-lead intake.');
    update journey_webhook_samples
       set result_status='sample_captured_no_lead', result_reason='no_identifier',
           result_message=v_result->>'message'
     where id = v_sample_id;
    return v_result;
  end if;

  if v_lead_email is not null then
    select * into v_existing_lead from leads
     where tenant_id = v_journey.tenant_id and lower(email) = v_lead_email
     order by created_at desc limit 1;
  end if;
  if v_existing_lead.id is null and v_lead_phone is not null then
    select * into v_existing_lead from leads
     where tenant_id = v_journey.tenant_id and phone_e164 = v_lead_phone
     order by created_at desc limit 1;
  end if;

  if v_existing_lead.id is null then
    insert into leads (
      tenant_id, source, first_name, last_name, email, phone_raw, phone_e164,
      journey_status, custom_fields, raw_payload
    ) values (
      v_journey.tenant_id, 'webhook', v_lead_first, v_lead_last, v_lead_email,
      v_lead_phone, v_lead_phone, 'new', v_custom_fields, p_payload
    ) returning id into v_lead_id;
  else
    update leads set
      first_name = coalesce(v_lead_first, first_name),
      last_name  = coalesce(v_lead_last,  last_name),
      email      = coalesce(nullif(v_lead_email, ''), email),
      phone_raw  = coalesce(v_lead_phone, phone_raw),
      phone_e164 = coalesce(v_lead_phone, phone_e164),
      custom_fields = coalesce(custom_fields,'{}'::jsonb) || v_custom_fields,
      raw_payload = p_payload,
      updated_at = now()
     where id = v_existing_lead.id
     returning id into v_lead_id;
  end if;

  -- PHASE1: run-centric enrollment (sets the lead mirror columns itself)
  v_enroll := enroll_lead_in_journey(
    v_journey.tenant_id, v_lead_id, v_journey.journey_key, 'webhook', p_payload
  );
  v_action_id := nullif(v_enroll ->> 'action_id', '')::uuid;

  v_result := jsonb_build_object('status','success','lead_id', v_lead_id,
                                 'action_id', v_action_id,
                                 'run_id', nullif(v_enroll ->> 'run_id', '')::uuid,
                                 'enroll_status', v_enroll ->> 'status',
                                 'journey_key', v_journey.journey_key);
  update journey_webhook_samples
     set result_status='success', result_lead_id=v_lead_id, result_action_id=v_action_id,
         result_message='Lead created/updated, enrollment: ' || coalesce(v_enroll ->> 'status', 'unknown')
   where id = v_sample_id;
  return v_result;
end;
$$;

revoke execute on function public.process_journey_webhook(text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.process_journey_webhook(text, jsonb, jsonb, text)
  to service_role;
```

- [ ] **Step 2: Apply to dev**

Apply via `apply_migration`, name `webhook_enroll_via_rpc`. Expected: `{"success": true}`.

- [ ] **Step 3: Verify with a synthetic webhook journey (no real sends)**

```sql
-- point a webhook at the phase1_verify_a journey (wait->exit, harmless)
update journeys set webhook_token = 'phase1-verify-token'
 where journey_key = 'phase1_verify_a' and tenant_id = '<tenant_id from Task 2>';

select process_journey_webhook(
  'phase1-verify-token',
  '{"email":"phase1-webhook@example.invalid","first_name":"Hook"}'::jsonb
);
```

Expected JSON: `status='success'`, non-null `run_id`, `enroll_status='enrolled'`. Verify the run exists:

```sql
select status, trigger_type, journey_key
  from journey_runs
 where lead_id = (select id from leads where email='phase1-webhook@example.invalid')
   and journey_key = 'phase1_verify_a';
```

Expected: one row, `trigger_type = 'webhook'`. (It will complete on the next dispatcher tick — either status is acceptable here.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260704094000_webhook_enroll_via_rpc.sql
git commit -m "feat(engine): webhook enrollment creates journey_runs via enroll_lead_in_journey"
```

---

### Task 6: Dashboard enrollment paths (TDD for eligibility)

**Files:**
- Modify: `dashboard/tests/bulk-enroll.test.mjs`
- Modify: `dashboard/src/lib/bulkEnroll.js`
- Modify: `dashboard/src/app/api/leads/bulk-enroll/route.js`
- Modify: `dashboard/src/app/api/leads/route.js:471-505`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/bulk-enroll.test.mjs` (match the file's existing import style — it already imports from `../src/lib/bulkEnroll.js`):

```js
test("lead active in a DIFFERENT journey is still eligible (multi-enrollment)", () => {
  const lead = { id: "l1", email: "a@b.co", journey_status: "active", journey_template: "other_journey" };
  const journey = { journey_key: "reactivation", spec: { steps: [{ index: 0, type: "email" }] } };
  const result = getBulkEnrollEligibility(lead, journey, buildSuppressionLookup(), new Set(["other_journey"]));
  assert.equal(result.status, BULK_ENROLL_STATUSES.READY);
});

test("lead with a running run in the SAME journey is skipped", () => {
  const lead = { id: "l1", email: "a@b.co", journey_status: "active", journey_template: "reactivation" };
  const journey = { journey_key: "reactivation", spec: { steps: [{ index: 0, type: "email" }] } };
  const result = getBulkEnrollEligibility(lead, journey, buildSuppressionLookup(), new Set(["reactivation"]));
  assert.equal(result.status, BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE);
});

test("legacy journey_status alone no longer blocks other journeys", () => {
  const lead = { id: "l1", email: "a@b.co", journey_status: "active", journey_template: "old_one" };
  const journey = { journey_key: "new_one", spec: { steps: [{ index: 0, type: "email" }] } };
  const result = getBulkEnrollEligibility(lead, journey, buildSuppressionLookup(), new Set());
  assert.equal(result.status, BULK_ENROLL_STATUSES.READY);
});
```

If `getBulkEnrollEligibility` / `buildSuppressionLookup` / `BULK_ENROLL_STATUSES` are not yet imported at the top of the test file, add them to the existing import from `../src/lib/bulkEnroll.js`.

- [ ] **Step 2: Run tests, confirm the new ones fail**

```bash
cd dashboard && npm test
```

Expected: the first and third new tests FAIL (current code skips on any active `journey_status`).

- [ ] **Step 3: Implement per-journey eligibility in `bulkEnroll.js`**

In `dashboard/src/lib/bulkEnroll.js`:

Replace the signature and the already-active check in `getBulkEnrollEligibility`:

```js
export function getBulkEnrollEligibility(lead, journey, suppressionLookup = buildSuppressionLookup(), activeJourneyKeys = new Set()) {
```

Replace this block:

```js
  if (ACTIVE_JOURNEY_STATUSES.has(String(lead.journey_status || "").toLowerCase())) {
    return {
      status: BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE,
      reason: "Lead is already active in a journey.",
    };
  }
```

with:

```js
  if (activeJourneyKeys.has(journey?.journey_key)) {
    return {
      status: BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE,
      reason: "Lead already has a running enrollment in this journey.",
    };
  }
```

Delete the now-unused `ACTIVE_JOURNEY_STATUSES` constant. Update `planBulkEnroll` to accept and forward run data:

```js
export function planBulkEnroll({ requestedLeadIds = [], leads = [], journey = null, suppressions = [], activeRunsByLeadId = new Map() } = {}) {
  const leadById = new Map((leads || []).map((lead) => [String(lead.id), lead]));
  const suppressionLookup = buildSuppressionLookup(suppressions);

  const results = requestedLeadIds.map((leadId) => {
    const lead = leadById.get(String(leadId));
    const activeJourneyKeys = activeRunsByLeadId.get(String(leadId)) || new Set();
    const eligibility = getBulkEnrollEligibility(lead, journey, suppressionLookup, activeJourneyKeys);
    return {
      lead_id: String(leadId),
      status: eligibility.status,
      reason: eligibility.reason,
      action_type: eligibility.step0?.type || null,
    };
  });

  return {
    results,
    summary: summarizeBulkEnrollResults(results),
  };
}
```

- [ ] **Step 4: Run tests, confirm all pass**

```bash
cd dashboard && npm test
```

Expected: PASS (all files). If any pre-existing test asserted the old "active anywhere blocks" behavior, update that test to pass an `activeJourneyKeys` set containing the same journey key — the old behavior is intentionally gone.

- [ ] **Step 5: Bulk-enroll route uses the RPC**

In `dashboard/src/app/api/leads/bulk-enroll/route.js`:

1. Add after `loadSuppressions(...)` call in `POST`:

```js
    const { data: runRows, error: runErr } = await supabase
      .from("journey_runs")
      .select("lead_id, journey_key")
      .eq("tenant_id", tenantId)
      .eq("status", "running")
      .in("lead_id", (leads || []).map((l) => l.id));
    if (runErr) throw runErr;
    const activeRunsByLeadId = new Map();
    for (const row of runRows || []) {
      const key = String(row.lead_id);
      if (!activeRunsByLeadId.has(key)) activeRunsByLeadId.set(key, new Set());
      activeRunsByLeadId.get(key).add(row.journey_key);
    }
```

2. Pass it into the plan: `planBulkEnroll({ requestedLeadIds: ..., leads: ..., journey, suppressions, activeRunsByLeadId })`.

3. Replace the enrollment loop body (the `insertStep0Action` + `activateLead` + catch block) with:

```js
      const lead = leadsById.get(planned.lead_id);
      try {
        const { data: enroll, error: enrollErr } = await supabase.rpc("enroll_lead_in_journey", {
          p_tenant_id: tenantId,
          p_lead_id: lead.id,
          p_journey_key: journey.journey_key,
          p_source: "bulk_enroll",
        });
        if (enrollErr) throw enrollErr;

        if (enroll?.status === "enrolled") {
          results.push({
            ...planned,
            status: BULK_ENROLL_STATUSES.ENROLLED,
            reason: "Lead enrolled and step 0 action queued.",
            run_id: enroll.run_id,
            action_id: enroll.action_id,
          });
        } else if (enroll?.status === "already_active") {
          results.push({
            ...planned,
            status: BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE,
            reason: "Lead already has a running enrollment in this journey.",
            run_id: enroll.run_id,
          });
        } else if (enroll?.status === "lead_opted_out") {
          results.push({ ...planned, status: BULK_ENROLL_STATUSES.SKIPPED_OPTED_OUT, reason: "Lead is opted out." });
        } else {
          results.push({ ...planned, status: BULK_ENROLL_STATUSES.FAILED, reason: `Enrollment failed: ${enroll?.status || "unknown"}` });
        }
      } catch (err) {
        results.push({
          ...planned,
          status: BULK_ENROLL_STATUSES.FAILED,
          reason: err.message || "Failed to enroll lead.",
        });
      }
```

4. Delete the now-unused `insertStep0Action`, `activateLead`, and `cancelQueuedAction` functions and the `buildBulkEnrollIdempotencyKey` / `getFirstJourneyStep` imports if nothing else in the file uses them (`getFirstJourneyStep` is still used for the `step0` pre-check — keep that).

- [ ] **Step 6: Manual lead-create uses the RPC**

In `dashboard/src/app/api/leads/route.js`, replace the step-0 queueing block (the `const step0 = ...` through the closing `}` of `if (step0) {...}`, currently lines ~481-505) with:

```js
    if (journey?.journey_key) {
      const { data: enroll, error: enrollErr } = await supabase.rpc("enroll_lead_in_journey", {
        p_tenant_id: tenantId,
        p_lead_id: newLead.id,
        p_journey_key: journey.journey_key,
        p_source: "lead_create",
      });
      if (enrollErr || (enroll && !["enrolled", "already_active"].includes(enroll.status))) {
        const detail = enrollErr?.message || enroll?.status || "unknown";
        console.error("Lead created but enrollment failed:", detail);
        return NextResponse.json(
          { data: newLead, warning: `Lead created but journey enrollment failed: ${detail}` }
        );
      }
    }
```

- [ ] **Step 7: Run the full JS suite + lint**

```bash
cd dashboard && npm test && npx eslint src/lib/bulkEnroll.js src/app/api/leads/bulk-enroll/route.js src/app/api/leads/route.js
```

Expected: tests PASS, no new lint errors.

- [ ] **Step 8: Commit**

```bash
git add dashboard/tests/bulk-enroll.test.mjs dashboard/src/lib/bulkEnroll.js dashboard/src/app/api/leads/bulk-enroll/route.js dashboard/src/app/api/leads/route.js
git commit -m "feat(dashboard): enrollment via enroll_lead_in_journey RPC; per-journey already-active rule"
```

**Note:** `dashboard/src/app/api/leads/route.js` has unrelated uncommitted changes in the working tree. Review `git diff` for that file before staging; if the unrelated hunks are not yours to commit, use `git add -p` and stage only the enrollment hunks.

---

### Task 7: Backfill runs for currently-active leads

**Files:**
- Create: `supabase/migrations/20260704095000_backfill_journey_runs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1 backfill: every lead currently active in a journey gets a running
-- journey_run, and its in-flight actions are linked to that run. Idempotent
-- via the backfill idempotency key.

insert into public.journey_runs (
  tenant_id, journey_id, journey_key, journey_version,
  mode, trigger_type, status, lead_id,
  current_step, next_action_at, idempotency_key
)
select l.tenant_id, j.id, l.journey_template, j.version,
       'lead_journey', 'backfill', 'running', l.id,
       coalesce(l.current_step, 0), l.next_action_at,
       'backfill:' || l.id::text || ':' || l.journey_template
  from public.leads l
  join lateral (
    select id, version from public.journeys j
     where j.tenant_id = l.tenant_id and j.journey_key = l.journey_template and j.active
     order by version desc limit 1
  ) j on true
 where l.journey_status = 'active'
   and coalesce(l.journey_template, '') <> ''
   -- guard: skip leads that already got a running run for this journey via the
   -- new RPC — inserting would violate journey_runs_one_running_per_lead_journey,
   -- which the on-conflict clause below does NOT arbitrate.
   and not exists (
     select 1 from public.journey_runs r
      where r.tenant_id = l.tenant_id
        and r.lead_id = l.id
        and r.journey_key = l.journey_template
        and r.status = 'running'
   )
on conflict (tenant_id, idempotency_key) where idempotency_key is not null
do nothing;

update public.actions a
   set run_id = r.id
  from public.journey_runs r
 where a.run_id is null
   and a.status in ('pending', 'in_progress')
   and r.tenant_id = a.tenant_id
   and r.lead_id = a.lead_id
   and r.status = 'running'
   and r.trigger_type = 'backfill';
```

- [ ] **Step 2: Apply to dev**

Apply via `apply_migration`, name `backfill_journey_runs`. Expected: `{"success": true}`.

- [ ] **Step 3: Verify parity**

```sql
select
  (select count(*) from leads where journey_status = 'active' and coalesce(journey_template,'') <> '') as active_leads,
  (select count(*) from journey_runs where trigger_type = 'backfill' and status = 'running') as backfill_runs,
  (select count(*) from actions where status in ('pending','in_progress') and run_id is null and lead_id is not null) as unlinked_inflight;
```

Expected: `backfill_runs = active_leads` (leads pointing at inactive/deleted journeys are legitimately excluded — if the counts differ, list the excluded leads and confirm each has no matching active journey). `unlinked_inflight = 0`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260704095000_backfill_journey_runs.sql
git commit -m "feat(engine): backfill journey_runs for active leads and link in-flight actions"
```

---

### Task 8: End-to-end verification, cleanup, decision record

**Files:**
- Create: `docs/decisions/002-run-centric-journeys.md`

- [ ] **Step 1: Full-path E2E on dev (cron does the work, not manual flush)**

Enroll a fresh throwaway lead in both `phase1_verify_a` and `phase1_verify_b` via the RPC (as in Task 2 Step 3, new lead email `phase1-e2e@example.invalid`). The journeys have two steps, so full traversal needs two dispatcher ticks — wait ≥90s, then:

```sql
select journey_key, status, current_step
  from journey_runs
 where lead_id = (select id from leads where email = 'phase1-e2e@example.invalid')
 order by journey_key;
```

Expected: both rows `completed` with `current_step = 1`, advanced by the *cron* dispatcher with zero manual flushes.

- [ ] **Step 2: Confirm zero engine errors during the E2E window**

```sql
select count(*) from error_logs
 where created_at > now() - interval '10 minutes'
   and severity = 'error';
```

Expected: `0`.

- [ ] **Step 3: Clean up all Phase 1 verification data**

```sql
delete from actions where lead_id in (select id from leads where email in ('phase1-test@example.invalid','phase1-webhook@example.invalid','phase1-e2e@example.invalid'));
delete from journey_runs where lead_id in (select id from leads where email in ('phase1-test@example.invalid','phase1-webhook@example.invalid','phase1-e2e@example.invalid'));
delete from leads where email in ('phase1-test@example.invalid','phase1-webhook@example.invalid','phase1-e2e@example.invalid');
delete from journey_webhook_samples where journey_id in (select id from journeys where journey_key in ('phase1_verify_a','phase1_verify_b'));
delete from journeys where journey_key in ('phase1_verify_a','phase1_verify_b');
```

Then verify: `select count(*) from journeys where journey_key like 'phase1_verify%';` → `0`.

- [ ] **Step 4: Write the decision record**

Create `docs/decisions/002-run-centric-journeys.md`:

```markdown
# 002 — Run-centric journeys (Phase 1)

**Date:** 2026-07-04
**Status:** Accepted

## Decision
`journey_runs` is the enrollment record for lead journeys. One running run per
(tenant, lead, journey); re-entry after exit creates a new run; concurrent runs
across different journeys are allowed. `enroll_lead_in_journey` is the only
write path for enrollment (manual create, bulk enroll, webhook).

## Compat layer (temporary)
`leads.journey_template / journey_status / current_step / next_action_at` are a
mirror of the run whose journey_key matches `journey_template`, kept so the
Phase-1 dashboard needs no changes. Do not build new features on these columns.

## Explicitly deferred
- Merging `workflow_actions` into the `actions` queue (Phase 2)
- Per-run stop-on-response (today a reply cancels pending outbound lead-wide)
- Multi-run UI on the leads page (reads the mirror columns for now)
- Trigger system (tag_added / form_submitted / etc.)
```

- [ ] **Step 5: Commit**

```bash
git add docs/decisions/002-run-centric-journeys.md docs/superpowers/plans/2026-07-03-phase1-run-centric-journeys.md
git commit -m "docs: run-centric journeys decision record + phase 1 plan"
```

---

## Post-Plan Checklist (executor)

- [ ] `cd dashboard && npm test` — full suite green
- [ ] Supabase advisors (security) — no new ERROR-level findings; new functions must carry the revoke/grant block (Tasks 2-5 include it)
- [ ] `error_logs` clean for 10+ minutes of cron ticks
- [ ] All `phase1_verify*` / `*.invalid` test data deleted from dev

## Known Risks

1. **Mirror divergence:** if an operator manually edits `leads.journey_status` in the UI (`/api/leads/[id]` PATCH allows it), the run is not updated. Acceptable in Phase 1; the PATCH path migrates to run mutations in Phase 2.
2. **`leads/route.js` uncommitted changes:** the working tree already has local edits to this file. Stage hunks selectively (Task 6 note).
3. **Re-enrollment loops via webhook:** repeated webhook hits for the same lead+journey reuse the running run (`already_active`) — no action spam — but a hit after completion legitimately re-enrolls. That is GHL-default behavior; per-journey re-entry policy is a Phase 3 builder feature.
4. **Inline actions bypass `should_dispatch` (pre-existing):** the dispatcher only guards external channel actions (call/sms/email) via `dispatch_guard_external_action`; inline types (wait, tags, conditional_split, …) execute directly. So an inline action left behind by a non-running run would still execute. Exposure is low — engagement cancel now cancels those actions and marks the run — but the clean fix is guarding inline processing too, which lands with the Phase 2 queue unification.
