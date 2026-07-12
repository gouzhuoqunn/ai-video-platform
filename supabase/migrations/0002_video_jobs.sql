-- AI Video Platform
-- 迁移 0002：真实视频任务记录与排队骨架
-- 执行位置：Supabase Dashboard -> SQL Editor
-- 注意：本文件不包含任何密钥，不需要 service_role key。
-- 本阶段只创建排队任务记录，不连接 GPU，不扣积分，不上传文件。

create extension if not exists pgcrypto;

create table if not exists public.video_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  prompt text not null,
  model_key text not null,
  status text not null default 'queued',
  duration_seconds integer not null default 5,
  resolution text not null default '720p',
  cost_credits integer not null default 0,
  reference_image_path text,
  output_video_url text,
  thumbnail_url text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  constraint video_jobs_status_check check (
    status in ('queued', 'processing', 'succeeded', 'failed', 'canceled')
  ),
  constraint video_jobs_prompt_length_check check (
    char_length(btrim(prompt)) between 1 and 2000
  ),
  constraint video_jobs_duration_range_check check (
    duration_seconds > 0 and duration_seconds <= 15
  ),
  constraint video_jobs_cost_non_negative_check check (cost_credits >= 0),
  constraint video_jobs_v1_duration_check check (duration_seconds = 5),
  constraint video_jobs_v1_resolution_check check (resolution in ('480p', '720p')),
  constraint video_jobs_v1_model_key_check check (
    model_key in ('lightweight-video', 'standard-video')
  )
);

create index if not exists video_jobs_user_id_idx
  on public.video_jobs(user_id);

create index if not exists video_jobs_status_idx
  on public.video_jobs(status);

create index if not exists video_jobs_created_at_idx
  on public.video_jobs(created_at desc);

create index if not exists video_jobs_user_id_created_at_idx
  on public.video_jobs(user_id, created_at desc);

drop trigger if exists set_video_jobs_updated_at on public.video_jobs;
create trigger set_video_jobs_updated_at
before update on public.video_jobs
for each row
execute function public.set_updated_at();

alter table public.video_jobs enable row level security;

revoke all on public.video_jobs from anon, authenticated;
grant select on public.video_jobs to authenticated;

drop policy if exists "video_jobs_select_own" on public.video_jobs;
create policy "video_jobs_select_own"
on public.video_jobs
for select
to authenticated
using ((select auth.uid()) = user_id);

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
  created_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
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
  v_cost_credits integer := 0;
  v_active_count integer;
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
  elsif v_model_key = 'standard-video' then
    v_resolution := '720p';
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

  insert into public.video_jobs (
    user_id,
    prompt,
    model_key,
    status,
    duration_seconds,
    resolution,
    cost_credits
  )
  values (
    v_user_id,
    v_prompt,
    v_model_key,
    'queued',
    v_duration_seconds,
    v_resolution,
    v_cost_credits
  )
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
    v_job.created_at,
    v_job.updated_at,
    v_job.started_at,
    v_job.completed_at;
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
  created_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing_status text;
  v_job public.video_jobs%rowtype;
begin
  if v_user_id is null then
    raise exception '请先登录后再取消视频任务。';
  end if;

  select existing.status
  into v_existing_status
  from public.video_jobs existing
  where existing.id = p_job_id
    and existing.user_id = v_user_id;

  if v_existing_status is null then
    raise exception '任务不存在或无权操作。';
  end if;

  if v_existing_status = 'canceled' then
    raise exception '任务已取消，不能重复取消。';
  end if;

  if v_existing_status <> 'queued' then
    raise exception '只有排队中的任务可以取消。';
  end if;

  update public.video_jobs
  set status = 'canceled'
  where video_jobs.id = p_job_id
    and video_jobs.user_id = v_user_id
    and video_jobs.status = 'queued'
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
    v_job.created_at,
    v_job.updated_at,
    v_job.started_at,
    v_job.completed_at;
end;
$$;

revoke all on function public.create_video_job(text, text) from public, anon;
revoke all on function public.cancel_video_job(uuid) from public, anon;

grant execute on function public.create_video_job(text, text) to authenticated;
grant execute on function public.cancel_video_job(uuid) to authenticated;
