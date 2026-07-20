-- Forward-only claim-scoped lifecycle contracts for immutable Wan RTX 4090 batches.
-- These wrappers intentionally do not expose the generic worker queue.
create or replace function public.assert_batch_claim(
  p_batch_id uuid, p_job_id uuid, p_worker_id text, p_expected_model_key text, p_expected_gpu_class text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_worker text := public.normalize_worker_id(p_worker_id);
begin
  if p_expected_model_key <> 'video_wan_silent' or p_expected_gpu_class <> 'rtx4090' then raise exception 'batch worker identity mismatch'; end if;
  if not exists (
    select 1 from public.gpu_execution_batches b
    join public.gpu_execution_batch_tasks m on m.batch_id=b.id
    join public.video_jobs j on j.id=m.task_id
    where b.id=p_batch_id and b.model_key=p_expected_model_key and b.gpu_class=p_expected_gpu_class
      and b.status in ('waiting_for_worker','running_batch','paused','draining','canceling')
      and m.task_id=p_job_id and m.status='claimed' and m.claimed_worker_id=v_worker
      and j.status='processing' and j.worker_id=v_worker and j.attempt_count=m.attempt_count+1
  ) then raise exception 'batch claim is not owned by this worker'; end if;
  return v_worker;
end; $$;

create or replace function public.heartbeat_video_job_for_batch(
  p_batch_id uuid, p_job_id uuid, p_worker_id text, p_expected_model_key text, p_expected_gpu_class text,
  p_progress integer, p_lease_seconds integer default 300
) returns public.video_jobs language plpgsql security definer set search_path = '' as $$
declare v_worker text := public.assert_batch_claim(p_batch_id,p_job_id,p_worker_id,p_expected_model_key,p_expected_gpu_class); v_job public.video_jobs%rowtype;
begin
  update public.video_jobs set progress=greatest(progress,least(99,greatest(1,coalesce(p_progress,1)))), lease_expires_at=timezone('utc',now())+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,300),3600)))
  where id=p_job_id and worker_id=v_worker and status='processing' returning * into v_job;
  if v_job.id is null then raise exception 'batch lease is no longer active'; end if;
  return v_job;
end; $$;

create or replace function public.complete_video_job_for_batch(
  p_batch_id uuid, p_job_id uuid, p_worker_id text, p_expected_model_key text, p_expected_gpu_class text,
  p_output_video_path text, p_output_size_bytes bigint, p_output_mime_type text
) returns public.video_jobs language plpgsql security definer set search_path = '' as $$
declare v_worker text := public.normalize_worker_id(p_worker_id); v_job public.video_jobs%rowtype;
begin
  select j.* into v_job from public.video_jobs j join public.gpu_execution_batch_tasks m on m.task_id=j.id
    where m.batch_id=p_batch_id and m.task_id=p_job_id and m.status='completed' and m.claimed_worker_id=v_worker;
  if v_job.id is not null then return v_job; end if;
  v_worker := public.assert_batch_claim(p_batch_id,p_job_id,p_worker_id,p_expected_model_key,p_expected_gpu_class);
  update public.video_jobs set status='succeeded', progress=100, output_video_path=btrim(p_output_video_path), output_size_bytes=p_output_size_bytes, output_mime_type=coalesce(nullif(btrim(p_output_mime_type),''),'video/mp4'), lease_expires_at=null, completed_at=timezone('utc',now())
    where id=p_job_id and worker_id=v_worker and status='processing' returning * into v_job;
  if v_job.id is null then raise exception 'batch completion rejected'; end if;
  update public.gpu_execution_batch_tasks set status='completed', completed_at=timezone('utc',now()) where batch_id=p_batch_id and task_id=p_job_id and status='claimed' and claimed_worker_id=v_worker;
  return v_job;
end; $$;

create or replace function public.fail_video_job_for_batch(
  p_batch_id uuid, p_job_id uuid, p_worker_id text, p_expected_model_key text, p_expected_gpu_class text, p_error_message text
) returns public.video_jobs language plpgsql security definer set search_path = '' as $$
declare v_worker text := public.assert_batch_claim(p_batch_id,p_job_id,p_worker_id,p_expected_model_key,p_expected_gpu_class); v_job public.video_jobs%rowtype;
begin
  update public.video_jobs set status='failed', error_message=left(btrim(coalesce(p_error_message,'GPU worker failed.')),500), lease_expires_at=null, completed_at=timezone('utc',now())
    where id=p_job_id and worker_id=v_worker and status='processing' returning * into v_job;
  if v_job.id is null then raise exception 'batch failure rejected'; end if;
  update public.gpu_execution_batch_tasks set status='failed', completed_at=timezone('utc',now()), failure_classification=left(btrim(coalesce(p_error_message,'GPU worker failed.')),300)
    where batch_id=p_batch_id and task_id=p_job_id and status='claimed' and claimed_worker_id=v_worker;
  return v_job;
end; $$;

revoke all on function public.assert_batch_claim(uuid,uuid,text,text,text) from public, anon;
revoke all on function public.heartbeat_video_job_for_batch(uuid,uuid,text,text,text,integer,integer) from public, anon;
revoke all on function public.complete_video_job_for_batch(uuid,uuid,text,text,text,text,bigint,text) from public, anon;
revoke all on function public.fail_video_job_for_batch(uuid,uuid,text,text,text,text) from public, anon;
grant execute on function public.heartbeat_video_job_for_batch(uuid,uuid,text,text,text,integer,integer) to authenticated, service_role;
grant execute on function public.complete_video_job_for_batch(uuid,uuid,text,text,text,text,bigint,text) to authenticated, service_role;
grant execute on function public.fail_video_job_for_batch(uuid,uuid,text,text,text,text) to authenticated, service_role;
