-- Notify Team is an inline journey step. It logs an operator-visible alert,
-- completes the action, and then advances the journey on the builder-supported
-- `sent` outcome. advance_journey is already idempotent via actions.result.
CREATE OR REPLACE FUNCTION public.process_team_alert_action(p_action_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_action public.actions%rowtype;
  v_processed boolean := false;
BEGIN
  SELECT * INTO v_action
  FROM public.actions
  WHERE id = p_action_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_action.status = 'completed' THEN
    PERFORM public.advance_journey(p_action_id, 'sent');
    RETURN;
  END IF;

  v_processed := coalesce(v_action.result ? 'team_alert_processed_at', false);

  IF NOT v_processed THEN
    INSERT INTO public.error_logs (tenant_id, workflow_name, error_message, raw_error, severity, status)
    VALUES (
      v_action.tenant_id,
      'team_alert',
      'Team alert: ' || coalesce(v_action.payload->>'reason', 'unspecified'),
      v_action.payload,
      'info',
      'open'
    );

    UPDATE public.actions
    SET status = 'completed',
        completed_at = coalesce(completed_at, now()),
        locked_until = null,
        locked_by = null,
        result = coalesce(result, '{}'::jsonb)
          || jsonb_build_object(
            'processed_inline', true,
            'team_alert_processed_at', now(),
            'note', 'team_alert acknowledged + logged to error_logs'
          )
    WHERE id = p_action_id;
  END IF;

  PERFORM public.advance_journey(p_action_id, 'sent');
END;
$function$;
