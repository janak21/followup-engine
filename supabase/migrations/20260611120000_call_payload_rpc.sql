create or replace function get_call_payload(p_action_id uuid)
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
  
  v_result := jsonb_build_object(
    'action_id', v_action.id,
    'phone_to', v_lead.phone_e164,
    'first_name', v_lead.first_name
  );
  return v_result;
end;
$$;
