-- AI Video Platform
-- 迁移 0004：远程集成测试暴露的 RPC 变量名冲突修复
-- 执行位置：Supabase Dashboard -> SQL Editor
-- 注意：本文件不包含任何密钥。不要在 SQL 中写入 service_role 或 Secret key。
-- 本迁移只重新定义应用 RPC，不连接真实 GPU，不创建公开存储桶。

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
#variable_conflict use_column
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
#variable_conflict use_column
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

revoke all on function public.create_video_job(text, text) from public, anon;
revoke all on function public.cancel_video_job(uuid) from public, anon;
grant execute on function public.create_video_job(text, text) to authenticated;
grant execute on function public.cancel_video_job(uuid) to authenticated;
