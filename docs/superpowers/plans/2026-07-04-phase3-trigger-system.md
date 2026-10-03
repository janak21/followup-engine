# Phase 3: Event-Driven Trigger System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Journeys can be triggered by events — `tag_added`, `incoming_sms`, `email_replied`, `lead_created` — with per-trigger filters, per-journey re-enrollment policy, and loop protection; the builder's "Coming soon" trigger options go live.

**Architecture:** A `journey_triggers` table (synced automatically from `journeys.spec` by a DB trigger on save) is the indexed subscription registry. One RPC — `fire_journey_triggers(tenant, lead, type, event)` — evaluates filters and enrolls via the existing `enroll_lead_in_journey` (which gains a re-enrollment policy). Firing points: DB triggers on `leads` for `lead_created`/`tag_added` (catches every mutation path — SQL handlers, dashboard PATCH, CSV import), and explicit calls inside `process_inbound_sms`/`process_inbound_email` for message events (they are the single inbound funnels and hold the parsed body for keyword filters). Loop protection = concurrent-run block (existing unique index) + same-trigger cooldown + recursion depth guard.

**Tech Stack:** Supabase Postgres 17 (plpgsql), Next.js dashboard (JS), `node --test`.

---

## Environment & Working Agreements

- **Repo:** `<repo-root>` (branch `main`). Only `git add` files named in each commit step.
- **Migrations:** file in `supabase/migrations/` + apply identical SQL to dev `your-project-ref` via MCP `apply_migration`. Verify via `execute_sql`.
- **JS tests:** `cd dashboard && npm test`.
- **Dev-data caution:** trigger verification uses synthetic wait→exit journeys and `*.invalid` leads only; delete all test rows at the end of each task that creates them.
- **Prerequisite:** Phase 2 Task 8 (decommission) may still be gated when this starts — that's fine; nothing here touches `workflow_actions`.

## Hard Rules (violations caused production bugs in Phases 1-2)

1. **Never `CREATE OR REPLACE` a function without first diffing the DEPLOYED body** (`pg_get_functiondef`) against the repo's newest version. Task 0 enforces this for every function this plan replaces.
2. **Never introduce a function overload** — replace exact signatures; `drop function if exists <old signature>` in the same migration when parameters change.
3. **Verify every column a function writes exists** (`information_schema.columns`).
4. **Every new/replaced function gets the grants block** (`revoke ... from public, anon, authenticated; grant ... to service_role;`).

## Locked Design Decisions

