-- AI Video Platform
-- Migration 0009: durable long-video projects, five-second segments and attempt history.
-- Additive only. Long-video references are opaque application references, never local absolute paths.

create table if not exists public.long_video_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  overall_prompt text not null default '',
  first_frame_source text not null,
  first_frame_job_id uuid references public.video_jobs(id) on delete set null,
  first_frame_ref text,
  target_duration_seconds integer not null,
  segment_duration_seconds integer not null default 5,
  total_segments integer not null,
  status text not null default 'pending_confirmation',
  next_segment_index integer not null default 0,
  gpu_preference text[] not null default array['rtx4090', 'rtx5090'],
  workflow_profile text not null default 'wan22-remix-14b-i2v-fp8',
  workflow_capability text not null default 'first_frame_text',
  estimated_min_minutes integer not null default 0,
  estimated_max_minutes integer not null default 0,
  estimated_min_cost_usd numeric(10,2) not null default 0,
  estimated_max_cost_usd numeric(10,2) not null default 0,
  final_video_ref text,
  final_thumbnail_ref text,
  merge_status text not null default 'not_ready',
  cleanup_status text not null default 'not_started',
  segment_media_cleaned boolean not null default false,
  approximate_spend_usd numeric(10,4) not null default 0,
  version bigint not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint long_video_duration_check check (
    target_duration_seconds between 5 and 300
    and target_duration_seconds % 5 = 0
    and segment_duration_seconds = 5
    and total_segments = target_duration_seconds / segment_duration_seconds
  ),
  constraint long_video_first_frame_source_check check (first_frame_source in ('upload', 'existing_image', 'pure_prompt')),
  constraint long_video_capability_check check (workflow_capability in ('first_frame_text', 'first_last_frame', 'text_only')),
  constraint long_video_status_check check (status in (
    'pending_confirmation', 'waiting_for_gpu', 'generating', 'awaiting_review',
    'paused', 'awaiting_merge_confirmation', 'merging', 'completed', 'cancelled', 'failed'
  )),
  constraint long_video_merge_status_check check (merge_status in ('not_ready', 'awaiting_confirmation', 'merging', 'completed', 'failed')),
  constraint long_video_cleanup_status_check check (cleanup_status in ('not_started', 'pending', 'completed', 'retry'))
);

create table if not exists public.long_video_segments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.long_video_projects(id) on delete cascade,
  sequence_index integer not null,
  start_second integer not null,
  end_second integer not null,
  prompt text not null default '',
  status text not null default 'pending',
  selected_attempt_id uuid,
  input_frame_ref text,
  output_video_ref text,
  last_frame_ref text,
  approval_state text not null default 'not_ready',
  approval_deadline timestamptz,
  generation_job_id uuid references public.video_jobs(id) on delete set null,
  attempts_count integer not null default 0,
  invalidated_at timestamptz,
  next_request_prepared boolean not null default false,
  version bigint not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (project_id, sequence_index),
  constraint long_video_segment_index_check check (sequence_index >= 0),
  constraint long_video_segment_range_check check (start_second >= 0 and end_second > start_second and end_second - start_second <= 5),
  constraint long_video_segment_status_check check (status in ('pending', 'ready', 'generating', 'awaiting_review', 'accepted', 'invalidated', 'paused', 'failed')),
  constraint long_video_segment_approval_check check (approval_state in ('not_ready', 'awaiting_review', 'accepted', 'rejected', 'paused', 'timed_out'))
);

create table if not exists public.long_video_segment_attempts (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references public.long_video_segments(id) on delete cascade,
  attempt_number integer not null,
  generation_job_id uuid references public.video_jobs(id) on delete set null,
  status text not null default 'pending',
  source_webm_ref text,
  output_video_ref text,
  thumbnail_ref text,
  last_frame_ref text,
  evidence_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  unique (segment_id, attempt_number),
  constraint long_video_attempt_number_check check (attempt_number >= 1),
  constraint long_video_attempt_status_check check (status in ('pending', 'running', 'awaiting_review', 'accepted', 'rejected', 'invalidated', 'failed'))
);

alter table public.long_video_segments
  drop constraint if exists long_video_segments_selected_attempt_id_fkey;
alter table public.long_video_segments
  add constraint long_video_segments_selected_attempt_id_fkey
  foreign key (selected_attempt_id) references public.long_video_segment_attempts(id) on delete set null;

