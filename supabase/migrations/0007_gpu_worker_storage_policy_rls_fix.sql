-- AI Video Platform
-- Migration 0007: fix limited gpu_worker Storage upload policy after 0006.
--
-- Execute manually in Supabase SQL Editor after 0006.
-- Do not place service_role keys, Secret keys, passwords, or tokens in SQL.
--
-- Why this is needed:
-- 0005 created a Storage insert policy that directly queried public.video_jobs.
-- That subquery still runs through video_jobs RLS, where gpu_worker is not the
-- owning end user, so the owned processing job is hidden and the policy rejects
-- valid uploads. This helper is security definer and performs only the narrow
-- path/job/worker check needed for Storage inserts.

create or replace function public.can_gpu_worker_upload_generated_video(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_folders text[] := storage.foldername(p_name);
  v_filename text := storage.filename(p_name);
  v_job_id uuid;
begin
  if not public.is_gpu_worker() then
    return false;
  end if;

  if v_filename not in ('output.mp4', 'output.webm') then
    return false;
  end if;

  if array_length(v_folders, 1) <> 2 then
    return false;
  end if;

  begin
    v_job_id := v_folders[2]::uuid;
  exception
    when invalid_text_representation then
      return false;
  end;

  return exists (
    select 1
    from public.video_jobs job
    where job.user_id::text = v_folders[1]
      and job.id = v_job_id
      and job.status = 'processing'
      and job.worker_id = auth.uid()::text
  );
end;
$$;

revoke all on function public.can_gpu_worker_upload_generated_video(text) from public, anon;
grant execute on function public.can_gpu_worker_upload_generated_video(text) to authenticated, service_role;

drop policy if exists "generated_videos_gpu_worker_insert_owned_output" on storage.objects;
create policy "generated_videos_gpu_worker_insert_owned_output"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'generated-videos'
  and public.can_gpu_worker_upload_generated_video(name)
);