1. **Spec stays the source of truth.** The builder keeps writing `trigger_type` + `trigger_config` into `journeys.spec`; a DB trigger on `journeys` syncs `journey_triggers` rows on every save. No dashboard save-path changes.
2. **One trigger per journey this phase** (matches the builder's single-trigger canvas). The table supports many rows per journey so multi-trigger is a UI-only follow-up.
3. **Re-enrollment policy** lives at `spec->>'reenrollment'`: `'allow'` (default — re-entry after exit, current behavior) or `'once_ever'`. Concurrent same-journey enrollment stays blocked by the Phase 1 unique index regardless.
4. **Loop protection, three layers:** (a) the one-running-run index; (b) cooldown — a trigger will not re-enroll a lead into the same journey within 60 minutes of the previous run created by the same trigger type (per-journey override via `spec->>'trigger_cooldown_minutes'`); (c) recursion depth guard via a transaction-local GUC — trigger-fired enrollments that synchronously cause more trigger fires stop at depth 2.
5. **Filter semantics:** `tag_added` → `config.tag` case-insensitive exact match (empty = any tag); `incoming_sms` → `config.keywords` comma-separated any-substring match against the message body (empty = any inbound SMS); `email_replied` → `config.subject_filter` case-insensitive substring (empty = any reply); `lead_created` → `config.source` exact match on `leads.source` (empty = any).
6. **Triggered runs carry the event:** `fire_journey_triggers` passes the event jsonb as `p_raw_payload` to `enroll_lead_in_journey`, so `journey_runs.raw_payload` holds the triggering message/tag for merge tags and debugging. `journey_runs.trigger_type` records the trigger type.
7. **`form_submitted` is NOT a new trigger** — it is the existing webhook trigger; the builder copy may alias it later. `missed_call`/`field_changed` stay disabled this phase.
8. **Out of scope:** multi-trigger UI, goal events, multi-branch conditions, A/B split, per-run stop-on-response, guarding inline actions with should_dispatch (all Phase 4 candidates).

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260706090000_journey_triggers_registry.sql` | Create: table + spec-sync trigger + backfill |
| `supabase/migrations/20260706091000_enroll_reenrollment_policy.sql` | Create: policy + trigger-source support in enroll RPC |
| `supabase/migrations/20260706092000_fire_journey_triggers.sql` | Create: the firing RPC |
| `supabase/migrations/20260706093000_trigger_firing_points.sql` | Create: leads DB triggers + inbound processor wiring |
| `dashboard/src/app/journeys/builder/page.jsx` | Modify: enable the four trigger options |
| `dashboard/src/lib/journeyValidation.js` | Modify: accept the four trigger types |
| `dashboard/tests/journey-validation.test.mjs` | Modify: trigger acceptance tests |
| `docs/decisions/004-trigger-system.md` | Create: decision record |

---

### Task 0: Preflight — deployed-vs-repo diff (mandatory)

- [ ] **Step 1:** For each function this plan replaces — `enroll_lead_in_journey`, `process_inbound_sms`, `process_inbound_email` — fetch `pg_get_functiondef` from dev and diff against the newest repo migration defining it. Any mismatch = reconcile the repo first (sync migration) before proceeding.

- [ ] **Step 2:** List existing triggers on `leads` (`select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='leads' and not tgisinternal;`) — Task 4's new triggers must not collide with or duplicate existing ones (`trg_leads_updated_at`, phone canonicalization, etc.). Record the list.

- [ ] **Step 3:** Confirm `journeys` has an update trigger slot free (same query for `journeys`) and record `journeys.spec` trigger-related keys in use: `select distinct spec->>'trigger_type' from journeys;`.

---

### Task 1: `journey_triggers` registry, spec-sync, backfill

**Files:**
- Create: `supabase/migrations/20260706090000_journey_triggers_registry.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 3: indexed trigger subscriptions, synced from journeys.spec.
-- The spec remains the source of truth; this table exists so event-time
-- lookups are O(index) instead of scanning every journey's jsonb.

create table if not exists public.journey_triggers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  journey_key text not null,
  trigger_type text not null,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journey_id, trigger_type)
);

create index if not exists journey_triggers_lookup_idx
  on public.journey_triggers (tenant_id, trigger_type)
  where enabled;

create trigger trg_journey_triggers_updated_at
  before update on public.journey_triggers
  for each row execute function set_updated_at();

