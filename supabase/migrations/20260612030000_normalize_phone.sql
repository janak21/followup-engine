-- Migration: normalize_phone function & data migration
-- Created at: 2026-06-12T09:50:40+05:30

create or replace function normalize_phone(p_raw text, p_country_code text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_digits text;
begin
  if p_raw is null or p_raw = '' then
    return null;
  end if;

  -- Strip all non-digit characters
  v_digits := regexp_replace(p_raw, '[^0-9]', '', 'g');

  -- Prepend '1' if length is 10 and country code is US
  if length(v_digits) = 10 and (p_country_code is null or upper(p_country_code) = 'US') then
    v_digits := '1' || v_digits;
  end if;

  -- Check if length is between 11 and 15
  if length(v_digits) >= 11 and length(v_digits) <= 15 then
    return '+' || v_digits;
  end if;

  -- If invalid length or format, return null
  return null;
end;
$$;

-- Normalize existing phone numbers in the leads table
update leads
   set phone_e164 = normalize_phone(phone_raw, 'US'),
       raw_payload = case 
         when normalize_phone(phone_raw, 'US') is null then 
           coalesce(raw_payload, '{}'::jsonb) || '{"phone_validation_error": "Could not normalize phone number"}'::jsonb
         else 
           raw_payload
       end
 where phone_raw is not null;
