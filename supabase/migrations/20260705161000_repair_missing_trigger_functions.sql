-- Launch repair 6/n: trigger functions + triggers missing on prod because the
-- 20260626 backfill no-op'd (see repair 5). Bodies verbatim from dev.
-- Restores: retry/backoff on failed actions, phone canonicalization, journey
-- exit cancellation, per-enrollment flag reset, audit logging.
--
-- Applied to follow-up-prod via Supabase MCP on 2026-07-05.

CREATE OR REPLACE FUNCTION public.audit_row_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor  uuid;
  v_email  text;
  v_tenant uuid;
  v_before jsonb;
  v_after  jsonb;
  v_row_id text;
  v_changed text[];
begin
  begin
    v_actor := nullif(current_setting('app.current_actor', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;
  if v_actor is not null then
    select email into v_email from auth.users where id = v_actor;
  end if;

  if TG_OP = 'INSERT' then
    v_before := null;
    v_after  := to_jsonb(NEW);
    v_tenant := (v_after->>'tenant_id')::uuid;
    v_row_id := v_after->>'id';
  elsif TG_OP = 'UPDATE' then
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_tenant := coalesce((v_after->>'tenant_id')::uuid, (v_before->>'tenant_id')::uuid);
    v_row_id := coalesce(v_after->>'id', v_before->>'id');
    select array_agg(key) into v_changed
      from jsonb_each(v_before) b
     where v_after->b.key is distinct from b.value;
  else
    v_before := to_jsonb(OLD);
    v_after  := null;
    v_tenant := (v_before->>'tenant_id')::uuid;
    v_row_id := v_before->>'id';
  end if;

  insert into audit_log (tenant_id, actor_id, actor_email, table_name, row_id, op, before, after, changed_keys)
       values (v_tenant, v_actor, v_email, TG_TABLE_NAME, v_row_id, TG_OP, v_before, v_after, v_changed);

  return coalesce(NEW, OLD);
end;
$function$;

CREATE OR REPLACE FUNCTION public.leads_canonicalize_phone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_country text := 'US';
begin
  -- Pull the tenant's preferred country if configured; default US.
  if NEW.tenant_id is not null then
    select coalesce(t.config->>'default_country', 'US')
      into v_country
      from tenants t
     where t.id = NEW.tenant_id;
  end if;

  -- Skip if already canonical: + followed by 10-15 digits.
  if NEW.phone_e164 is not null and NEW.phone_e164 ~ '^\+[0-9]{10,15}$' then
    return NEW;
  end if;

  NEW.phone_e164 := normalize_phone(coalesce(NEW.phone_e164, NEW.phone_raw), v_country);
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.on_action_marked_failed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
begin
  -- Only react when an in-flight or queued action transitions to 'failed'.
  if OLD.status in ('in_progress','pending') and NEW.status = 'failed' then
    -- Route through mark_action_failed in a separate statement; we shouldn't
    -- recurse via the trigger because mark_action_failed sets status to either
    -- 'pending' (retry) or 'failed_permanent' (terminal), neither of which
    -- matches the OLD/NEW pattern above.
    v_result := mark_action_failed(NEW.id, NEW.error_message);
    -- Suppress the original update — the function already wrote the right state.
    return null;
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.on_lead_journey_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.journey_status in ('completed','opted_out','error','callback_booked','responded')
     and OLD.journey_status is distinct from NEW.journey_status then
    update actions
       set status        = 'cancelled',
           error_message = coalesce(error_message,
             'journey_exited:' || NEW.journey_status),
           locked_until  = null,
           locked_by     = null
     where lead_id = NEW.id
       and status = 'pending';
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reset_per_enrollment_flags_on_journey_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.journey_template is distinct from old.journey_template
     and new.journey_template is not null then
    new.responded            := false;
    new.callback_requested   := false;
    new.callback_at          := null;
    -- Clear the wait-engine's per-enrollment escape hatch too.
    if new.custom_fields ? '_skip_outbound_until_wait' then
      new.custom_fields := new.custom_fields - '_skip_outbound_until_wait';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists ai_agents_set_updated_at on public.ai_agents;
CREATE TRIGGER ai_agents_set_updated_at BEFORE UPDATE ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
drop trigger if exists trg_action_failed_retry on public.actions;
CREATE TRIGGER trg_action_failed_retry BEFORE UPDATE ON public.actions FOR EACH ROW EXECUTE FUNCTION on_action_marked_failed();
drop trigger if exists trg_audit_journeys on public.journeys;
CREATE TRIGGER trg_audit_journeys AFTER INSERT OR DELETE OR UPDATE ON public.journeys FOR EACH ROW EXECUTE FUNCTION audit_row_change();
drop trigger if exists trg_audit_senders on public.senders;
CREATE TRIGGER trg_audit_senders AFTER INSERT OR DELETE OR UPDATE ON public.senders FOR EACH ROW EXECUTE FUNCTION audit_row_change();
drop trigger if exists trg_audit_suppressions on public.suppressions;
CREATE TRIGGER trg_audit_suppressions AFTER INSERT OR DELETE OR UPDATE ON public.suppressions FOR EACH ROW EXECUTE FUNCTION audit_row_change();
drop trigger if exists trg_audit_templates on public.templates;
CREATE TRIGGER trg_audit_templates AFTER INSERT OR DELETE OR UPDATE ON public.templates FOR EACH ROW EXECUTE FUNCTION audit_row_change();
drop trigger if exists trg_audit_tenant_credentials on public.tenant_credentials;
CREATE TRIGGER trg_audit_tenant_credentials AFTER INSERT OR DELETE OR UPDATE ON public.tenant_credentials FOR EACH ROW EXECUTE FUNCTION audit_row_change();
drop trigger if exists trg_audit_tenant_members on public.tenant_members;
CREATE TRIGGER trg_audit_tenant_members AFTER INSERT OR DELETE OR UPDATE ON public.tenant_members FOR EACH ROW EXECUTE FUNCTION audit_row_change();
drop trigger if exists trg_audit_tenants on public.tenants;
CREATE TRIGGER trg_audit_tenants AFTER INSERT OR DELETE OR UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION audit_row_change();
drop trigger if exists trg_lead_journey_exit on public.leads;
CREATE TRIGGER trg_lead_journey_exit AFTER UPDATE OF journey_status ON public.leads FOR EACH ROW EXECUTE FUNCTION on_lead_journey_exit();
drop trigger if exists trg_leads_canonicalize_phone on public.leads;
CREATE TRIGGER trg_leads_canonicalize_phone BEFORE INSERT OR UPDATE OF phone_raw, phone_e164 ON public.leads FOR EACH ROW EXECUTE FUNCTION leads_canonicalize_phone();
drop trigger if exists trg_leads_reset_flags_on_journey_change on public.leads;
CREATE TRIGGER trg_leads_reset_flags_on_journey_change BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION reset_per_enrollment_flags_on_journey_change();

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('audit_row_change','leads_canonicalize_phone','on_action_marked_failed',
                         'on_lead_journey_exit','reset_per_enrollment_flags_on_journey_change')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$do$;
