-- Make manual webhook sample replays use the current saved journey spec.
--
-- A real webhook must remain idempotent when the upstream tool repeats the same
-- payload/key. A manual "Re-run through engine" is different: it is a debugging
-- action after the user changes mappings, so it must not resolve back to the
-- original failed journey_run/workflow_action.

create or replace function public.replay_webhook_sample(p_sample_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sample public.journey_webhook_samples%rowtype;
  v_journey public.journeys%rowtype;
  v_headers jsonb;
  v_result jsonb;
begin
  select *
    into v_sample
    from public.journey_webhook_samples
   where id = p_sample_id;

  if not found then
    return jsonb_build_object('status', 'failed', 'reason', 'sample_not_found');
  end if;

  select *
    into v_journey
    from public.journeys
   where id = v_sample.journey_id;

  if not found then
    return jsonb_build_object('status', 'failed', 'reason', 'journey_not_found');
  end if;

  v_headers := coalesce(v_sample.headers, '{}'::jsonb)
    - 'idempotency-key'
    - 'Idempotency-Key'
    - 'x-idempotency-key'
    - 'X-Idempotency-Key';

  v_headers := v_headers || jsonb_build_object(
    'Idempotency-Key',
    'manual-replay:' || p_sample_id::text || ':' || extract(epoch from clock_timestamp())::text
  );

  v_result := public.process_journey_webhook(
    v_journey.webhook_token,
    v_sample.payload,
    v_headers,
    null
  );

  return v_result || jsonb_build_object(
    'replayed_from_sample_id', p_sample_id,
    'replay', true
  );
end;
$$;
