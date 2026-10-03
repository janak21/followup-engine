-- Migration: resolve_twilio_credentials(p_phone) for X-Twilio-Signature validation
-- Returns the tenant's Twilio account_sid + auth_token for a given phone number so
-- the twilio-inbound / twilio-status edge functions can verify X-Twilio-Signature
-- before trusting the webhook payload. SECURITY DEFINER because the edge function
-- uses the service role key (supabase-js bypasses RLS) but tenant_credentials is
-- not readable by the anon/authenticated role that an unauthenticated Twilio
-- request would carry. The function only returns the two fields needed for
-- signature validation; it never returns the full config blob.
--
-- Returns: jsonb { tenant_id, account_sid, auth_token } or NULL.

create or replace function resolve_twilio_credentials(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creds tenant_credentials;
begin
  select *
    into v_creds
    from tenant_credentials
   where provider = 'twilio'
     and active = true
     and (config->>'from_number' = p_phone
          or config->>'from_number' = replace(p_phone, '+', ''))
   limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'tenant_id',   v_creds.tenant_id,
    'account_sid', v_creds.config->>'account_sid',
    'auth_token',  v_creds.config->>'auth_token'
  );
end;
$$;

-- Supabase/PostgREST grants EXECUTE to anon+authenticated on all public RPCs
-- by default; a REVOKE FROM public alone does NOT remove those. Revoke from
-- anon+authenticated explicitly, otherwise any anonymous caller can read a
-- tenant's Twilio auth_token by guessing the phone number via
-- /rest/v1/rpc/resolve_twilio_credentials.
revoke execute on function resolve_twilio_credentials(text) from anon;
revoke execute on function resolve_twilio_credentials(text) from authenticated;
revoke execute on function resolve_twilio_credentials(text) from public;
grant execute on function resolve_twilio_credentials(text) to service_role;