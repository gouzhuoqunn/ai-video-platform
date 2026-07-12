-- AI Video Platform
-- Migration 0005: limited GPU worker role for third-party GPU hosts.
-- Execute manually in Supabase SQL Editor only after reviewing.
-- Do not place service_role keys, Secret keys, passwords, or tokens in SQL.

create or replace function public.is_gpu_worker()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'gpu_worker';
$$;

create or replace function public.is_worker_caller()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.role() = 'service_role' or public.is_gpu_worker();
$$;

create or replace function public.enforce_worker_caller()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_worker_caller() then
    raise exception 'worker role required';
  end if;
end;
$$;

create or replace function public.normalize_worker_id(p_worker_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_worker_id text := btrim(coalesce(p_worker_id, ''));
begin
  perform public.enforce_worker_caller();

  if auth.role() = 'service_role' then
    if v_worker_id = '' then
      raise exception 'worker_id不能为空。';
    end if;

    return v_worker_id;
  end if;

  return auth.uid()::text;
end;
$$;

create or replace function public.claim_next_video_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns table (
  id uuid,
  user_id uuid,
  prompt text,
  model_key text,
  status text,
  duration_seconds integer,
  resolution text,
  cost_credits integer,
  progress integer,
  attempt_count integer,
  max_attempts integer,
  output_video_path text,
  output_mime_type text,
  worker_id text,
  lease_expires_at timestamptz,
  created_at timestamptz,
  started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker_id text := public.normalize_worker_id(p_worker_id);
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
begin
  return query
  with next_job as (
    select queued.id
    from public.video_jobs queued
    where queued.status = 'queued'
      and queued.attempt_count < queued.max_attempts
    order by queued.created_at asc
    for update skip locked
    limit 1
  )
  update public.video_jobs job
  set
    status = 'processing',
    progress = 1,
    worker_id = v_worker_id,
    attempt_count = job.attempt_count + 1,
    lease_expires_at = timezone('utc', now()) + make_interval(secs => v_lease_seconds),
    started_at = coalesce(job.started_at, timezone('utc', now()))
  from next_job
  where job.id = next_job.id
  returning
    job.id,
    job.user_id,
    job.prompt,
    job.model_key,
    job.status,
    job.duration_seconds,
    job.resolution,
    job.cost_credits,
    job.progress,
    job.attempt_count,
    job.max_attempts,
    job.output_video_path,
    job.output_mime_type,
    job.worker_id,
    job.lease_expires_at,
    job.created_at,
    job.started_at;
end;
$$;

create or replace function public.heartbeat_video_job(
  p_job_id uuid,
  p_worker_id text,
  p_progress integer,
  p_lease_seconds integer default 300
)
returns public.video_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker_id text := public.normalize_worker_id(p_worker_id);
  v_progress integer := least(99, greatest(1, coalesce(p_progress, 1)));
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
  v_job public.video_jobs%rowtype;
begin
  update public.video_jobs job
  set
    progress = greatest(job.progress, v_progress),
    lease_expires_at = timezone('utc', now()) + make_interval(secs => v_lease_seconds)
  where job.id = p_job_id
    and job.worker_id = v_worker_id
    and job.status = 'processing'
  returning *
  into v_job;

  if v_job.id is null then
    raise exception '没有找到当前Worker持有的生成中任务。';
  end if;

  return v_job;
end;
$$;

create or replace function public.complete_video_job(
  p_job_id uuid,
  p_worker_id text,
  p_output_video_path text,
  p_output_size_bytes bigint,
  p_output_mime_type text default 'video/mp4'
)
returns public.video_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker_id text := public.normalize_worker_id(p_worker_id);
  v_output_video_path text := btrim(coalesce(p_output_video_path, ''));
  v_output_mime_type text := btrim(coalesce(p_output_mime_type, 'video/mp4'));
  v_existing public.video_jobs%rowtype;
  v_job public.video_jobs%rowtype;
  v_expected_path text;
begin
  if v_output_mime_type not in ('video/mp4', 'video/webm') then
    raise exception '输出视频类型不支持。';
  end if;

  select *
  into v_existing
  from public.video_jobs existing
  where existing.id = p_job_id
  for update;

  if v_existing.id is null then
    raise exception '没有找到视频任务。';
  end if;

  if v_existing.status = 'succeeded' then
    return v_existing;
  end if;

  v_expected_path := v_existing.user_id::text || '/' || v_existing.id::text || '/output.' ||
    case when v_output_mime_type = 'video/webm' then 'webm' else 'mp4' end;

  if v_output_video_path <> v_expected_path then
    raise exception '输出视频路径不符合任务归属规则。';
  end if;

  if p_output_size_bytes is null or p_output_size_bytes < 0 then
    raise exception '输出视频大小不正确。';
  end if;

  update public.video_jobs job
  set
    status = 'succeeded',
    progress = 100,
    completed_at = timezone('utc', now()),
    worker_id = null,
    lease_expires_at = null,
    output_video_path = v_output_video_path,
    output_size_bytes = p_output_size_bytes,
    output_mime_type = v_output_mime_type,
    output_video_url = null
  where job.id = p_job_id
    and job.worker_id = v_worker_id
    and job.status = 'processing'
  returning *
  into v_job;

  if v_job.id is null then
    raise exception '没有找到当前Worker持有的生成中任务。';
  end if;

  return v_job;
end;
$$;

create or replace function public.fail_video_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_message text
)
returns public.video_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker_id text := public.normalize_worker_id(p_worker_id);
  v_error_message text := left(btrim(coalesce(p_error_message, '视频生成失败。')), 500);
  v_job public.video_jobs%rowtype;
  v_refund_inserted integer := 0;
begin
  select *
  into v_job
  from public.video_jobs existing
  where existing.id = p_job_id
    and existing.worker_id = v_worker_id
    and existing.status = 'processing'
  for update;

  if v_job.id is null then
    raise exception '没有找到当前Worker持有的生成中任务。';
  end if;

  if v_job.cost_credits > 0 and v_job.charged_at is not null and v_job.refunded_at is null then
    insert into public.credit_transactions (
      user_id,
      amount,
      transaction_type,
      description,
      reference_id
    )
    values (
      v_job.user_id,
      v_job.cost_credits,
      'generation_refund',
      '视频任务失败退还积分',
      v_job.id
    )
    on conflict (user_id, transaction_type, reference_id)
    where reference_id is not null
    do nothing;

    get diagnostics v_refund_inserted = row_count;

    if v_refund_inserted = 1 then
      update public.credit_accounts account
      set balance = account.balance + v_job.cost_credits
      where account.user_id = v_job.user_id;
    end if;
  end if;

  update public.video_jobs job
  set
    status = 'failed',
    error_message = v_error_message,
    completed_at = timezone('utc', now()),
    worker_id = null,
    lease_expires_at = null,
    refunded_at = case
      when job.cost_credits > 0 and job.charged_at is not null and job.refunded_at is null then timezone('utc', now())
      else job.refunded_at
    end
  where job.id = p_job_id
  returning *
  into v_job;

  return v_job;
end;
$$;

create or replace function public.requeue_stale_video_jobs()
returns table (
  requeued_count integer,
  failed_count integer,
  refunded_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requeued_count integer := 0;
  v_failed_count integer := 0;
  v_refunded_count integer := 0;
  v_job public.video_jobs%rowtype;
  v_refund_inserted integer := 0;
begin
  perform public.enforce_worker_caller();

  update public.video_jobs job
  set
    status = 'queued',
    progress = 0,
    worker_id = null,
    lease_expires_at = null
  where job.status = 'processing'
    and job.lease_expires_at is not null
    and job.lease_expires_at < timezone('utc', now())
    and job.attempt_count < job.max_attempts;

  get diagnostics v_requeued_count = row_count;

  for v_job in
    select *
    from public.video_jobs existing
    where existing.status = 'processing'
      and existing.lease_expires_at is not null
      and existing.lease_expires_at < timezone('utc', now())
      and existing.attempt_count >= existing.max_attempts
    for update
  loop
    v_refund_inserted := 0;

    if v_job.cost_credits > 0 and v_job.charged_at is not null and v_job.refunded_at is null then
      insert into public.credit_transactions (
        user_id,
        amount,
        transaction_type,
        description,
        reference_id
      )
      values (
        v_job.user_id,
        v_job.cost_credits,
        'generation_refund',
        '任务多次超时失败退还积分',
        v_job.id
      )
      on conflict (user_id, transaction_type, reference_id)
      where reference_id is not null
      do nothing;

      get diagnostics v_refund_inserted = row_count;

      if v_refund_inserted = 1 then
        update public.credit_accounts account
        set balance = account.balance + v_job.cost_credits
        where account.user_id = v_job.user_id;
        v_refunded_count := v_refunded_count + 1;
      end if;
    end if;

    update public.video_jobs job
    set
      status = 'failed',
      progress = greatest(job.progress, 1),
      error_message = '任务多次超时，已停止处理。',
      completed_at = timezone('utc', now()),
      worker_id = null,
      lease_expires_at = null,
      refunded_at = case
        when job.cost_credits > 0 and job.charged_at is not null and job.refunded_at is null then timezone('utc', now())
        else job.refunded_at
      end
    where job.id = v_job.id;

    v_failed_count := v_failed_count + 1;
  end loop;

  return query select v_requeued_count, v_failed_count, v_refunded_count;
end;
$$;

drop policy if exists "generated_videos_gpu_worker_insert_owned_output" on storage.objects;
create policy "generated_videos_gpu_worker_insert_owned_output"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'generated-videos'
  and public.is_gpu_worker()
  and (storage.filename(name) in ('output.mp4', 'output.webm'))
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1
    from public.video_jobs job
    where job.user_id::text = (storage.foldername(name))[1]
      and job.id::text = (storage.foldername(name))[2]
      and job.status = 'processing'
      and job.worker_id = auth.uid()::text
  )
);

revoke all on function public.claim_next_video_job(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_video_job(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_video_job(uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.fail_video_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.requeue_stale_video_jobs() from public, anon, authenticated;

grant execute on function public.claim_next_video_job(text, integer) to authenticated, service_role;
grant execute on function public.heartbeat_video_job(uuid, text, integer, integer) to authenticated, service_role;
grant execute on function public.complete_video_job(uuid, text, text, bigint, text) to authenticated, service_role;
grant execute on function public.fail_video_job(uuid, text, text) to authenticated, service_role;
grant execute on function public.requeue_stale_video_jobs() to authenticated, service_role;
