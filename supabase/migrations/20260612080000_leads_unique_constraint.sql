-- Migration: Change leads partial unique index to standard unique constraint for PostgREST upsert compatibility
-- Created at: 2026-06-12T13:27:00+05:30

drop index if exists leads_tenant_email_uniq;

alter table leads add constraint leads_tenant_email_key unique (tenant_id, email);
