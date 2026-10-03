-- Make Add Tag / Remove Tag safe for webhook-triggered automations after
-- Create Lead has attached a lead. The handler now prefers the bridged
-- action payload.step_spec, falls back to the legacy journey step lookup,
-- stores tags in leads.custom_fields.tags, and compares tags case-insensitively.

create or replace function public.process_action_tag(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action public.actions%rowtype;
  v_lead public.leads%rowtype;
  v_journey public.journeys%rowtype;
  v_step jsonb;
  v_tag text;
  v_existing jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb;
  v_op text;
begin
  select * into v_action
    from public.actions
   where id = p_action_id
   for update;

  if not found then
    return jsonb_build_object('status', 'failed', 'reason', 'action_not_found');
  end if;

  if v_action.status = 'completed' then
    return jsonb_build_object('status', 'already_completed');
  end if;

  v_op := case
    when v_action.action_type = 'add_tag' then 'add'
    when v_action.action_type = 'remove_tag' then 'remove'
    else 'noop'
  end;

  if v_op = 'noop' then
    update public.actions
       set status = 'failed',
           error_message = 'process_action_tag called for non-tag action_type ' || v_action.action_type,
           last_error = 'process_action_tag called for non-tag action_type ' || v_action.action_type,
           locked_until = null,
           locked_by = null
     where id = p_action_id;

    return jsonb_build_object('status', 'failed', 'reason', 'wrong_action_type');
  end if;

  select * into v_lead
    from public.leads
   where id = v_action.lead_id
   for update;

  if not found then
    update public.actions
       set status = 'failed',
           error_message = 'lead not found',
           last_error = 'lead not found',
           locked_until = null,
           locked_by = null
     where id = p_action_id;

    return jsonb_build_object('status', 'failed', 'reason', 'lead_not_found');
  end if;

  v_step := v_action.payload -> 'step_spec';

  if v_step is null or v_step = 'null'::jsonb then
    select * into v_journey
      from public.journeys
     where tenant_id = v_action.tenant_id
       and journey_key = v_lead.journey_template
       and active
     order by version desc
     limit 1;

    if v_journey.id is not null then
      select s into v_step
        from jsonb_array_elements(coalesce(v_journey.spec -> 'steps', '[]'::jsonb)) s
       where (s ->> 'index')::integer = v_action.step_index
       limit 1;
    end if;
  end if;

  v_tag := nullif(btrim(coalesce(
    v_step ->> 'tag_name',
    v_step ->> 'tag',
    v_action.payload ->> 'tag_name',
    v_action.payload ->> 'tag'
  )), '');

  if v_tag is null then
    update public.actions
       set status = 'failed',
           error_message = 'tag_name missing on step spec and action payload',
           last_error = 'tag_name missing on step spec and action payload',
           locked_until = null,
           locked_by = null
     where id = p_action_id;

    return jsonb_build_object('status', 'failed', 'reason', 'tag_name_missing');
  end if;

  if jsonb_typeof(v_lead.custom_fields -> 'tags') = 'array' then
    v_existing := v_lead.custom_fields -> 'tags';
  end if;

  if v_op = 'add' then
    v_next := coalesce((
      select jsonb_agg(elem)
        from jsonb_array_elements(v_existing) elem
    ), '[]'::jsonb);

    if not exists (
      select 1
        from jsonb_array_elements_text(v_existing) existing_tag
       where lower(btrim(existing_tag)) = lower(v_tag)
    ) then
      v_next := v_next || to_jsonb(v_tag);
    end if;
  else
    v_next := coalesce((
      select jsonb_agg(elem)
        from jsonb_array_elements(v_existing) elem
       where lower(btrim(elem #>> '{}')) <> lower(v_tag)
    ), '[]'::jsonb);
  end if;

  update public.leads
     set custom_fields = jsonb_set(coalesce(custom_fields, '{}'::jsonb), array['tags'], v_next, true),
         updated_at = now()
   where id = v_lead.id;

  update public.actions
     set status = 'completed',
         completed_at = coalesce(completed_at, now()),
         locked_until = null,
         locked_by = null,
         error_message = null,
         last_error = null,
         result = jsonb_build_object(
           'outcome', 'default',
           'op', v_op,
           'tag', v_tag,
           'tags_after', v_next
         )
   where id = p_action_id;

  insert into public.events (tenant_id, lead_id, action_id, channel, direction, provider, raw_payload)
  values (
    v_action.tenant_id,
    v_lead.id,
    v_action.id,
    'system',
    'internal',
    'engine',
    jsonb_build_object(
      'step_type', v_action.action_type,
      'tag', v_tag,
      'op', v_op,
      'tags_after', v_next
    )
  );

  perform public.advance_journey(p_action_id, 'default');

  return jsonb_build_object(
    'status', 'success',
    'op', v_op,
    'tag', v_tag,
    'tags_after', v_next
  );
end;
$$;
