-- Immutable, worker-only membership for the first manual silent Wan RTX 4090 path.
create table if not exists public.gpu_execution_batches (
  id uuid primary key,
  status text not null check (status in ('freezing_batch','searching_candidates','creating_order','waiting_for_host','verifying_host','deploying_runtime','restoring_model','starting_worker','waiting_for_worker','running_batch','paused','draining','canceling','completed','failed','canceled')),
  model_key text not null check (model_key = 'video_wan_silent'),
  gpu_class text not null check (gpu_class = 'rtx4090'),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  provider_order_id text,
  state_revision integer not null default 1 check (state_revision > 0)
);

create table if not exists public.gpu_execution_batch_tasks (
  batch_id uuid not null references public.gpu_execution_batches(id) on delete cascade,
  task_id uuid not null references public.video_jobs(id),
  sequence_index integer not null check (sequence_index >= 0),
  attempt_count integer not null check (attempt_count >= 0),
  status text not null default 'pending' check (status in ('pending','claimed','completed','failed','canceled')),
  claimed_worker_id text,
  claimed_at timestamptz,
  completed_at timestamptz,
  failure_classification text,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (batch_id, task_id),
  unique (batch_id, sequence_index)
);

create unique index if not exists gpu_execution_batch_tasks_one_active_task
  on public.gpu_execution_batch_tasks(task_id)
  where status in ('pending','claimed');

alter table public.gpu_execution_batches enable row level security;
alter table public.gpu_execution_batch_tasks enable row level security;

create or replace function public.claim_next_video_job_for_batch(
  p_batch_id uuid,
  p_worker_id text,
  p_expected_model_key text,
  p_expected_gpu_class text,
  p_lease_seconds integer default 300
)
returns table (id uuid, user_id uuid, prompt text, model_key text, status text, duration_seconds integer, resolution text, cost_credits integer, progress integer, attempt_count integer, max_attempts integer, output_video_path text, output_mime_type text, worker_id text, lease_expires_at timestamptz, created_at timestamptz, started_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_worker_id text := public.normalize_worker_id(p_worker_id); v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
begin
  if p_expected_model_key <> 'video_wan_silent' or p_expected_gpu_class <> 'rtx4090' then raise exception 'batch worker identity mismatch'; end if;
  return query
  with next_member as (
    select member.task_id
    from public.gpu_execution_batch_tasks member
    join public.gpu_execution_batches batch on batch.id = member.batch_id
    join public.video_jobs job on job.id = member.task_id
    where member.batch_id = p_batch_id and member.status = 'pending'
      and batch.status in ('running_batch','waiting_for_worker') and batch.model_key = p_expected_model_key and batch.gpu_class = p_expected_gpu_class
      and job.status = 'queued' and job.deleted_at is null and job.confirmed_at is not null and job.attempt_count = member.attempt_count
    order by member.sequence_index for update of member skip locked limit 1
  ), claimed_member as (
    update public.gpu_execution_batch_tasks member set status='claimed', claimed_worker_id=v_worker_id, claimed_at=timezone('utc',now())
    from next_member where member.batch_id=p_batch_id and member.task_id=next_member.task_id returning member.task_id
  )
  update public.video_jobs job set status='processing', progress=1, worker_id=v_worker_id, attempt_count=job.attempt_count+1, lease_expires_at=timezone('utc',now())+make_interval(secs=>v_lease), started_at=coalesce(job.started_at,timezone('utc',now()))
  from claimed_member where job.id=claimed_member.task_id
  returning job.id,job.user_id,job.prompt,job.model_key,job.status,job.duration_seconds,job.resolution,job.cost_credits,job.progress,job.attempt_count,job.max_attempts,job.output_video_path,job.output_mime_type,job.worker_id,job.lease_expires_at,job.created_at,job.started_at;
end; $$;

revoke all on function public.claim_next_video_job_for_batch(uuid,text,text,text,integer) from public, anon;
grant execute on function public.claim_next_video_job_for_batch(uuid,text,text,text,integer) to authenticated, service_role;