-- Event-driven trigger types the engine fires. lead_enrolled (manual/bulk)
-- and webhook are handled by their own intake paths, not this registry.
create or replace function public.sync_journey_triggers(p_journey_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_journey public.journeys%rowtype;
  v_type text;
  v_config jsonb;
begin
  select * into v_journey from public.journeys where id = p_journey_id;
  if not found then
    delete from public.journey_triggers where journey_id = p_journey_id;
    return;
  end if;

  v_type := v_journey.spec ->> 'trigger_type';
  v_config := coalesce(v_journey.spec -> 'trigger_config', '{}'::jsonb);

  if v_journey.active
     and v_type in ('tag_added', 'incoming_sms', 'email_replied', 'lead_created') then
    insert into public.journey_triggers (tenant_id, journey_id, journey_key, trigger_type, config, enabled)
    values (v_journey.tenant_id, v_journey.id, v_journey.journey_key, v_type, v_config, true)
    on conflict (journey_id, trigger_type)
    do update set config = excluded.config,
                  journey_key = excluded.journey_key,
                  enabled = true;
    -- one trigger per journey this phase: drop rows of other types
    delete from public.journey_triggers
     where journey_id = p_journey_id and trigger_type <> v_type;
  else
    -- journey inactive, deleted trigger, or non-event trigger type
    delete from public.journey_triggers where journey_id = p_journey_id;
  end if;
end;
$$;

create or replace function public.on_journey_saved_sync_triggers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.sync_journey_triggers(new.id);
  return new;
end;
$$;

drop trigger if exists trg_journeys_sync_triggers on public.journeys;
create trigger trg_journeys_sync_triggers
  after insert or update of spec, active on public.journeys
  for each row execute function public.on_journey_saved_sync_triggers();

-- Backfill from existing specs.
do $do$
declare j record;
begin
  for j in select id from public.journeys loop
    perform public.sync_journey_triggers(j.id);
  end loop;
end
$do$;

do $do$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('sync_journey_triggers', 'on_journey_saved_sync_triggers')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
```

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `journey_triggers_registry`).

- [ ] **Step 3: Verify sync round-trip**

```sql
-- create a synthetic tag-triggered journey; the DB trigger must register it
insert into journeys (tenant_id, journey_key, name, version, active, spec)
select id, 'phase3_verify_tag', 'P3 Tag Trigger', 1, true,
  '{"trigger_type":"tag_added","trigger_config":{"tag":"hot-lead"},"trigger_next_step":0,"steps":[{"index":0,"type":"wait","duration":{"amount":0,"unit":"minutes"},"on_outcome":{"default":{"exit":"completed"}}}]}'::jsonb
from tenants order by created_at limit 1;

select trigger_type, config->>'tag' as tag, enabled
  from journey_triggers where journey_key = 'phase3_verify_tag';
```

Expected: one row, `tag_added` / `hot-lead` / `true`. Then deactivate the journey (`update journeys set active=false where journey_key='phase3_verify_tag';`) and confirm the row disappears; reactivate for later tasks (`set active=true`) and confirm it returns.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260706090000_journey_triggers_registry.sql
git commit -m "feat(engine): journey_triggers registry synced from journey specs"
```

---

### Task 2: Re-enrollment policy in `enroll_lead_in_journey`

**Files:**
- Create: `supabase/migrations/20260706091000_enroll_reenrollment_policy.sql`

- [ ] **Step 1: Write the migration.** Full replacement of `enroll_lead_in_journey(uuid, uuid, text, text, jsonb)` — base = Task 0's reconciled body (originally `20260704091000`) with one insertion, immediately after the step-0 lookup succeeds and before the `journey_runs` insert:

```sql
  -- PHASE3: per-journey re-enrollment policy. 'allow' (default) = re-entry
  -- after a previous run exits (the one-running-run index still blocks
  -- concurrent duplicates). 'once_ever' = one run per lead per journey, ever.
  if coalesce(v_journey.spec ->> 'reenrollment', 'allow') = 'once_ever' then
    if exists (
      select 1 from public.journey_runs
       where tenant_id = p_tenant_id
         and lead_id = p_lead_id
         and journey_id = v_journey.id
    ) then
      return jsonb_build_object('status', 'blocked_once_ever');
    end if;
  end if;
```

Same signature, grants block, no other changes.

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `enroll_reenrollment_policy`).

- [ ] **Step 3: Verify:** temp lead + `phase3_verify_tag` journey (set `spec.reenrollment = 'once_ever'` via `update journeys set spec = spec || '{"reenrollment":"once_ever"}'`): enroll → `enrolled`; let it complete (flush dispatcher); enroll again → `blocked_once_ever`. Reset `reenrollment` to `allow`, enroll again → `enrolled`. Clean up the lead + runs (keep the journey).

- [ ] **Step 4: Update the bulk-enroll route mapping** — `dashboard/src/app/api/leads/bulk-enroll/route.js` treats the new status: add to the status handling chain:

```js
        } else if (enroll?.status === "blocked_once_ever") {
          results.push({ ...planned, status: BULK_ENROLL_STATUSES.SKIPPED_ALREADY_ACTIVE, reason: "Journey allows one enrollment per lead, ever." });
```

Run `cd dashboard && npm test` (green), then commit:

```bash
git add supabase/migrations/20260706091000_enroll_reenrollment_policy.sql dashboard/src/app/api/leads/bulk-enroll/route.js
git commit -m "feat(engine): per-journey re-enrollment policy (allow / once_ever)"
```

---

### Task 3: `fire_journey_triggers` RPC

