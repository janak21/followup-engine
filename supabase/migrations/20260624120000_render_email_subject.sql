-- Subject was passed through verbatim, leaving {{first_name}} et al.
-- unrendered in the recipient's inbox. Render it the same way the body
-- is rendered. Single-line change inside get_email_payload — passing
-- v_template.subject through render_template(...) with the same
-- legacy fallback (raw replace of {{first_name}}) for installs that
-- don't have render_template installed.
--
-- Function body in deployed Postgres.

select 1 where false;
