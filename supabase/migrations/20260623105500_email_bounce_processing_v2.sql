-- Email bounce processing v2. Extends process_inbound_email to:
--   * Catch Gmail's prose-format "wasn't delivered to X" pattern
--     (every observed bounce in this DB; prior regexes never matched it).
--   * Extract SMTP code with the correct PG word-boundary marker (\y, not \b
--     which is backspace in Postgres POSIX regex).
--   * Distinguish hard (5xx) vs soft (4xx) failures.
--   * Mark the original outbound action 'failed' (look up by recipient
--     within last 72h, flip from 'completed' to 'failed').
--   * On hard bounce: opt the lead out + cancel pending actions.
--   * Always write an error_logs row for visibility on the Errors page.
-- Function body in deployed Postgres.

select 1 where false;
