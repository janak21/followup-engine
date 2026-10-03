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