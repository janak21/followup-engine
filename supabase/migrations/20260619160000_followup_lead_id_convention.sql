-- One identifier convention, system-wide:
--   Outbound: every channel that supports metadata carries followup_lead_id.
--   Inbound:  process_journey_webhook checks a fixed handful of well-known
--             paths for followup_lead_id before falling back to email/phone.
--   Anywhere a lead is in scope: {{lead_id}} resolves to the lead's UUID.
--
-- No per-journey config, no strategy dropdowns. The webhook stays dumb.

create or replace function render_template(p_body text, p_lead leads)
returns text
language plpgsql
security definer
set search_path to public
as $$
declare
  v_res text := p_body;
  v_key text;
  v_val text;
begin
  if v_res is null then return null; end if;

  v_res := replace(v_res, '{{lead_id}}', coalesce(p_lead.id::text, ''));
  v_res := replace(v_res, '{{first_name}}',    coalesce(p_lead.first_name, ''));
  v_res := replace(v_res, '{{last_name}}',     coalesce(p_lead.last_name, ''));
  v_res := replace(v_res, '{{email}}',         coalesce(p_lead.email, ''));
  v_res := replace(v_res, '{{phone_raw}}',     coalesce(p_lead.phone_raw, ''));
  v_res := replace(v_res, '{{phone_e164}}',    coalesce(p_lead.phone_e164, ''));
  v_res := replace(v_res, '{{campaign_type}}', coalesce(p_lead.campaign_type, ''));
  v_res := replace(v_res, '{{source}}',        coalesce(p_lead.source, ''));
  v_res := replace(v_res, '{{zip_code}}',      coalesce(p_lead.zip_code, ''));
  v_res := replace(v_res, '{{address}}',       coalesce(p_lead.address_line1, ''));

  if p_lead.custom_fields is not null then
    for v_key, v_val in select * from jsonb_each_text(p_lead.custom_fields) loop
      v_res := replace(v_res, '{{' || v_key || '}}', coalesce(v_val, ''));
    end loop;
  end if;

  return v_res;
end;
$$;

-- get_call_payload returns lead_id so n8n can stamp it on Retell calls
-- (full body in the deployed function; this mirror is the canonical source.)
create or replace function get_call_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action      actions;
  v_lead        leads;
  v_credentials tenant_credentials;
  v_step_agent_id text;
  v_agent       retell_agents;
  v_resolved_agent_id text;
  v_resolved_from_number text;
begin
  select * into v_action from actions where id = p_action_id;
  if not found then return jsonb_build_object('outcome','failed','reason','Action not found'); end if;

  if v_action.status = 'completed' then
    return jsonb_build_object('outcome','already_completed','action_id',v_action.id,
      'provider_id',v_action.provider_id,'reason','Action already completed; nothing to do.');
  end if;

  select * into v_lead from leads where id = v_action.lead_id;
  if not found then return jsonb_build_object('outcome','failed','reason','Lead not found'); end if;

  select * into v_credentials from tenant_credentials
   where tenant_id = v_action.tenant_id and provider = 'retell' and active = true;
  if not found then return jsonb_build_object('outcome','failed','reason','Retell credentials not found'); end if;

  v_step_agent_id := v_action.payload -> 'step_spec' ->> 'retell_agent_id';
  if v_step_agent_id is not null and v_step_agent_id <> '' then
    select * into v_agent from retell_agents
     where tenant_id = v_action.tenant_id and agent_id = v_step_agent_id and active = true limit 1;
    if found then
      v_resolved_agent_id    := v_agent.agent_id;
      v_resolved_from_number := coalesce(v_agent.from_number, v_credentials.config->>'from_number');
    else
      return jsonb_build_object('outcome','failed','reason','retell_agent_not_found: '||v_step_agent_id);
    end if;
  else
    v_resolved_agent_id    := v_credentials.config->>'agent_id';
    v_resolved_from_number := v_credentials.config->>'from_number';
  end if;

  if v_resolved_agent_id is null or v_resolved_agent_id = '' then
    return jsonb_build_object('outcome','failed','reason','No Retell agent configured');
  end if;

  return jsonb_build_object(
    'outcome','success',
    'action_id', v_action.id,
    'provider_id', v_action.provider_id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'lead_id', v_lead.id,
    'retell_credential_name', v_credentials.n8n_credential_name,
    'retell_from_number', v_resolved_from_number,
    'retell_agent_id', v_resolved_agent_id
  );
end;
$$;

-- process_journey_webhook: followup_lead_id fixed-path lookup wins outright,
-- otherwise falls through to the existing email/phone find-or-create flow.
-- See deployed function in Supabase for full body.
