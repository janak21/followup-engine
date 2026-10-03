create or replace function get_sms_payload(p_action_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_action actions;
  v_lead leads;
  v_template templates;
  v_result jsonb;
begin
  select * into v_action from actions where id = p_action_id;
  select * into v_lead from leads where id = v_action.lead_id;
  select * into v_template from templates where tenant_id = v_action.tenant_id and template_key = v_action.template_key;
  
  v_result := jsonb_build_object(
    'action_id', v_action.id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name,
    'body', replace(v_template.body, '{{first_name}}', coalesce(v_lead.first_name, ''))
  );
  return v_result;
end;
$$;
