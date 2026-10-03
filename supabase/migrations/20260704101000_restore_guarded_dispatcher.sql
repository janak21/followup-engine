-- Restore the guarded dispatcher — and kill the overload trap.
--
-- 20260627092000 created dispatch_pending_actions(text, integer, integer)
-- as a NEW overload instead of replacing (text, integer). Overload
-- resolution made every 2-arg call (pg_cron, ops page) bind to the OLD
-- unguarded version, so dispatch_guard_external_action/should_dispatch never
-- ran in production (0 guard rows in error_logs, ever). The 3-param guarded
-- version was later dropped out-of-band, leaving ONLY the unguarded
-- dispatcher deployed.
--
-- This migration drops the 2-arg version and recreates the canonical guarded
-- 3-param body (verbatim from 20260627092000). 2-arg callers bind to it via
-- the per_tenant_limit default — cron command unchanged.

drop function if exists public.dispatch_pending_actions(text, integer);

create or replace function public.dispatch_pending_actions(
  worker_id text,
  batch_size integer default 20,
  per_tenant_limit integer default 5
)
returns setof public.actions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inline_id uuid; v_inline_type text;
  v_stale_id uuid;  v_stale_type text;
  v_call_action     public.actions%rowtype;
  v_sms_action      public.actions%rowtype;
  v_email_action    public.actions%rowtype;
  v_ai_reply_action public.actions%rowtype;
  v_guard jsonb;
  v_dispatch_key text;
  v_call_url     text := 'https://your-project-ref.supabase.co/functions/v1/dispatch-retell-call';
  v_sms_url      text := 'https://your-project-ref.supabase.co/functions/v1/dispatch-twilio-sms';
  v_email_url    text := 'https://your-project-ref.supabase.co/functions/v1/dispatch-gmail-email';
  v_ai_reply_url text := 'https://your-project-ref.supabase.co/functions/v1/generate-ai-reply';
  v_net_request_id bigint;
