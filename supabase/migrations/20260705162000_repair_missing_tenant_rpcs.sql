-- Launch repair 7/n: tenant/RLS helper RPCs + signup invite trigger + RLS
-- event trigger, missing on prod (backfill no-op, see repair 5). Bodies
-- verbatim from dev.
--
-- Applied to follow-up-prod via Supabase MCP on 2026-07-05.

CREATE OR REPLACE FUNCTION public.attach_user_to_tenant(p_email text, p_tenant_id uuid, p_role text DEFAULT 'owner'::text)
 RETURNS tenant_members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_row tenant_members;
begin
  select id into v_user_id from auth.users where lower(email) = lower(p_email);
  if v_user_id is null then
    raise exception 'no auth.users row for email %', p_email;
  end if;
  insert into tenant_members (tenant_id, user_id, role)
       values (p_tenant_id, v_user_id, p_role)
  on conflict (tenant_id, user_id) do update set role = excluded.role
  returning * into v_row;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.consume_tenant_invites_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_invite tenant_invites;
begin
  for v_invite in
    select * from tenant_invites
     where lower(email) = lower(NEW.email)
  loop
    insert into tenant_members (tenant_id, user_id, role, invited_by)
         values (v_invite.tenant_id, NEW.id, v_invite.role, v_invite.invited_by)
    on conflict (tenant_id, user_id) do update set role = excluded.role;
    delete from tenant_invites where id = v_invite.id;
  end loop;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.current_tenant_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select tenant_id
    from tenant_members
   where user_id = coalesce(
           nullif(current_setting('app.current_actor', true), '')::uuid,
           auth.uid()
         )
   order by created_at
   limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.current_user_role(p_tenant_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role
    from tenant_members
   where tenant_id = p_tenant_id
     and user_id = coalesce(
           nullif(current_setting('app.current_actor', true), '')::uuid,
           auth.uid()
         )
   limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_tenant_custom_field(p_tenant_id uuid, p_key text, p_label text, p_type text, p_folder text DEFAULT 'Auto from Retell'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant tenants;
  v_fields jsonb;
  v_existing jsonb;
  v_new_field jsonb;
  v_max_order int;
begin
  if p_key is null or p_key = '' then return; end if;
  -- Normalize key to snake_case, drop anything weird.
  p_key := lower(regexp_replace(p_key, '[^a-z0-9_]', '_', 'g'));

  select * into v_tenant from tenants where id = p_tenant_id for update;
  if not found then return; end if;

  v_fields := coalesce(v_tenant.config->'custom_fields', '[]'::jsonb);

  -- Skip if already declared (any case).
  select f into v_existing
    from jsonb_array_elements(v_fields) f
   where lower(f->>'key') = p_key
   limit 1;
  if found then return; end if;

  select coalesce(max((f->>'display_order')::int), 0) into v_max_order
    from jsonb_array_elements(v_fields) f;

  v_new_field := jsonb_build_object(
    'id',            gen_random_uuid()::text,
    'key',           p_key,
    'label',         coalesce(nullif(p_label,''), initcap(replace(p_key,'_',' '))),
    'type',          coalesce(nullif(p_type,''), 'single_line'),
    'folder',        p_folder,
    'description',   'Auto-registered from Retell call analysis on first occurrence.',
    'placeholder',   null,
    'default_value', '',
    'options',       null,
    'required',      false,
    'active',        true,
    'display_order', v_max_order + 1,
    'created_at',    to_jsonb(now())
  );

  update tenants
     set config = jsonb_set(coalesce(config,'{}'::jsonb), '{custom_fields}', v_fields || v_new_field, true),
         updated_at = now()
   where id = p_tenant_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.infer_custom_field_type(p_value jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  v_text text;
begin
  if p_value is null then return 'single_line'; end if;
  case jsonb_typeof(p_value)
    when 'boolean' then return 'boolean';
    when 'number'  then return 'number';
    when 'array'   then return 'multi_select';
    else
      v_text := p_value #>> '{}';
      if v_text is null or v_text = '' then return 'single_line'; end if;
      -- URL
      if v_text ~* '^https?://' then return 'url'; end if;
      -- ISO date or yyyy-mm-dd (loosely)
      if v_text ~ '^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?' then return 'date'; end if;
      -- Long-ish text -> multi_line
      if length(v_text) > 200 then return 'multi_line'; end if;
      return 'single_line';
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION public.is_operator(p_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select current_user_role(p_tenant_id) in ('owner','admin','member');
$function$;

CREATE OR REPLACE FUNCTION public.recompute_tenant_usage(p_tenant_id uuid, p_from date DEFAULT ((CURRENT_DATE - '30 days'::interval))::date, p_to date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rates jsonb;
  v_sms_seg_cents int;
  v_call_per_min  numeric;
  v_call_retell   numeric;
  v_email_cents   int;
  v_rows_written  int := 0;
begin
  select coalesce(config->'rates', '{}'::jsonb) into v_rates
    from tenants where id = p_tenant_id;

  v_sms_seg_cents := coalesce((v_rates->'sms'   ->>'per_segment_cents')::int, 1);
  v_call_per_min  := coalesce((v_rates->'call'  ->>'per_minute_cents')::numeric, 14);
  v_call_retell   := coalesce((v_rates->'call'  ->>'retell_per_minute_cents')::numeric, 9);
  v_email_cents   := coalesce((v_rates->'email' ->>'per_message_cents')::int, 0);

  insert into tenant_usage_daily (tenant_id, day, channel, msg_count, units, est_cost_cents, recomputed_at)
  select tenant_id, day, channel, msg_count, units,
         (units * cost_per_unit_cents)::int,
         now()
    from (
      select
        e.tenant_id,
        (e.created_at at time zone 'UTC')::date as day,
        e.channel,
        count(*)::int as msg_count,
        -- units: SMS=segments, call=minutes (duration_seconds/60), email=count.
        case e.channel
          when 'sms'   then sum(ceil(coalesce(length(e.body),0)::numeric / 160.0))
          when 'call'  then sum(coalesce(e.call_duration_seconds,0)::numeric / 60.0)
          when 'email' then count(*)::numeric
        end as units,
        case e.channel
          when 'sms'   then v_sms_seg_cents::numeric
          when 'call'  then v_call_per_min + v_call_retell
          when 'email' then v_email_cents::numeric
        end as cost_per_unit_cents
      from events e
      where e.tenant_id = p_tenant_id
        and e.direction = 'outbound'
        and e.channel in ('sms','call','email')
        and (e.created_at at time zone 'UTC')::date between p_from and p_to
      group by e.tenant_id, (e.created_at at time zone 'UTC')::date, e.channel
    ) agg
  on conflict (tenant_id, day, channel) do update
     set msg_count      = excluded.msg_count,
         units          = excluded.units,
         est_cost_cents = excluded.est_cost_cents,
         recomputed_at  = excluded.recomputed_at;

  get diagnostics v_rows_written = row_count;
  return v_rows_written;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_audit_actor(p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform set_config('app.current_actor', coalesce(p_actor::text, ''), false);
end;
$function$;

-- Signup invite trigger (auth schema) + RLS event trigger. Guarded: on some
-- Supabase plans the postgres role may lack rights; failure logs a warning
-- instead of failing the repair — the runbook then covers it manually.
do $do$
begin
  begin
    execute 'drop trigger if exists trg_consume_invites on auth.users';
    execute 'CREATE TRIGGER trg_consume_invites AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION consume_tenant_invites_on_signup()';
  exception when others then
    raise warning 'could not create auth.users invite trigger: %', sqlerrm;
  end;
  begin
    if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
      execute 'CREATE EVENT TRIGGER ensure_rls ON ddl_command_end WHEN TAG IN (''CREATE TABLE'') EXECUTE FUNCTION rls_auto_enable()';
    end if;
  exception when others then
    raise warning 'could not create ensure_rls event trigger: %', sqlerrm;
  end;
end
$do$;

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('attach_user_to_tenant','consume_tenant_invites_on_signup','current_tenant_id',
                         'current_user_role','ensure_tenant_custom_field','infer_custom_field_type',
                         'is_operator','recompute_tenant_usage','rls_auto_enable','set_audit_actor')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  -- RLS helpers must stay callable by authenticated (used in session context).
  execute 'grant execute on function public.current_tenant_id() to authenticated';
  execute 'grant execute on function public.current_user_role(uuid) to authenticated';
  execute 'grant execute on function public.is_operator(uuid) to authenticated';
end
$do$;