**Files:**
- Create: `supabase/migrations/20260706092000_fire_journey_triggers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 3: single firing point for event-driven journey triggers.
-- Called by DB triggers on leads (lead_created, tag_added) and explicitly
-- by the inbound processors (incoming_sms, email_replied).
--
-- Loop protection:
--   1. one-running-run unique index (Phase 1) blocks concurrent duplicates
--   2. cooldown: no re-enroll into the same journey within N minutes of a
--      previous run created by the same trigger type (default 60, per-journey
--      override spec->>'trigger_cooldown_minutes')
--   3. depth guard: transaction-local GUC app.trigger_depth stops synchronous
--      trigger cascades at depth 2 (tag journey adds a tag -> fires again).

create or replace function public.fire_journey_triggers(
  p_tenant_id uuid,
  p_lead_id uuid,
  p_trigger_type text,
  p_event jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_trigger record;
  v_journey public.journeys%rowtype;
  v_depth integer;
  v_cooldown_minutes integer;
  v_enroll jsonb;
  v_fired jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_match boolean;
  v_tag text;
  v_keywords text;
  v_kw text;
  v_body text;
  v_subject_filter text;
  v_source_filter text;
begin
  if p_tenant_id is null or p_lead_id is null then
    return jsonb_build_object('fired', v_fired, 'skipped', v_skipped, 'reason', 'missing_ids');
  end if;

  v_depth := coalesce(nullif(current_setting('app.trigger_depth', true), ''), '0')::integer;
  if v_depth >= 2 then
    return jsonb_build_object('fired', v_fired, 'skipped', v_skipped, 'reason', 'depth_limit');
  end if;
  perform set_config('app.trigger_depth', (v_depth + 1)::text, true);

  for v_trigger in
    select * from public.journey_triggers
     where tenant_id = p_tenant_id
       and trigger_type = p_trigger_type
       and enabled
  loop
    -- filter evaluation per type
    v_match := true;
    if p_trigger_type = 'tag_added' then
      v_tag := nullif(trim(coalesce(v_trigger.config ->> 'tag', '')), '');
      if v_tag is not null then
        v_match := lower(coalesce(p_event ->> 'tag', '')) = lower(v_tag);
      end if;
    elsif p_trigger_type = 'incoming_sms' then
      v_keywords := nullif(trim(coalesce(v_trigger.config ->> 'keywords', '')), '');
      v_body := lower(coalesce(p_event ->> 'body', ''));
      if v_keywords is not null then
        v_match := false;
        foreach v_kw in array string_to_array(lower(v_keywords), ',') loop
          if nullif(trim(v_kw), '') is not null and position(trim(v_kw) in v_body) > 0 then
            v_match := true;
            exit;
          end if;
        end loop;
      end if;
    elsif p_trigger_type = 'email_replied' then
      v_subject_filter := nullif(trim(coalesce(v_trigger.config ->> 'subject_filter', '')), '');
      if v_subject_filter is not null then
        v_match := position(lower(v_subject_filter) in lower(coalesce(p_event ->> 'subject', ''))) > 0;
      end if;
    elsif p_trigger_type = 'lead_created' then
      v_source_filter := nullif(trim(coalesce(v_trigger.config ->> 'source', '')), '');
      if v_source_filter is not null then
        v_match := lower(coalesce(p_event ->> 'source', '')) = lower(v_source_filter);
      end if;
    end if;

    if not v_match then
      v_skipped := v_skipped || jsonb_build_object('journey_key', v_trigger.journey_key, 'reason', 'filter_no_match');
      continue;
    end if;

    -- cooldown
    select * into v_journey from public.journeys where id = v_trigger.journey_id;
    v_cooldown_minutes := coalesce(nullif(v_journey.spec ->> 'trigger_cooldown_minutes', '')::integer, 60);
    if exists (
      select 1 from public.journey_runs
       where tenant_id = p_tenant_id
         and lead_id = p_lead_id
         and journey_id = v_trigger.journey_id
         and trigger_type = p_trigger_type
         and created_at > now() - make_interval(mins => v_cooldown_minutes)
    ) then
      v_skipped := v_skipped || jsonb_build_object('journey_key', v_trigger.journey_key, 'reason', 'cooldown');
      continue;
    end if;

    begin
      v_enroll := public.enroll_lead_in_journey(
        p_tenant_id, p_lead_id, v_trigger.journey_key, p_trigger_type, coalesce(p_event, '{}'::jsonb)
      );
    exception when others then
      v_enroll := jsonb_build_object('status', 'error', 'error', sqlerrm);
      insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
      values (p_tenant_id, 'fire_journey_triggers',
              'Trigger enrollment failed: ' || sqlerrm,
              jsonb_build_object('lead_id', p_lead_id, 'journey_key', v_trigger.journey_key, 'trigger_type', p_trigger_type),
              'error', 'open');
    end;

    if coalesce(v_enroll ->> 'status', '') = 'enrolled' then
      v_fired := v_fired || jsonb_build_object('journey_key', v_trigger.journey_key, 'run_id', v_enroll ->> 'run_id');
    else
      v_skipped := v_skipped || jsonb_build_object('journey_key', v_trigger.journey_key, 'reason', coalesce(v_enroll ->> 'status', 'unknown'));
    end if;
  end loop;

  return jsonb_build_object('fired', v_fired, 'skipped', v_skipped);
end;
$$;

revoke execute on function public.fire_journey_triggers(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.fire_journey_triggers(uuid, uuid, text, jsonb)
  to service_role;
```

