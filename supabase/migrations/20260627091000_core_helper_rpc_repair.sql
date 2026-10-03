-- Core helper RPC repair for fresh migration replay.
-- Defines suppression, throttled-action reschedule, and retry/backoff helpers.

create or replace function public.add_suppression(
  p_tenant_id uuid,
  p_channel text,
  p_identifier text,
  p_reason text default 'manual',
  p_lead_id uuid default null,
  p_source text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_channel text := nullif(lower(trim(coalesce(p_channel, ''))), '');
  v_identifier text := nullif(trim(coalesce(p_identifier, '')), '');
  v_email text;
  v_phone text;
  v_existing_id uuid;
  v_new_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'p_tenant_id is required';
  end if;
  if v_identifier is null then
    raise exception 'p_identifier is required';
  end if;

  if v_channel is null then
    v_channel := case when position('@' in v_identifier) > 0 then 'email' else 'sms' end;
  end if;

  if v_channel = 'email' then
    v_email := lower(v_identifier);
  elsif v_channel in ('sms', 'call', 'phone') then
    v_channel := case when v_channel = 'phone' then 'sms' else v_channel end;
    v_phone := v_identifier;
  else
    v_email := case when position('@' in v_identifier) > 0 then lower(v_identifier) else null end;
    v_phone := case when v_email is null then v_identifier else null end;
  end if;

  select id
    into v_existing_id
    from public.suppressions
   where tenant_id = p_tenant_id
     and coalesce(channel, '') = coalesce(v_channel, '')
     and coalesce(reason, '') = coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'manual')
     and (
       (v_email is not null and lower(coalesce(email, '')) = v_email)
       or (v_phone is not null and phone_e164 = v_phone)
     )
   order by created_at asc
   limit 1;

  if v_existing_id is not null then
    update public.suppressions
       set source = coalesce(public.suppressions.source, p_source),
           lead_id = coalesce(public.suppressions.lead_id, p_lead_id),
           notes = coalesce(public.suppressions.notes, p_notes)
     where id = v_existing_id;
    return v_existing_id;
  end if;

  insert into public.suppressions (
    tenant_id, channel, email, phone_e164, reason, source, lead_id, notes
  ) values (
    p_tenant_id,
    v_channel,
    v_email,
    v_phone,
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'manual'),
    p_source,
    p_lead_id,
    p_notes
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

create or replace function public.reschedule_action(
  p_action_id uuid,
  p_run_at timestamptz,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.actions%rowtype;
begin
  if p_action_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_run_at is null then
    raise exception 'p_run_at is required';
  end if;

  update public.actions
     set status = 'pending',
         run_at = p_run_at,
         next_retry_at = null,
         locked_until = null,
         locked_by = null,
         error_message = left(coalesce(p_reason, error_message), 2000),
         last_error = left(coalesce(p_reason, last_error), 2000)
   where id = p_action_id
   returning * into v_action;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  return jsonb_build_object(
    'status', 'rescheduled',
    'action_id', v_action.id,
    'run_at', v_action.run_at,
    'retry_count', v_action.retry_count
  );
end;
$$;

create or replace function public.mark_action_failed(
  p_action_id uuid,
  p_error_message text,
  p_max_retries integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.actions%rowtype;
  v_max int;
  v_next timestamptz;
  v_db_only_types text[] := array[
    'wait', 'find_lead', 'create_lead', 'update_lead',
    'conditional_split', 'add_tag', 'remove_tag',
    'http_request', 'wait_reply'
  ];
  v_new_count int;
  v_should_retry boolean;
begin
  select *
    into v_action
    from public.actions
   where id = p_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_action.status in ('completed', 'failed_permanent', 'cancelled') then
    return jsonb_build_object('status', 'already_terminal', 'existing_status', v_action.status);
  end if;

  v_max := greatest(coalesce(p_max_retries, v_action.max_retries, 3), 0);
  v_new_count := coalesce(v_action.retry_count, 0) + 1;
  v_should_retry := (v_action.action_type <> all(v_db_only_types))
                    and v_new_count < v_max;

  if v_should_retry then
    v_next := case v_new_count
      when 1 then now() + interval '1 minute'
      when 2 then now() + interval '5 minutes'
      when 3 then now() + interval '30 minutes'
      else now() + interval '2 hours'
    end;

    update public.actions
       set status = 'pending',
           retry_count = v_new_count,
           next_retry_at = v_next,
           run_at = v_next,
           locked_until = null,
           locked_by = null,
           error_message = left(p_error_message, 2000),
           last_error = left(p_error_message, 2000)
     where id = p_action_id;

    return jsonb_build_object(
      'status', 'rescheduled',
      'retry_count', v_new_count,
      'next_retry_at', v_next
    );
  end if;

  update public.actions
     set status = 'failed_permanent',
         retry_count = v_new_count,
         next_retry_at = null,
         locked_until = null,
         locked_by = null,
         error_message = left(p_error_message, 2000),
         last_error = left(p_error_message, 2000)
   where id = p_action_id;

  insert into public.error_logs (
    tenant_id, workflow_name, error_message, raw_error, severity, status
  ) values (
    v_action.tenant_id,
    'action_failed_permanent',
    coalesce(p_error_message, 'unspecified'),
    jsonb_build_object(
      'action_id', p_action_id,
      'action_type', v_action.action_type,
      'retry_count', v_new_count,
      'max_retries', v_max,
      'step_index', v_action.step_index,
      'lead_id', v_action.lead_id
    ),
    'error',
    'open'
  );

  return jsonb_build_object('status', 'failed_permanent', 'retry_count', v_new_count);
end;
$$;
