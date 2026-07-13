-- AI Video Platform
-- Migration 0008: pending confirmation tasks, batch operations, regeneration metadata,
-- soft delete, queue priority, and thumbnail path support.
-- Do not put secrets in SQL.

alter table public.video_jobs
  add column if not exists priority text not null default 'normal',
  add column if not exists confirmed_at timestamptz,
  add column if not exists queued_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists deletion_cleanup_status text not null default 'none',
  add column if not exists deletion_cleanup_error text,
  add column if not exists thumbnail_path text,
  add column if not exists thumbnail_status text not null default 'pending',
  add column if not exists generation_group_id uuid,
  add column if not exists generation_number integer not null default 1,
  add column if not exists parent_job_id uuid references public.video_jobs(id) on delete set null;

alter table public.video_jobs
  drop constraint if exists video_jobs_status_check;

alter table public.video_jobs
  add constraint video_jobs_status_check check (
    status in ('pending_confirmation', 'queued', 'processing', 'succeeded', 'failed', 'canceled')
  );

alter table public.video_jobs
  drop constraint if exists video_jobs_priority_check;
alter table public.video_jobs
  add constraint video_jobs_priority_check check (priority in ('normal', 'urgent'));

alter table public.video_jobs
  drop constraint if exists video_jobs_generation_number_check;
alter table public.video_jobs
  add constraint video_jobs_generation_number_check check (generation_number >= 1);

alter table public.video_jobs
  drop constraint if exists video_jobs_thumbnail_status_check;
alter table public.video_jobs
  add constraint video_jobs_thumbnail_status_check check (thumbnail_status in ('pending', 'ready', 'failed', 'default'));

alter table public.video_jobs
  drop constraint if exists video_jobs_deletion_cleanup_status_check;
alter table public.video_jobs
  add constraint video_jobs_deletion_cleanup_status_check check (deletion_cleanup_status in ('none', 'pending', 'complete', 'retry'));

update public.video_jobs
set
  generation_group_id = coalesce(generation_group_id, id),
  queued_at = case when status in ('queued', 'processing', 'succeeded', 'failed', 'canceled') then coalesce(queued_at, created_at) else queued_at end,
  confirmed_at = case when status in ('queued', 'processing', 'succeeded', 'failed', 'canceled') then coalesce(confirmed_at, created_at) else confirmed_at end
where generation_group_id is null
   or queued_at is null
   or confirmed_at is null;

update public.video_jobs
set status = 'pending_confirmation'
where status = 'queued'
  and worker_id is null
  and started_at is null
  and lease_expires_at is null
  and attempt_count = 0
  and deleted_at is null;

create index if not exists video_jobs_user_visible_created_idx
  on public.video_jobs(user_id, created_at desc)
  where deleted_at is null;

create index if not exists video_jobs_pending_confirmation_idx
  on public.video_jobs(user_id, created_at desc)
  where status = 'pending_confirmation' and deleted_at is null;

drop index if exists video_jobs_worker_queue_idx;
create index video_jobs_worker_queue_idx
  on public.video_jobs(priority desc, confirmed_at asc, created_at asc)
  where status = 'queued' and attempt_count < max_attempts and deleted_at is null;

create table if not exists public.gpu_autorent_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'waiting',
  priority text not null default 'normal',
  job_ids uuid[] not null default '{}',
  min_effective_hourly_usd numeric(10,4) not null default 0,
  max_effective_hourly_usd numeric(10,4) not null default 0.70,
  selected_server_id text,
  active_order_id text,
  provider text not null default 'mock',
  real_create_enabled boolean not null default false,
  failure_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  cancelled_at timestamptz,
  assigned_at timestamptz,
  constraint gpu_autorent_status_check check (status in ('waiting', 'searching', 'candidate_found', 'provisioning', 'assigned', 'failed', 'cancelled')),
  constraint gpu_autorent_priority_check check (priority in ('normal', 'urgent')),
  constraint gpu_autorent_price_check check (min_effective_hourly_usd >= 0 and min_effective_hourly_usd <= max_effective_hourly_usd and max_effective_hourly_usd <= 0.70)
);

