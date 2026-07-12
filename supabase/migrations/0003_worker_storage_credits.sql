-- AI Video Platform
-- 迁移 0003：Worker、私有存储和真实积分扣费/退款基础
-- 执行位置：Supabase Dashboard -> SQL Editor
-- 注意：本文件不包含任何密钥。不要在 SQL 中写入 service_role 或 Secret key。
-- 本迁移不会连接真实 GPU，不会部署模型，不会创建公开存储桶。

create extension if not exists pgcrypto;

alter table public.video_jobs
  add column if not exists progress integer not null default 0,
  add column if not exists worker_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists output_video_path text,
  add column if not exists output_size_bytes bigint,
  add column if not exists output_mime_type text,
  add column if not exists charged_at timestamptz,
  add column if not exists refunded_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'video_jobs_progress_range_check'
  ) then
    alter table public.video_jobs
      add constraint video_jobs_progress_range_check check (progress between 0 and 100);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'video_jobs_attempt_count_check'
  ) then
    alter table public.video_jobs
      add constraint video_jobs_attempt_count_check check (attempt_count >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'video_jobs_max_attempts_check'
  ) then
    alter table public.video_jobs
      add constraint video_jobs_max_attempts_check check (max_attempts between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'video_jobs_output_size_check'
  ) then
    alter table public.video_jobs
      add constraint video_jobs_output_size_check check (output_size_bytes is null or output_size_bytes >= 0);
  end if;
end;
$$;

create index if not exists video_jobs_worker_queue_idx
  on public.video_jobs(created_at asc)
  where status = 'queued' and attempt_count < max_attempts;

create index if not exists video_jobs_lease_expires_at_idx
  on public.video_jobs(lease_expires_at)
  where lease_expires_at is not null;

create index if not exists video_jobs_status_created_at_idx
  on public.video_jobs(status, created_at desc);

create index if not exists video_jobs_user_id_created_at_v2_idx
  on public.video_jobs(user_id, created_at desc);

create unique index if not exists credit_transactions_unique_reference_type_idx
  on public.credit_transactions(user_id, transaction_type, reference_id)
  where reference_id is not null;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'generated-videos',
  'generated-videos',
  false,
  524288000,
  array['video/mp4', 'video/webm']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 524288000,
  allowed_mime_types = array['video/mp4', 'video/webm'];

drop policy if exists "generated_videos_select_own" on storage.objects;
create policy "generated_videos_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'generated-videos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "generated_videos_no_client_insert" on storage.objects;
drop policy if exists "generated_videos_no_client_update" on storage.objects;
drop policy if exists "generated_videos_no_client_delete" on storage.objects;

revoke insert, update, delete on storage.objects from anon, authenticated;

