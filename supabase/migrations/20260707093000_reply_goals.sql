-- Phase 4: replied goals for running journey runs.
-- Inbound processors capture running run ids before engagement cancel, let the
-- existing blanket cancel run, then this helper either records an exit goal or
-- reactivates the run and enqueues the configured goto step.

create or replace function public.apply_journey_goals(
  p_lead_id uuid,
  p_run_ids uuid[],
  p_event_type text,
  p_event jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run public.journey_runs%rowtype;
  v_journey public.journeys%rowtype;
  v_goal jsonb;
  v_goal_id text;
  v_goto integer;
  v_step jsonb;
  v_action_id uuid;
  v_applied jsonb := '[]'::jsonb;
  v_event_id text;
begin
  if p_run_ids is null or array_length(p_run_ids, 1) is null then
    return jsonb_build_object('applied', v_applied);
  end if;

  v_event_id := coalesce(p_event ->> 'event_id', md5(coalesce(p_event::text, '{}')));

  for v_run in
    select *
      from public.journey_runs
     where id = any(p_run_ids)
       and lead_id = p_lead_id
     for update
  loop
    v_journey := null;
    v_goal := null;
    v_step := null;
    v_action_id := null;

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

    if v_journey.id is null then
      continue;
    end if;

    select g into v_goal
      from jsonb_array_elements(coalesce(v_journey.spec -> 'goals', '[]'::jsonb)) g
     where g ->> 'event' = p_event_type
     limit 1;

    if v_goal is null then
      continue;
    end if;

    v_goal_id := coalesce(nullif(v_goal ->> 'id', ''), p_event_type);

    if coalesce(v_goal ->> 'action', 'exit') = 'goto' then
      v_goto := nullif(v_goal ->> 'goto_step', '')::integer;
      select s into v_step
        from jsonb_array_elements(coalesce(v_journey.spec -> 'steps', '[]'::jsonb)) s
       where (s ->> 'index')::integer = v_goto
       limit 1;

      if v_step is null then
        v_applied := v_applied || jsonb_build_array(jsonb_build_object(
          'run_id', v_run.id,
          'goal_id', v_goal_id,
          'action', 'goto',
          'status', 'step_not_found'
        ));
        continue;
      end if;

      update public.journey_runs
         set status = 'running',
             responded = true,
             current_step = v_goto,
             next_action_at = now(),
             completed_at = null,
             failed_at = null,
             last_error = null,
             updated_at = now()
       where id = v_run.id;

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
        v_run.tenant_id,
        p_lead_id,
        v_step ->> 'type',
        v_goto,
        v_step ->> 'template_key',
        now(),
        'pending',
        'goal:' || v_run.id::text || ':' || v_goal_id || ':' || p_event_type || ':' || v_event_id,
        jsonb_build_object(
          'goal_id', v_goal_id,
          'goal_event', p_event_type,
          'goal_source', p_event,
          'step_spec', v_step,
          'continued_from_run_id', v_run.id
        ),
        v_run.id
      )
      on conflict (tenant_id, idempotency_key) do nothing
      returning id into v_action_id;

      v_applied := v_applied || jsonb_build_array(jsonb_build_object(
        'run_id', v_run.id,
        'goal_id', v_goal_id,
        'action', 'goto',
        'goto_step', v_goto,
        'action_id', v_action_id
      ));
    else
      update public.journey_runs
         set status = 'responded',
             responded = true,
             completed_at = coalesce(completed_at, now()),
             last_error = null,
             updated_at = now()
       where id = v_run.id;

      v_applied := v_applied || jsonb_build_array(jsonb_build_object(
        'run_id', v_run.id,
        'goal_id', v_goal_id,
        'action', 'exit'
      ));
    end if;
  end loop;

  return jsonb_build_object('applied', v_applied);
end;
$$;

revoke execute on function public.apply_journey_goals(uuid, uuid[], text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_journey_goals(uuid, uuid[], text, jsonb)
  to service_role;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.process_inbound_sms(text,text,text,text)'::regprocedure)
    into v_sql;

  if v_sql is null then
    raise exception 'process_inbound_sms(text,text,text,text) not found';
  end if;

  if position('v_goal_run_ids uuid[]' in v_sql) = 0 then
    v_sql := replace(
      v_sql,
      '  v_ai_action_id uuid;
begin',
      '  v_ai_action_id uuid;
  v_goal_run_ids uuid[];
begin'
    );
    v_sql := replace(
      v_sql,
      '  if not v_is_opt_out then
    perform cancel_pending_on_engagement(v_lead.id, ''sms_reply'',
      ''Inbound SMS from '' || p_from, null);
  end if;',
      '  if not v_is_opt_out then
    select array_agg(id) into v_goal_run_ids
      from public.journey_runs
     where lead_id = v_lead.id
       and status = ''running'';

    perform cancel_pending_on_engagement(v_lead.id, ''sms_reply'',
      ''Inbound SMS from '' || p_from, null);

    perform public.apply_journey_goals(
      v_lead.id,
      v_goal_run_ids,
      ''replied'',
      jsonb_build_object(
        ''channel'', ''sms'',
        ''event_id'', v_event_id,
        ''provider_id'', p_message_sid
      )
    );
  end if;'
    );
    execute v_sql;
  end if;
end;
$$;

revoke execute on function public.process_inbound_sms(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.process_inbound_sms(text, text, text, text)
  to service_role;

do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.process_inbound_email(text,text,text,text,text,text)'::regprocedure)
    into v_sql;

  if v_sql is null then
    raise exception 'process_inbound_email(text,text,text,text,text,text) not found';
  end if;

  if position('v_goal_run_ids uuid[]' in v_sql) = 0 then
    v_sql := replace(
      v_sql,
      '  v_ai_action_id uuid;
begin',
      '  v_ai_action_id uuid;
  v_goal_run_ids uuid[];
begin'
    );
    v_sql := replace(
      v_sql,
      '  if not v_is_opt_out then
    perform cancel_pending_on_engagement(v_lead.id, ''email_reply'', ''Inbound email from '' || p_from_email, null);
  end if;',
      '  if not v_is_opt_out then
    select array_agg(id) into v_goal_run_ids
      from public.journey_runs
     where lead_id = v_lead.id
       and status = ''running'';

    perform cancel_pending_on_engagement(v_lead.id, ''email_reply'', ''Inbound email from '' || p_from_email, null);

    perform public.apply_journey_goals(
      v_lead.id,
      v_goal_run_ids,
      ''replied'',
      jsonb_build_object(
        ''channel'', ''email'',
        ''event_id'', v_event_id,
        ''message_id'', p_message_id,
        ''thread_id'', p_thread_id
      )
    );
  end if;'
    );
    execute v_sql;
  end if;
end;
$$;

revoke execute on function public.process_inbound_email(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.process_inbound_email(text, text, text, text, text, text)
  to service_role;