- [ ] **Step 2: Apply to dev** (`apply_migration`, name `fire_journey_triggers`).

- [ ] **Step 3: Verify directly** with a temp lead: `select fire_journey_triggers('<tenant>', '<lead>', 'tag_added', '{"tag":"hot-lead"}'::jsonb);` → `fired` contains `phase3_verify_tag` with a run_id; run completes on next flush. Repeat immediately → `skipped` with `cooldown` (the run is completed so the unique index no longer blocks — this specifically proves the cooldown layer). Fire with `'{"tag":"cold"}'` → `skipped` with `filter_no_match`. Clean up runs + lead.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260706092000_fire_journey_triggers.sql
git commit -m "feat(engine): fire_journey_triggers RPC with filters, cooldown, depth guard"
```

---

### Task 4: Firing points

**Files:**
- Create: `supabase/migrations/20260706093000_trigger_firing_points.sql`

- [ ] **Step 1: leads DB triggers** (new functions — full code):

```sql
-- lead_created: fires for every creation path (manual, CSV import, webhook,
-- create_lead_from_payload) via one AFTER INSERT trigger.
create or replace function public.on_lead_created_fire_triggers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  begin
    perform public.fire_journey_triggers(
      new.tenant_id, new.id, 'lead_created',
      jsonb_build_object('source', coalesce(new.source, ''), 'lead_id', new.id)
    );
  exception when others then
    insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (new.tenant_id, 'trigger:lead_created', sqlerrm,
            jsonb_build_object('lead_id', new.id), 'error', 'open');
  end;
  return new;
end;
$$;

drop trigger if exists trg_leads_fire_created_triggers on public.leads;
create trigger trg_leads_fire_created_triggers
  after insert on public.leads
  for each row execute function public.on_lead_created_fire_triggers();

-- tag_added: diff old/new custom_fields->'tags' on update; fire once per
-- newly-added tag. Catches process_action_tag, dashboard PATCH, imports.
create or replace function public.on_lead_tags_changed_fire_triggers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old_tags jsonb := coalesce(old.custom_fields -> 'tags', '[]'::jsonb);
  v_new_tags jsonb := coalesce(new.custom_fields -> 'tags', '[]'::jsonb);
  v_tag text;
begin
  if v_new_tags = v_old_tags then
    return new;
  end if;
  for v_tag in
    select t from jsonb_array_elements_text(v_new_tags) t
    except
    select t from jsonb_array_elements_text(v_old_tags) t
  loop
    begin
      perform public.fire_journey_triggers(
        new.tenant_id, new.id, 'tag_added',
        jsonb_build_object('tag', v_tag, 'lead_id', new.id)
      );
    exception when others then
      insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
      values (new.tenant_id, 'trigger:tag_added', sqlerrm,
              jsonb_build_object('lead_id', new.id, 'tag', v_tag), 'error', 'open');
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_leads_fire_tag_triggers on public.leads;
create trigger trg_leads_fire_tag_triggers
  after update of custom_fields on public.leads
  for each row execute function public.on_lead_tags_changed_fire_triggers();
```

Grants block for both functions.

- [ ] **Step 2: inbound processors.** Full replacement of `process_inbound_sms` and `process_inbound_email` — bases = Task 0's reconciled deployed bodies, each with ONE insertion. Placement rule (identical for both): **after** the lead is resolved and the inbound event row is inserted, **after** the STOP/unsubscribe opt-out branch (an opt-out must never trigger an enrollment), and **before** the AI-reply enqueue. Insertions:

In `process_inbound_sms`:

```sql
  -- PHASE3: event-driven triggers (keyword journeys, reactivation on reply).
  begin
    perform public.fire_journey_triggers(
      v_tenant_id, v_lead.id, 'incoming_sms',
      jsonb_build_object('body', p_body, 'from', p_from, 'event_id', v_event_id)
    );
  exception when others then
    insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (v_tenant_id, 'trigger:incoming_sms', sqlerrm,
            jsonb_build_object('lead_id', v_lead.id), 'error', 'open');
  end;