drop trigger if exists set_gpu_autorent_requests_updated_at on public.gpu_autorent_requests;
create trigger set_gpu_autorent_requests_updated_at
before update on public.gpu_autorent_requests
for each row
execute function public.set_updated_at();

alter table public.gpu_autorent_requests enable row level security;
revoke all on public.gpu_autorent_requests from anon, authenticated;
grant select on public.gpu_autorent_requests to authenticated;

drop policy if exists "gpu_autorent_requests_select_own" on public.gpu_autorent_requests;
create policy "gpu_autorent_requests_select_own"
on public.gpu_autorent_requests
for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.job_result_path(p_user_id uuid, p_job_id uuid, p_filename text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id::text || '/' || p_job_id::text || '/' || p_filename;
$$;

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
  v_pending_count integer;
  v_balance integer;
  v_job public.video_jobs%rowtype;
begin
  if v_user_id is null then
    raise exception 'Please sign in before creating a video job.';
  end if;

  if char_length(v_prompt) < 1 then
    raise exception 'Prompt cannot be empty.';
  end if;

  if char_length(v_prompt) > 2000 then
    raise exception 'Prompt cannot exceed 2000 characters.';
  end if;

  if v_model_key = 'lightweight-video' then
    v_resolution := '480p';
    v_cost_credits := 5;
  elsif v_model_key = 'standard-video' then
    v_resolution := '720p';
    v_cost_credits := 10;
  else
    raise exception 'This model is not available.';
  end if;

  select count(*)
  into v_pending_count
  from public.video_jobs existing
  where existing.user_id = v_user_id
    and existing.deleted_at is null
    and existing.status in ('pending_confirmation', 'queued', 'processing');

  if v_pending_count >= 20 then
    raise exception 'Too many unfinished jobs. Please confirm, delete, or wait before adding more.';
  end if;

  select account.balance
  into v_balance
  from public.credit_accounts account
  where account.user_id = v_user_id
  for update;

  if v_balance is null then
    raise exception 'Credit account not found.';
  end if;

  if v_balance < v_cost_credits then
    raise exception 'Insufficient credits. Current balance is %, this job needs % credits.', v_balance, v_cost_credits;
  end if;

  insert into public.video_jobs (
    user_id, prompt, model_key, status, duration_seconds, resolution, cost_credits,
    progress, charged_at, priority, generation_group_id, generation_number, thumbnail_status
  )
  values (
    v_user_id, v_prompt, v_model_key, 'pending_confirmation', v_duration_seconds, v_resolution, v_cost_credits,
    0, timezone('utc', now()), 'normal', gen_random_uuid(), 1, 'pending'
  )
  returning *
  into v_job;

  update public.video_jobs
  set generation_group_id = v_job.id
  where video_jobs.id = v_job.id
  returning *
  into v_job;

  update public.credit_accounts account
  set balance = account.balance - v_cost_credits
  where account.user_id = v_user_id
  returning account.balance
  into v_balance;

  insert into public.credit_transactions (
    user_id, amount, transaction_type, description, reference_id
  )
  values (
    v_user_id, -v_cost_credits, 'generation_charge', 'Video job credit charge', v_job.id
  )
  on conflict (user_id, transaction_type, reference_id)
  where reference_id is not null
  do nothing;

  return query
  select
    v_job.id, v_job.user_id, v_job.prompt, v_job.model_key, v_job.status, v_job.duration_seconds,
    v_job.resolution, v_job.cost_credits, v_job.reference_image_path, v_job.output_video_url,
    v_job.thumbnail_url, v_job.error_message, v_job.progress, v_job.worker_id, v_job.lease_expires_at,
    v_job.attempt_count, v_job.max_attempts, v_job.output_video_path, v_job.output_size_bytes,
    v_job.output_mime_type, v_job.charged_at, v_job.refunded_at, v_job.created_at, v_job.updated_at,
    v_job.started_at, v_job.completed_at, v_balance;
end;
$$;

create or replace function public.confirm_video_jobs(
  p_job_ids uuid[],
  p_urgent boolean default false
)
returns table (confirmed_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Please sign in before confirming jobs.';
  end if;

  update public.video_jobs job
  set
    status = 'queued',
    priority = case when p_urgent then 'urgent' else job.priority end,
    confirmed_at = timezone('utc', now()),
    queued_at = timezone('utc', now()),
    progress = 0,
    worker_id = null,
    lease_expires_at = null
  where job.user_id = v_user_id
    and job.deleted_at is null
    and job.status = 'pending_confirmation'
    and job.id = any(coalesce(p_job_ids, '{}'::uuid[]));

  get diagnostics v_count = row_count;
  return query select v_count;
end;
$$;

create or replace function public.mark_video_jobs_urgent(p_job_ids uuid[])
returns table (updated_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Please sign in before marking urgent jobs.';
  end if;

  update public.video_jobs job
  set
    priority = 'urgent',
    status = case when job.status = 'pending_confirmation' then 'queued' else job.status end,
    confirmed_at = case when job.confirmed_at is null then timezone('utc', now()) else job.confirmed_at end,
    queued_at = case when job.status = 'pending_confirmation' then timezone('utc', now()) else job.queued_at end
  where job.user_id = v_user_id
    and job.deleted_at is null
    and job.status in ('pending_confirmation', 'queued')
    and job.id = any(coalesce(p_job_ids, '{}'::uuid[]));

  get diagnostics v_count = row_count;
  return query select v_count;
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
    raise exception 'Please sign in before canceling a job.';
  end if;

  select *
  into v_job
  from public.video_jobs existing
  where existing.id = p_job_id
    and existing.user_id = v_user_id
    and existing.deleted_at is null
  for update;

  if v_job.id is null then
    raise exception 'Job not found or not allowed.';
  end if;

  if v_job.status not in ('pending_confirmation', 'queued') then
    raise exception 'Only unstarted jobs can be canceled.';
  end if;

  select account.balance
  into v_balance
  from public.credit_accounts account
  where account.user_id = v_user_id
  for update;

  if v_job.cost_credits > 0 and v_job.charged_at is not null and v_job.refunded_at is null then
    insert into public.credit_transactions (user_id, amount, transaction_type, description, reference_id)
    values (v_user_id, v_job.cost_credits, 'generation_refund', 'Unstarted video job refund', v_job.id)
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
    v_job.id, v_job.user_id, v_job.prompt, v_job.model_key, v_job.status, v_job.duration_seconds,
    v_job.resolution, v_job.cost_credits, v_job.reference_image_path, v_job.output_video_url,
    v_job.thumbnail_url, v_job.error_message, v_job.progress, v_job.worker_id, v_job.lease_expires_at,
    v_job.attempt_count, v_job.max_attempts, v_job.output_video_path, v_job.output_size_bytes,
    v_job.output_mime_type, v_job.charged_at, v_job.refunded_at, v_job.created_at, v_job.updated_at,
    v_job.started_at, v_job.completed_at, coalesce(v_balance, 0);
end;
$$;

create or replace function public.soft_delete_video_jobs(p_job_ids uuid[])
returns table (deleted_count integer, cleanup_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.video_jobs%rowtype;
  v_deleted integer := 0;
  v_cleanup integer := 0;
begin
  if v_user_id is null then
    raise exception 'Please sign in before deleting jobs.';
  end if;

  for v_job in
    select *
    from public.video_jobs existing
    where existing.user_id = v_user_id
      and existing.deleted_at is null
      and existing.id = any(coalesce(p_job_ids, '{}'::uuid[]))
    for update
  loop
    if v_job.status = 'processing' then
      raise exception 'Processing jobs must be safely canceled before deletion.';
    end if;

    if v_job.status in ('pending_confirmation', 'queued') then
      perform * from public.cancel_video_job(v_job.id);
    end if;

    update public.video_jobs job
    set
      deleted_at = timezone('utc', now()),
      deletion_cleanup_status = case when job.output_video_path is not null or job.thumbnail_path is not null then 'pending' else 'none' end
    where job.id = v_job.id;

    v_deleted := v_deleted + 1;
    if v_job.output_video_path is not null or v_job.thumbnail_path is not null then
      v_cleanup := v_cleanup + 1;
    end if;
  end loop;

  return query select v_deleted, v_cleanup;
end;
$$;

create or replace function public.regenerate_video_job(p_job_id uuid)
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
  v_source public.video_jobs%rowtype;
  v_new public.video_jobs%rowtype;
  v_balance integer;
  v_next_number integer;
  v_group uuid;
begin
  if v_user_id is null then
    raise exception 'Please sign in before regenerating.';
  end if;

  select *
  into v_source
  from public.video_jobs existing
  where existing.id = p_job_id
    and existing.user_id = v_user_id
    and existing.deleted_at is null
  for update;

  if v_source.id is null then
    raise exception 'Job not found or not allowed.';
  end if;

  select account.balance
  into v_balance
  from public.credit_accounts account
  where account.user_id = v_user_id
  for update;

  if v_balance < v_source.cost_credits then
    raise exception 'Insufficient credits for regeneration.';
  end if;

  v_group := coalesce(v_source.generation_group_id, v_source.id);
  select coalesce(max(generation_number), 0) + 1
  into v_next_number
  from public.video_jobs
  where generation_group_id = v_group;

  insert into public.video_jobs (
    user_id, prompt, model_key, status, duration_seconds, resolution, cost_credits,
    reference_image_path, progress, charged_at, priority, generation_group_id, generation_number,
    parent_job_id, thumbnail_status
  )
  values (
    v_user_id, v_source.prompt, v_source.model_key, 'pending_confirmation', v_source.duration_seconds,
    v_source.resolution, v_source.cost_credits, v_source.reference_image_path, 0, timezone('utc', now()),
    'normal', v_group, v_next_number, v_source.id, 'pending'
  )
  returning *
  into v_new;

  update public.credit_accounts account
  set balance = account.balance - v_new.cost_credits
  where account.user_id = v_user_id
  returning account.balance
  into v_balance;

  insert into public.credit_transactions (user_id, amount, transaction_type, description, reference_id)
  values (v_user_id, -v_new.cost_credits, 'generation_charge', 'Video regeneration credit charge', v_new.id)
  on conflict (user_id, transaction_type, reference_id)
  where reference_id is not null
  do nothing;

  return query
  select
    v_new.id, v_new.user_id, v_new.prompt, v_new.model_key, v_new.status, v_new.duration_seconds,
    v_new.resolution, v_new.cost_credits, v_new.reference_image_path, v_new.output_video_url,
    v_new.thumbnail_url, v_new.error_message, v_new.progress, v_new.worker_id, v_new.lease_expires_at,
    v_new.attempt_count, v_new.max_attempts, v_new.output_video_path, v_new.output_size_bytes,
    v_new.output_mime_type, v_new.charged_at, v_new.refunded_at, v_new.created_at, v_new.updated_at,
    v_new.started_at, v_new.completed_at, v_balance;
end;
$$;

create or replace function public.create_gpu_autorent_request(
  p_job_ids uuid[],
  p_priority text default 'normal',
  p_min_effective_hourly_usd numeric default 0,
  p_max_effective_hourly_usd numeric default 0.70
)
returns public.gpu_autorent_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.gpu_autorent_requests%rowtype;
  v_job_count integer;
begin
  if v_user_id is null then
    raise exception 'Please sign in before requesting GPU auto-rent.';
  end if;

  if p_priority not in ('normal', 'urgent') then
    raise exception 'Invalid priority.';
  end if;

  if p_min_effective_hourly_usd < 0 or p_min_effective_hourly_usd > p_max_effective_hourly_usd or p_max_effective_hourly_usd > 0.70 then
    raise exception 'Invalid GPU price filter.';
  end if;

  select count(*)
  into v_job_count
  from public.video_jobs job
  where job.user_id = v_user_id
    and job.deleted_at is null
    and job.status = 'queued'
    and job.id = any(coalesce(p_job_ids, '{}'::uuid[]));

  if v_job_count = 0 then
    raise exception 'No queued jobs for GPU auto-rent.';
  end if;

  insert into public.gpu_autorent_requests (
    user_id, status, priority, job_ids, min_effective_hourly_usd, max_effective_hourly_usd,
    provider, real_create_enabled
  )
  values (
    v_user_id, 'waiting', p_priority, coalesce(p_job_ids, '{}'::uuid[]),
    p_min_effective_hourly_usd, p_max_effective_hourly_usd, 'mock', false
  )
  returning *
  into v_request;

  return v_request;
end;
$$;

create or replace function public.cancel_gpu_autorent_request(p_request_id uuid)
returns public.gpu_autorent_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.gpu_autorent_requests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Please sign in before canceling GPU auto-rent.';
  end if;

  update public.gpu_autorent_requests request
  set status = 'cancelled', cancelled_at = timezone('utc', now())
  where request.id = p_request_id
    and request.user_id = v_user_id
    and request.status in ('waiting', 'searching', 'candidate_found', 'provisioning')
  returning *
  into v_request;

  if v_request.id is null then
    raise exception 'Auto-rent request not found or already closed.';
  end if;

  return v_request;
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
      and queued.deleted_at is null
      and queued.attempt_count < queued.max_attempts
    order by
      case queued.priority when 'urgent' then 0 else 1 end,
      queued.confirmed_at asc nulls last,
      queued.created_at asc
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
    job.id, job.user_id, job.prompt, job.model_key, job.status, job.duration_seconds,
    job.resolution, job.cost_credits, job.progress, job.attempt_count, job.max_attempts,
    job.output_video_path, job.output_mime_type, job.worker_id, job.lease_expires_at,
    job.created_at, job.started_at;
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
  v_thumbnail_path text;
begin
  if v_output_mime_type not in ('video/mp4', 'video/webm') then
    raise exception 'Unsupported output video type.';
  end if;

  select *
  into v_existing
  from public.video_jobs existing
  where existing.id = p_job_id
  for update;

  if v_existing.id is null then
    raise exception 'Video job not found.';
  end if;

  if v_existing.status = 'succeeded' then
    return v_existing;
  end if;

  v_expected_path := public.job_result_path(
    v_existing.user_id,
    v_existing.id,
    case when v_output_mime_type = 'video/webm' then 'output.webm' else 'output.mp4' end
  );
  v_thumbnail_path := public.job_result_path(v_existing.user_id, v_existing.id, 'thumbnail.jpg');

  if v_output_video_path <> v_expected_path then
    raise exception 'Output video path does not match job ownership rules.';
  end if;

  if p_output_size_bytes is null or p_output_size_bytes < 0 then
    raise exception 'Output video size is invalid.';
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
    output_video_url = null,
    thumbnail_path = coalesce(job.thumbnail_path, v_thumbnail_path),
    thumbnail_status = case when job.thumbnail_status in ('ready', 'default') then job.thumbnail_status else 'ready' end
  where job.id = p_job_id
    and job.worker_id = v_worker_id
    and job.status = 'processing'
  returning *
  into v_job;

  if v_job.id is null then
    raise exception 'No processing job is held by this worker.';
  end if;

  return v_job;
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
  and (storage.filename(name) in ('output.mp4', 'output.webm', 'thumbnail.jpg', 'thumbnail.webp'))
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

revoke all on function public.confirm_video_jobs(uuid[], boolean) from public, anon;
revoke all on function public.mark_video_jobs_urgent(uuid[]) from public, anon;
revoke all on function public.soft_delete_video_jobs(uuid[]) from public, anon;
revoke all on function public.regenerate_video_job(uuid) from public, anon;
revoke all on function public.create_gpu_autorent_request(uuid[], text, numeric, numeric) from public, anon;
revoke all on function public.cancel_gpu_autorent_request(uuid) from public, anon;

grant execute on function public.confirm_video_jobs(uuid[], boolean) to authenticated;
grant execute on function public.mark_video_jobs_urgent(uuid[]) to authenticated;
grant execute on function public.soft_delete_video_jobs(uuid[]) to authenticated;
grant execute on function public.regenerate_video_job(uuid) to authenticated;
grant execute on function public.create_gpu_autorent_request(uuid[], text, numeric, numeric) to authenticated;
grant execute on function public.cancel_gpu_autorent_request(uuid) to authenticated;
