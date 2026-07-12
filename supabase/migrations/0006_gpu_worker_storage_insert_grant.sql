-- AI Video Platform
-- Migration 0006: grant the table-level Storage insert privilege needed by the
-- limited gpu_worker upload policy from 0005.
--
-- Execute manually in Supabase SQL Editor after 0005.
-- This does not make generated-videos public and does not allow ordinary users
-- to upload, because the 0005 RLS policy still requires
-- app_metadata.role = gpu_worker and an owned processing job.

grant insert on storage.objects to authenticated;