```

In `process_inbound_email` (variable names per the reconciled body — adjust `v_lead`/`v_event_id` identifiers to match it exactly):

```sql
  -- PHASE3: event-driven triggers.
  begin
    perform public.fire_journey_triggers(
      v_lead.tenant_id, v_lead.id, 'email_replied',
      jsonb_build_object('subject', p_subject, 'body', p_body, 'from', p_from_email, 'event_id', v_event_id)
    );
  exception when others then
    insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    values (v_lead.tenant_id, 'trigger:email_replied', sqlerrm,
            jsonb_build_object('lead_id', v_lead.id), 'error', 'open');
  end;
```

Grants blocks for both. Same signatures — no overloads.

- [ ] **Step 3: Apply to dev** (`apply_migration`, name `trigger_firing_points`).

- [ ] **Step 4: Verify each firing point** (synthetic; no provider sends — `phase3_verify_tag` is wait→exit):
  1. `lead_created`: create a `phase3_verify_lead_created` journey (spec trigger_type `lead_created`, config `{"source":"p3-test"}`, wait→exit steps). Insert a lead with `source='p3-test'` → a run appears with `trigger_type='lead_created'`. Insert a lead with `source='other'` → no run.
  2. `tag_added`: `update leads set custom_fields = jsonb_set(coalesce(custom_fields,'{}'::jsonb), '{tags}', '["hot-lead"]'::jsonb) where id='<test lead>'` → run for `phase3_verify_tag`. Adding an unrelated tag → no new run.
  3. `incoming_sms`/`email_replied`: call the processors directly with a test lead's phone/email (verify the tenant's `resolve_tenant_by_phone` mapping first; use a `phase3_verify_sms` journey with `keywords: "start"` and body "START now") → run created; body without keyword → skipped. **Caution:** these processors enqueue AI replies when enabled — verify `tenants.ai_replies_enabled=false` on the test tenant first, or use a lead with `email_conversation_count` at max.
  4. Loop protection: give `phase3_verify_tag` an `add_tag` step that adds `hot-lead` itself (wait→add_tag→exit); add the tag externally once, flush the dispatcher until the run completes → exactly ONE run exists (`select count(*) from journey_runs where journey_key='phase3_verify_tag' and lead_id='<lead>'` = 1). The self-added tag's re-fire is blocked by the one-running-run index while the run is live (`skipped: already_active`) and by the cooldown after it exits — re-add the tag externally after completion and confirm `skipped: cooldown` with the count still 1.
  
  Clean up ALL `phase3_verify*` journeys, `journey_triggers` rows (cascade via journey delete), runs, actions, and `*.invalid` leads.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260706093000_trigger_firing_points.sql
git commit -m "feat(engine): trigger firing points — lead triggers + inbound processors"
```

---

### Task 5: Builder + validation enablement (TDD)

**Files:**
- Modify: `dashboard/src/lib/journeyValidation.js`
- Modify: `dashboard/tests/journey-validation.test.mjs`
- Modify: `dashboard/src/app/journeys/builder/page.jsx`

- [ ] **Step 1: Failing tests** (append to `journey-validation.test.mjs`):

```js
test("event-driven trigger types are accepted", () => {
  for (const triggerType of ["tag_added", "incoming_sms", "email_replied", "lead_created"]) {
    const result = validateJourneySpec({
      trigger_type: triggerType,
      steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }],
      triggerNextStep: 0,
    });
    assert.ok(!result.checks.some((check) => check.title === "Trigger is not available yet."), `${triggerType} should be accepted`);
  }
});

test("unknown trigger types are still blocked", () => {
  const result = validateJourneySpec({
    trigger_type: "missed_call",
    steps: [{ index: 0, type: "wait", duration: { amount: 1, unit: "minutes" }, on_outcome: { default: { exit: "completed" } } }],
    triggerNextStep: 0,
  });
  assert.equal(result.status, "invalid");
});
```

- [ ] **Step 2:** `cd dashboard && npm test` — first new test FAILS (four types currently rejected).

- [ ] **Step 3:** In `journeyValidation.js`:

```js
const SUPPORTED_TRIGGER_TYPES = new Set(["lead_enrolled", "webhook", "tag_added", "incoming_sms", "email_replied", "lead_created"]);
```