drop function if exists public.create_video_job(text, text);
create or replace function public.create_video_job(
  p_prompt text,
  p_model_key text
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
  reference_image_path text,
  output_video_url text,
  thumbnail_url text,
  error_message text,
  progress integer,
  worker_id text,
  lease_expires_at timestamptz,
  attempt_count integer,
  max_attempts integer,
  output_video_path text,
  output_size_bytes bigint,
  output_mime_type text,
  charged_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_balance integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_prompt text := btrim(coalesce(p_prompt, ''));
  v_model_key text := btrim(coalesce(p_model_key, ''));
  v_duration_seconds integer := 5;
  v_resolution text;
  v_cost_credits integer;
  v_active_count integer;
  v_balance integer;
  v_job public.video_jobs%rowtype;
begin
  if v_user_id is null then
    raise exception '请先登录后再提交视频任务。';
  end if;

  if char_length(v_prompt) < 1 then
    raise exception '提示词不能为空。';
  end if;

  if char_length(v_prompt) > 2000 then
    raise exception '提示词不能超过2000个字符。';
  end if;

  if v_model_key = 'lightweight-video' then
    v_resolution := '480p';
    v_cost_credits := 5;
  elsif v_model_key = 'standard-video' then
    v_resolution := '720p';
    v_cost_credits := 10;
  else
    raise exception '当前模型不可用。请选择轻量视频模型或标准视频模型。';
  end if;

  select count(*)
  into v_active_count
  from public.video_jobs existing
  where existing.user_id = v_user_id
    and existing.status in ('queued', 'processing');

  if v_active_count >= 3 then
    raise exception '当前已有3个排队中或生成中的任务，请等待完成或取消后再提交。';
  end if;

  select account.balance
  into v_balance
  from public.credit_accounts account
  where account.user_id = v_user_id
  for update;

  if v_balance is null then
    raise exception '没有找到积分账户。请确认注册初始化迁移已经执行。';
  end if;

  if v_balance < v_cost_credits then
    raise exception '积分不足。当前余额为%积分，本次任务需要%积分。', v_balance, v_cost_credits;
  end if;

  insert into public.video_jobs (
    user_id,
    prompt,
    model_key,
    status,
    duration_seconds,
    resolution,
    cost_credits,
    progress,
    charged_at
  )
  values (
    v_user_id,
    v_prompt,
    v_model_key,
    'queued',
    v_duration_seconds,
    v_resolution,
    v_cost_credits,
    0,
    timezone('utc', now())
  )
  returning *
  into v_job;

  update public.credit_accounts account
  set balance = account.balance - v_cost_credits
  where account.user_id = v_user_id
  returning account.balance
  into v_balance;

  insert into public.credit_transactions (
    user_id,
    amount,
    transaction_type,
    description,
    reference_id
  )
  values (
    v_user_id,
    -v_cost_credits,
    'generation_charge',
    '视频任务创建扣除积分',
    v_job.id
  )
  on conflict (user_id, transaction_type, reference_id)
  where reference_id is not null
  do nothing;

  return query
  select
    v_job.id,
    v_job.user_id,
    v_job.prompt,
    v_job.model_key,
    v_job.status,
    v_job.duration_seconds,
    v_job.resolution,
    v_job.cost_credits,
    v_job.reference_image_path,
    v_job.output_video_url,
    v_job.thumbnail_url,
    v_job.error_message,
    v_job.progress,
    v_job.worker_id,
    v_job.lease_expires_at,
    v_job.attempt_count,
    v_job.max_attempts,
    v_job.output_video_path,
    v_job.output_size_bytes,
    v_job.output_mime_type,
    v_job.charged_at,
    v_job.refunded_at,
    v_job.created_at,
    v_job.updated_at,
    v_job.started_at,
    v_job.completed_at,
    v_balance;
end;
$$;

drop function if exists public.cancel_video_job(uuid);
create or replace function public.cancel_video_job(p_job_id uuid)
returns table (
  id uuid,
  user_id uuid,
  prompt text,
  model_key text,
  status text,
  duration_seconds integer,
  resolution text,
  cost_credits integer,
  reference_image_path text,
  output_video_url text,
  thumbnail_url text,
  error_message text,
  progress integer,
  worker_id text,
  lease_expires_at timestamptz,
  attempt_count integer,
  max_attempts integer,
  output_video_path text,
  output_size_bytes bigint,
  output_mime_type text,
  charged_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_balance integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.video_jobs%rowtype;
  v_balance integer;
  v_refund_inserted integer := 0;
begin
  if v_user_id is null then
    raise exception '请先登录后再取消视频任务。';
  end if;

  select *
  into v_job
  from public.video_jobs existing
  where existing.id = p_job_id
    and existing.user_id = v_user_id
  for update;

  if v_job.id is null then
    raise exception '任务不存在或无权操作。';
  end if;

  if v_job.status = 'canceled' then
    raise exception '任务已取消，不能重复取消。';
  end if;

  if v_job.status <> 'queued' then
    raise exception '只有排队中的任务可以取消。';
  end if;

  select account.balance
  into v_balance
  from public.credit_accounts account
  where account.user_id = v_user_id
  for update;

  if v_job.cost_credits > 0 and v_job.charged_at is not null and v_job.refunded_at is null then
    insert into public.credit_transactions (
      user_id,
      amount,
      transaction_type,
      description,
      reference_id
    )
    values (
      v_user_id,
      v_job.cost_credits,
      'generation_refund',
      '取消排队任务退还积分',
      v_job.id
    )
    on conflict (user_id, transaction_type, reference_id)
    where reference_id is not null
    do nothing;

    get diagnostics v_refund_inserted = row_count;

    if v_refund_inserted = 1 then
      update public.credit_accounts account
      set balance = account.balance + v_job.cost_credits
      where account.user_id = v_user_id
      returning account.balance
      into v_balance;
    end if;
  end if;

  update public.video_jobs
  set
    status = 'canceled',
    progress = 0,
    worker_id = null,
    lease_expires_at = null,
    refunded_at = case
      when cost_credits > 0 and charged_at is not null and refunded_at is null then timezone('utc', now())
      else refunded_at
    end
  where video_jobs.id = p_job_id
  returning *
  into v_job;

  return query
  select
    v_job.id,
    v_job.user_id,
    v_job.prompt,
    v_job.model_key,
    v_job.status,
    v_job.duration_seconds,
    v_job.resolution,
    v_job.cost_credits,
    v_job.reference_image_path,
    v_job.output_video_url,
    v_job.thumbnail_url,
    v_job.error_message,
    v_job.progress,
    v_job.worker_id,
    v_job.lease_expires_at,
    v_job.attempt_count,
    v_job.max_attempts,
    v_job.output_video_path,
    v_job.output_size_bytes,
    v_job.output_mime_type,
    v_job.charged_at,
    v_job.refunded_at,
    v_job.created_at,
    v_job.updated_at,
    v_job.started_at,
    v_job.completed_at,
    v_balance;
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
  v_worker_id text := btrim(coalesce(p_worker_id, ''));
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
begin
  if v_worker_id = '' then
    raise exception 'worker_id不能为空。';
  end if;

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
  v_worker_id text := btrim(coalesce(p_worker_id, ''));
  v_progress integer := least(99, greatest(1, coalesce(p_progress, 1)));
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
  v_job public.video_jobs%rowtype;
begin
  if v_worker_id = '' then
    raise exception 'worker_id不能为空。';
  end if;

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
  v_worker_id text := btrim(coalesce(p_worker_id, ''));
  v_output_video_path text := btrim(coalesce(p_output_video_path, ''));
  v_output_mime_type text := btrim(coalesce(p_output_mime_type, 'video/mp4'));
  v_existing public.video_jobs%rowtype;
  v_job public.video_jobs%rowtype;
begin
  if v_worker_id = '' then
    raise exception 'worker_id不能为空。';
  end if;

  if v_output_video_path = '' then
    raise exception '输出视频路径不能为空。';
  end if;

  if p_output_size_bytes is null or p_output_size_bytes < 0 then
    raise exception '输出视频大小不正确。';
  end if;

  if v_output_mime_type not in ('video/mp4', 'video/webm') then
    raise exception '输出视频类型不支持。';
  end if;

  select *
  into v_existing
  from public.video_jobs existing
  where existing.id = p_job_id
  for update;

  if v_existing.status = 'succeeded' then
    return v_existing;
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
  v_worker_id text := btrim(coalesce(p_worker_id, ''));
  v_error_message text := left(btrim(coalesce(p_error_message, '视频生成失败。')), 500);
  v_job public.video_jobs%rowtype;
  v_balance integer;
  v_refund_inserted integer := 0;
begin
  if v_worker_id = '' then
    raise exception 'worker_id不能为空。';
  end if;

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

  select account.balance
  into v_balance
  from public.credit_accounts account
  where account.user_id = v_job.user_id
  for update;

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

revoke all on function public.create_video_job(text, text) from public, anon;
revoke all on function public.cancel_video_job(uuid) from public, anon;
grant execute on function public.create_video_job(text, text) to authenticated;
grant execute on function public.cancel_video_job(uuid) to authenticated;

revoke all on function public.claim_next_video_job(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_video_job(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_video_job(uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.fail_video_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.requeue_stale_video_jobs() from public, anon, authenticated;

grant execute on function public.claim_next_video_job(text, integer) to service_role;
grant execute on function public.heartbeat_video_job(uuid, text, integer, integer) to service_role;
grant execute on function public.complete_video_job(uuid, text, text, bigint, text) to service_role;
grant execute on function public.fail_video_job(uuid, text, text) to service_role;
grant execute on function public.requeue_stale_video_jobs() to service_role;