create index if not exists long_video_projects_user_updated_idx on public.long_video_projects(user_id, updated_at desc);
create index if not exists long_video_projects_resumable_idx on public.long_video_projects(status, updated_at)
  where status in ('waiting_for_gpu', 'generating', 'awaiting_review', 'paused');
create index if not exists long_video_segments_project_sequence_idx on public.long_video_segments(project_id, sequence_index);
create index if not exists long_video_segments_review_deadline_idx on public.long_video_segments(approval_deadline)
  where status = 'awaiting_review';
create index if not exists long_video_attempts_segment_created_idx on public.long_video_segment_attempts(segment_id, created_at desc);

drop trigger if exists set_long_video_projects_updated_at on public.long_video_projects;
create trigger set_long_video_projects_updated_at before update on public.long_video_projects
for each row execute function public.set_updated_at();
drop trigger if exists set_long_video_segments_updated_at on public.long_video_segments;
create trigger set_long_video_segments_updated_at before update on public.long_video_segments
for each row execute function public.set_updated_at();

alter table public.long_video_projects enable row level security;
alter table public.long_video_segments enable row level security;
alter table public.long_video_segment_attempts enable row level security;

revoke all on public.long_video_projects, public.long_video_segments, public.long_video_segment_attempts from anon, authenticated;
grant select on public.long_video_projects, public.long_video_segments, public.long_video_segment_attempts to authenticated;

drop policy if exists "long_video_projects_select_own" on public.long_video_projects;
create policy "long_video_projects_select_own" on public.long_video_projects for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "long_video_segments_select_own" on public.long_video_segments;
create policy "long_video_segments_select_own" on public.long_video_segments for select to authenticated
using (exists (
  select 1 from public.long_video_projects project
  where project.id = project_id and project.user_id = (select auth.uid())
));
drop policy if exists "long_video_attempts_select_own" on public.long_video_segment_attempts;
create policy "long_video_attempts_select_own" on public.long_video_segment_attempts for select to authenticated
using (exists (
  select 1
  from public.long_video_segments segment
  join public.long_video_projects project on project.id = segment.project_id
  where segment.id = segment_id and project.user_id = (select auth.uid())
));

create or replace function public.create_long_video_project(
  p_title text,
  p_overall_prompt text,
  p_first_frame_source text,
  p_first_frame_ref text,
  p_target_duration_seconds integer,
  p_prompts text[],
  p_gpu_preference text[] default array['rtx4090', 'rtx5090']
)
returns public.long_video_projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.long_video_projects%rowtype;
  v_total integer;
  v_index integer;
begin
  if v_user_id is null then raise exception 'Please sign in before creating a long-video project.'; end if;
  if p_target_duration_seconds < 5 or p_target_duration_seconds > 300 or p_target_duration_seconds % 5 <> 0 then
    raise exception 'Duration must be 5 to 300 seconds in five-second increments.';
  end if;
  if p_first_frame_source not in ('upload', 'existing_image', 'pure_prompt') then raise exception 'Invalid first-frame source.'; end if;
  if p_first_frame_source <> 'pure_prompt' and coalesce(btrim(p_first_frame_ref), '') = '' then raise exception 'A first-frame reference is required.'; end if;
  v_total := p_target_duration_seconds / 5;
  if coalesce(array_length(p_prompts, 1), 0) <> v_total then raise exception 'Prompt count must match the segment count.'; end if;

  insert into public.long_video_projects (
    user_id, title, overall_prompt, first_frame_source, first_frame_ref,
    target_duration_seconds, total_segments, gpu_preference
  ) values (
    v_user_id, left(btrim(p_title), 120), left(btrim(coalesce(p_overall_prompt, '')), 2000),
    p_first_frame_source, nullif(btrim(coalesce(p_first_frame_ref, '')), ''),
    p_target_duration_seconds, v_total, coalesce(p_gpu_preference, array['rtx4090', 'rtx5090'])
  ) returning * into v_project;

  for v_index in 0..v_total - 1 loop
    insert into public.long_video_segments (
      project_id, sequence_index, start_second, end_second, prompt, input_frame_ref
    ) values (
      v_project.id, v_index, v_index * 5, least((v_index + 1) * 5, p_target_duration_seconds),
      left(btrim(coalesce(p_prompts[v_index + 1], '')), 2000),
      case when v_index = 0 then v_project.first_frame_ref else null end
    );
  end loop;
  return v_project;
end;
$$;