begin
  for v_stale_id, v_stale_type in
    select id, action_type from public.actions
     where status='in_progress' and locked_until is not null and locked_until < now() - interval '60 seconds'
     order by locked_until limit 100 for update skip locked
  loop
    begin
      perform public.mark_action_failed(v_stale_id,
        'dispatcher_lock_expired: action ' || v_stale_id::text || ' (' || v_stale_type ||
        ') was locked but never completed; retrying per mark_action_failed policy.');
    exception when others then
      insert into public.error_logs (workflow_name, error_message, raw_error, severity, created_at)
        values ('dispatcher_stale_recovery', sqlerrm,
                jsonb_build_object('action_id', v_stale_id, 'sqlstate', sqlstate), 'error', now());
    end;
  end loop;

  v_dispatch_key := public.get_internal_dispatch_key();
  if v_dispatch_key is null then
    insert into public.error_logs (workflow_name, error_message, severity, created_at)
      values ('dispatcher_inline', 'internal_dispatch_key not set in Vault', 'error', now());
  end if;

  if v_dispatch_key is not null then
    for v_call_action in
      update public.actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from public.actions
          where action_type='call' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
            and id in (
              select sub.id from (
                select id, row_number() over (partition by tenant_id order by run_at) as rank
                  from public.actions
                 where action_type='call' and status='pending' and run_at<=now()
                   and (locked_until is null or locked_until<now())
              ) sub
              where sub.rank <= per_tenant_limit
            )
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        v_guard := public.dispatch_guard_external_action(v_call_action.id);
        if coalesce((v_guard->>'can_dispatch')::boolean, false) then
          select net.http_post(url:=v_call_url,
            body:=jsonb_build_object('action_id', v_call_action.id),
            headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
            timeout_milliseconds:=30000) into v_net_request_id;
        end if;
      exception when others then
        perform public.mark_action_failed(v_call_action.id, 'dispatcher: failed dispatch-retell-call via pg_net: '||sqlerrm);
      end;
    end loop;

    for v_sms_action in
      update public.actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from public.actions
          where action_type='sms' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
            and id in (
              select sub.id from (
                select id, row_number() over (partition by tenant_id order by run_at) as rank
                  from public.actions
                 where action_type='sms' and status='pending' and run_at<=now()
                   and (locked_until is null or locked_until<now())
              ) sub
              where sub.rank <= per_tenant_limit
            )
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        v_guard := public.dispatch_guard_external_action(v_sms_action.id);
        if coalesce((v_guard->>'can_dispatch')::boolean, false) then
          select net.http_post(url:=v_sms_url,
            body:=jsonb_build_object('action_id', v_sms_action.id),
            headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
            timeout_milliseconds:=30000) into v_net_request_id;
        end if;
      exception when others then
        perform public.mark_action_failed(v_sms_action.id, 'dispatcher: failed dispatch-twilio-sms via pg_net: '||sqlerrm);
      end;
    end loop;

    for v_email_action in
      update public.actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from public.actions
          where action_type='email' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
            and id in (
              select sub.id from (
                select id, row_number() over (partition by tenant_id order by run_at) as rank
                  from public.actions
                 where action_type='email' and status='pending' and run_at<=now()
                   and (locked_until is null or locked_until<now())
              ) sub
              where sub.rank <= per_tenant_limit
            )
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        v_guard := public.dispatch_guard_external_action(v_email_action.id);
        if coalesce((v_guard->>'can_dispatch')::boolean, false) then
          select net.http_post(url:=v_email_url,
            body:=jsonb_build_object('action_id', v_email_action.id),
            headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
            timeout_milliseconds:=30000) into v_net_request_id;
        end if;
      exception when others then
        perform public.mark_action_failed(v_email_action.id, 'dispatcher: failed dispatch-gmail-email via pg_net: '||sqlerrm);
      end;
    end loop;

    -- ai_reply is an internal decision step, not direct lead contact. Its
    -- generated outbound email action is guarded separately before email send.
    for v_ai_reply_action in
      update public.actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
       where id in (
         select id from public.actions
          where action_type='ai_reply' and status='pending' and run_at<=now()
            and (locked_until is null or locked_until<now())
            and id in (
              select sub.id from (
                select id, row_number() over (partition by tenant_id order by run_at) as rank
                  from public.actions
                 where action_type='ai_reply' and status='pending' and run_at<=now()
                   and (locked_until is null or locked_until<now())
              ) sub
              where sub.rank <= per_tenant_limit
            )
          order by run_at limit batch_size for update skip locked
       ) returning *
    loop
      begin
        select net.http_post(url:=v_ai_reply_url,
          body:=jsonb_build_object('action_id', v_ai_reply_action.id),
          headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_dispatch_key),
          timeout_milliseconds:=60000) into v_net_request_id;
      exception when others then
        perform public.mark_action_failed(v_ai_reply_action.id, 'dispatcher: failed generate-ai-reply via pg_net: '||sqlerrm);
      end;
    end loop;
  end if;

  for v_inline_id, v_inline_type in
    select id, action_type from public.actions
     where action_type in (
              'wait','create_lead','update_lead','find_lead','team_alert',
              'conditional_split','exit_flow','add_tag','remove_tag','wait_reply'
            )
       and status='pending' and run_at<=now()
       and id in (
         select sub.id from (
           select id, row_number() over (partition by tenant_id order by run_at) as rank
             from public.actions
            where action_type in (
                    'wait','create_lead','update_lead','find_lead','team_alert',
                    'conditional_split','exit_flow','add_tag','remove_tag','wait_reply'
                  )
              and status='pending' and run_at<=now()
         ) sub
         where sub.rank <= (per_tenant_limit * 25)
       )
     order by run_at limit 500 for update skip locked
  loop
    begin
      if v_inline_type='wait' then perform public.process_wait_action(v_inline_id);
      elsif v_inline_type in ('create_lead','update_lead') then perform public.process_action_set_lead_fields(v_inline_id);
      elsif v_inline_type='find_lead' then perform public.process_action_find_lead(v_inline_id);
      elsif v_inline_type='team_alert' then perform public.process_team_alert_action(v_inline_id);
      elsif v_inline_type='conditional_split' then perform public.process_action_conditional_split(v_inline_id);
      elsif v_inline_type='exit_flow' then perform public.process_action_exit_flow(v_inline_id);
      elsif v_inline_type in ('add_tag','remove_tag') then perform public.process_action_tag(v_inline_id);
      elsif v_inline_type='wait_reply' then perform public.process_action_wait_reply(v_inline_id);
      end if;
    exception when others then
      insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, created_at)
        select tenant_id, 'dispatch_pending_actions:inline:'||v_inline_type, sqlerrm,
               jsonb_build_object('action_id', v_inline_id, 'sqlstate', sqlstate), now()
          from public.actions where id = v_inline_id;
    end;
  end loop;

  for v_inline_id, v_inline_type in
    select id, action_type from public.actions
     where action_type='http_request'
       and status='pending' and run_at<=now()
       and id in (
         select sub.id from (
           select id, row_number() over (partition by tenant_id order by run_at) as rank
             from public.actions
            where action_type='http_request'
              and status='pending' and run_at<=now()
         ) sub
         where sub.rank <= per_tenant_limit
       )
     order by run_at limit 20 for update skip locked
  loop
    begin
      perform public.process_action_http_request(v_inline_id);
    exception when others then
      insert into public.error_logs (tenant_id, workflow_name, error_message, raw_error, created_at)
        select tenant_id, 'dispatch_pending_actions:inline:http_request_fire', sqlerrm,
               jsonb_build_object('action_id', v_inline_id, 'sqlstate', sqlstate), now()
          from public.actions where id = v_inline_id;
    end;
  end loop;

  begin
    perform public.process_action_http_collector(50);
  exception when others then
    insert into public.error_logs (workflow_name, error_message, raw_error, severity, created_at)
      values ('dispatch_pending_actions:http_collector', sqlerrm,
              jsonb_build_object('sqlstate', sqlstate), 'error', now());
  end;

  return query
    update public.actions set status='in_progress', locked_until=now()+interval '5 minutes', locked_by=worker_id
     where id in (
       select id from public.actions where run_at<=now() and status='pending'
          and action_type not in (
                'wait','create_lead','update_lead','find_lead','team_alert',
                'conditional_split','exit_flow','add_tag','remove_tag',
                'http_request','wait_reply',
                'call','sms','email','ai_reply'
          )
          and (locked_until is null or locked_until<now())
          and id in (
            select sub.id from (
              select id, row_number() over (partition by tenant_id order by run_at) as rank
                from public.actions
               where run_at<=now() and status='pending'
                 and action_type not in (
                       'wait','create_lead','update_lead','find_lead','team_alert',
                       'conditional_split','exit_flow','add_tag','remove_tag',
                       'http_request','wait_reply',
                       'call','sms','email','ai_reply'
                 )
                 and (locked_until is null or locked_until<now())
            ) sub
            where sub.rank <= per_tenant_limit
          )
        order by run_at limit batch_size for update skip locked
     ) returning *;
end;
$$;

revoke execute on function public.dispatch_pending_actions(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.dispatch_pending_actions(text, integer, integer)
  to service_role;
