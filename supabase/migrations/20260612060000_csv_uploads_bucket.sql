-- Migration: Create csv-uploads storage bucket
-- Created at: 2026-06-12T11:14:14+05:30

insert into storage.buckets (id, name, public)
values ('csv-uploads', 'csv-uploads', false)
on conflict (id) do nothing;