create or replace function public.update_long_video_segment_prompt(
  p_segment_id uuid,
  p_prompt text,
  p_expected_version bigint
)
returns public.long_video_segments
language plpgsql
security definer
set search_path = ''
as $$
declare v_segment public.long_video_segments%rowtype;
begin
  update public.long_video_segments segment
  set prompt = left(btrim(coalesce(p_prompt, '')), 2000), version = version + 1
  where segment.id = p_segment_id
    and segment.version = p_expected_version
    and segment.status in ('pending', 'ready', 'invalidated')
    and exists (
      select 1 from public.long_video_projects project
      where project.id = segment.project_id and project.user_id = auth.uid()
    )
  returning * into v_segment;
  if v_segment.id is null then raise exception 'Long-video segment changed or is not editable.'; end if;
  return v_segment;
end;
$$;

create or replace function public.review_long_video_segment(
  p_segment_id uuid,
  p_action text,
  p_expected_project_version bigint,
  p_expected_segment_version bigint
)
returns public.long_video_projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_segment public.long_video_segments%rowtype;
  v_project public.long_video_projects%rowtype;
begin
  select segment.* into v_segment
  from public.long_video_segments segment
  join public.long_video_projects project on project.id = segment.project_id
  where segment.id = p_segment_id and project.user_id = auth.uid()
  for update of segment;
  if v_segment.id is null then raise exception 'Long-video segment not found.'; end if;
  select * into v_project from public.long_video_projects where id = v_segment.project_id for update;
  if v_project.version <> p_expected_project_version or v_segment.version <> p_expected_segment_version then
    raise exception 'Long-video review already changed.';
  end if;

  if p_action in ('accept', 'timeout_accept') then
    if v_segment.status <> 'awaiting_review' then raise exception 'Segment is not awaiting review.'; end if;
    update public.long_video_segments
    set status = 'accepted',
        approval_state = case when p_action = 'timeout_accept' then 'timed_out' else 'accepted' end,
        approval_deadline = null, version = version + 1
    where id = v_segment.id;
    update public.long_video_segments
    set status = 'ready', input_frame_ref = v_segment.last_frame_ref, version = version + 1
    where project_id = v_project.id and sequence_index = v_segment.sequence_index + 1;
    update public.long_video_projects
    set next_segment_index = v_segment.sequence_index + 1,
        status = case when v_segment.sequence_index + 1 >= total_segments then 'awaiting_merge_confirmation' else 'waiting_for_gpu' end,
        merge_status = case when v_segment.sequence_index + 1 >= total_segments then 'awaiting_confirmation' else merge_status end,
        version = version + 1
    where id = v_project.id returning * into v_project;
  elsif p_action = 'regenerate' then
    update public.long_video_segments
    set status = 'invalidated', selected_attempt_id = null, output_video_ref = null, last_frame_ref = null,
        approval_state = 'rejected', approval_deadline = null, invalidated_at = timezone('utc', now()),
        next_request_prepared = false, version = version + 1
    where project_id = v_project.id and sequence_index >= v_segment.sequence_index;
    update public.long_video_segment_attempts attempt
    set status = 'invalidated'
    where attempt.segment_id in (
      select id from public.long_video_segments
      where project_id = v_project.id and sequence_index >= v_segment.sequence_index
    ) and attempt.status in ('accepted', 'awaiting_review');
    update public.long_video_projects
    set next_segment_index = v_segment.sequence_index, status = 'waiting_for_gpu',
        merge_status = 'not_ready', version = version + 1
    where id = v_project.id returning * into v_project;
  elsif p_action = 'pause' then
    update public.long_video_segments
    set status = 'paused', approval_state = 'paused', approval_deadline = null, version = version + 1
    where id = v_segment.id;
    update public.long_video_projects set status = 'paused', version = version + 1
    where id = v_project.id returning * into v_project;
  else
    raise exception 'Invalid long-video review action.';
  end if;
  return v_project;
end;
$$;

revoke all on function public.create_long_video_project(text, text, text, text, integer, text[], text[]) from public, anon;
revoke all on function public.update_long_video_segment_prompt(uuid, text, bigint) from public, anon;
revoke all on function public.review_long_video_segment(uuid, text, bigint, bigint) from public, anon;
grant execute on function public.create_long_video_project(text, text, text, text, integer, text[], text[]) to authenticated;
grant execute on function public.update_long_video_segment_prompt(uuid, text, bigint) to authenticated;
grant execute on function public.review_long_video_segment(uuid, text, bigint, bigint) to authenticated;