Note: the existing pre-Phase-3 test `"validateJourneySpec blocks unsupported trigger types"` uses `tag_added` as its unsupported example — change its fixture to `missed_call`.

- [ ] **Step 4:** In `builder/page.jsx`: in the trigger options list (around line 55-63), remove `disabled: true, description: "Coming soon"` from `tag_added` and enable `incoming_sms`, `email_replied`, `lead_created` entries (add them if the list uses different names — reconcile with the config panels that already exist for `tag_added`/`incoming_sms`/`email_replied` around lines 4188-4226; add a minimal `lead_created` config panel with a `source` filter input following the `tag_added` panel's pattern). Keep `field_changed`/`missed_call` disabled.

- [ ] **Step 5:** `npm test` green + `npx eslint src/app/journeys/builder/page.jsx src/lib/journeyValidation.js` no new errors. Manual check: `cd dashboard && npm run dev`, open the builder, pick "Tag added", set a tag, save, and confirm via SQL that `journey_triggers` got the row (the Task 1 DB trigger fires on the API's spec update).

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/journeyValidation.js dashboard/tests/journey-validation.test.mjs dashboard/src/app/journeys/builder/page.jsx
git commit -m "feat(builder): tag_added / incoming_sms / email_replied / lead_created triggers go live"
```

---

### Task 6: Decision record + close-out

**Files:**
- Create: `docs/decisions/004-trigger-system.md`

- [ ] **Step 1:** Full JS suite + a 15-minute error_logs watch after the last migration: zero `severity='error'` rows.

- [ ] **Step 2:** Confirm zero `phase3_verify*` / `*.invalid` rows remain in journeys, journey_triggers, journey_runs, actions, leads.

- [ ] **Step 3:** Write the decision record:

```markdown
# 004 — Event-driven trigger system (Phase 3)

**Date:** (execution date)
**Status:** Accepted

## Decision
journey_triggers is the indexed registry, synced from journeys.spec by a DB
trigger on save. fire_journey_triggers evaluates per-type filters and enrolls
through enroll_lead_in_journey. Firing points: DB triggers on leads
(lead_created, tag_added), explicit calls in process_inbound_sms/email
(incoming_sms, email_replied). Loop protection: one-running-run index +
same-trigger cooldown (default 60m) + depth guard (2).

## Re-enrollment policy
spec.reenrollment: 'allow' (default) | 'once_ever', enforced in
enroll_lead_in_journey for every enrollment path.

## Deferred
- Multiple triggers per journey (table supports it; builder is single-trigger)
- field_changed / missed_call triggers
- form_submitted alias for webhook
- Goal events, multi-branch conditions, A/B split (Phase 4)
```

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/004-trigger-system.md
git commit -m "docs: trigger system decision record"
```

---

## Post-Plan Checklist

- [ ] `cd dashboard && npm test` fully green
- [ ] Security advisors: no ERROR-level findings; all new functions have grants blocks
- [ ] `error_logs` clean over 24h
- [ ] All test data deleted from dev
- [ ] **Phase 2 Task 8 (decommission) executed once its 24h drain gate passed** — it is independent of this plan but must not be forgotten
- [ ] Memory/PRD updated: trigger system live

## Known Risks

1. **DB triggers on `leads` fire on every insert/update** — the functions exit fast when no `journey_triggers` rows match (indexed lookup), but bulk CSV imports of N leads now do N indexed lookups; at the current scale (<100k leads) this is negligible. If import throughput ever matters, batch-disable via `set_config('app.trigger_depth','2',true)` around the import transaction.
2. **Synchronous enrollment inside inbound processing** — a trigger-fired enrollment runs inside `process_inbound_sms/email`. Enrollment is one insert + one indexed check (fast), and failures are caught per-trigger into `error_logs`, never failing the inbound message itself.
3. **`incoming_sms` triggers on any lead reply**, including replies to active outreach — cross-channel engagement-cancel fires first (it runs earlier in the processor), so the lead's pending outbound gets cancelled while the trigger may enroll them in a response journey. That combination is usually desired (reactivation flows); if a tenant wants reply-triggered journeys ONLY for dormant leads, they add a conditional split on `journey_status` as step 0 — document in /docs.
4. **Cooldown is per (lead, journey, trigger_type)** — two DIFFERENT tag-triggered journeys on the same tag both fire; that is intended fan-out, not a loop.
