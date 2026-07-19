-- Audio Foundation Stage 1: metadata only. No model weights or media bytes are stored in Supabase.

create table if not exists public.voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  language_support text[] not null default '{}',
  manifest_ref text,
  local_pack_ref text,
  status text not null default 'draft',
  source_training_job_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint voice_profiles_name_check check (char_length(btrim(display_name)) between 1 and 120),
  constraint voice_profiles_status_check check (status in ('draft', 'ready', 'archived', 'failed')),
  constraint voice_profiles_local_ref_check check (local_pack_ref is null or local_pack_ref !~ '(^[A-Za-z]:[\\/]|^/|^\\\\|(^|/)\\.\\.(/|$))')
);

create table if not exists public.dialogue_cues (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_job_id uuid references public.video_jobs(id) on delete cascade,
  long_video_project_id uuid references public.long_video_projects(id) on delete cascade,
  long_video_segment_id uuid references public.long_video_segments(id) on delete cascade,
  voice_profile_id uuid references public.voice_profiles(id) on delete restrict,
  speaker_name text,
  cue_text text not null,
  language_code text not null default 'zh-CN',
  start_ms integer not null default 0,
  speed numeric(5,2) not null default 1,
  emotion text,
  volume numeric(5,2) not null default 1,
  cue_index integer not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint dialogue_cues_parent_check check (num_nonnulls(video_job_id, long_video_project_id, long_video_segment_id) = 1),
  constraint dialogue_cues_text_check check (char_length(btrim(cue_text)) between 1 and 4000),
  constraint dialogue_cues_start_check check (start_ms >= 0),
  constraint dialogue_cues_speed_check check (speed between 0.25 and 4),
  constraint dialogue_cues_volume_check check (volume between 0 and 4),
  constraint dialogue_cues_index_check check (cue_index >= 0)
);

create unique index if not exists dialogue_cues_video_order_idx on public.dialogue_cues(video_job_id, cue_index) where video_job_id is not null;
create unique index if not exists dialogue_cues_project_order_idx on public.dialogue_cues(long_video_project_id, cue_index) where long_video_project_id is not null;
create unique index if not exists dialogue_cues_segment_order_idx on public.dialogue_cues(long_video_segment_id, cue_index) where long_video_segment_id is not null;

create table if not exists public.voice_inference_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  video_job_id uuid references public.video_jobs(id) on delete cascade,
  long_video_project_id uuid references public.long_video_projects(id) on delete cascade,
  long_video_segment_id uuid references public.long_video_segments(id) on delete cascade,
  voice_profile_id uuid references public.voice_profiles(id) on delete restrict,
  dialogue_snapshot jsonb not null default '[]'::jsonb,
  source_video_reference text not null,
  status text not null default 'queued',
  progress integer not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  error_detail text,
  resource_wait_reason text,
  cancel_requested_at timestamptz,
  cancelled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint voice_inference_jobs_parent_check check (num_nonnulls(video_job_id, long_video_project_id, long_video_segment_id) = 1),
  constraint voice_inference_jobs_status_check check (status in ('queued', 'waiting_for_resources', 'loading_voice', 'generating', 'muxing', 'succeeded', 'failed', 'canceled')),
  constraint voice_inference_jobs_progress_check check (progress between 0 and 100),
  constraint voice_inference_jobs_attempt_check check (attempt_count >= 0 and max_attempts between 1 and 5),
  constraint voice_inference_jobs_source_ref_check check (source_video_reference !~ '(^[A-Za-z]:[\\/]|^/|^\\\\|(^|/)\\.\\.(/|$))'),
  unique (user_id, idempotency_key)
);

create table if not exists public.audio_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  voice_inference_job_id uuid not null references public.voice_inference_jobs(id) on delete cascade,
  video_job_id uuid references public.video_jobs(id) on delete cascade,
  long_video_project_id uuid references public.long_video_projects(id) on delete cascade,
  long_video_segment_id uuid references public.long_video_segments(id) on delete cascade,
  local_relative_file_ref text not null,
  duration_ms integer,
  sample_rate_hz integer,
  channels integer,
  sha256 text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint audio_revisions_parent_check check (num_nonnulls(video_job_id, long_video_project_id, long_video_segment_id) = 1),
  constraint audio_revisions_file_ref_check check (local_relative_file_ref !~ '(^[A-Za-z]:[\\/]|^/|^\\\\|(^|/)\\.\\.(/|$))'),
  constraint audio_revisions_duration_check check (duration_ms is null or duration_ms >= 0),
  constraint audio_revisions_sample_rate_check check (sample_rate_hz is null or sample_rate_hz > 0),
  constraint audio_revisions_channels_check check (channels is null or channels between 1 and 16),
  constraint audio_revisions_sha_check check (sha256 ~ '^[a-f0-9]{64}$')
);

create table if not exists public.composition_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_job_id uuid references public.video_jobs(id) on delete cascade,
  long_video_project_id uuid references public.long_video_projects(id) on delete cascade,
  long_video_segment_id uuid references public.long_video_segments(id) on delete cascade,
  source_video_reference text not null,
  audio_revision_id uuid references public.audio_revisions(id) on delete restrict,
  muxed_local_relative_file_ref text not null,
  sha256 text not null,
  duration_ms integer,
  width integer,
  height integer,
  created_at timestamptz not null default timezone('utc', now()),
  constraint composition_versions_parent_check check (num_nonnulls(video_job_id, long_video_project_id, long_video_segment_id) = 1),
  constraint composition_versions_source_ref_check check (source_video_reference !~ '(^[A-Za-z]:[\\/]|^/|^\\\\|(^|/)\\.\\.(/|$))'),
  constraint composition_versions_muxed_ref_check check (muxed_local_relative_file_ref !~ '(^[A-Za-z]:[\\/]|^/|^\\\\|(^|/)\\.\\.(/|$))'),
  constraint composition_versions_sha_check check (sha256 ~ '^[a-f0-9]{64}$')
);

create table if not exists public.composition_current_pointers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_job_id uuid references public.video_jobs(id) on delete cascade,
  long_video_project_id uuid references public.long_video_projects(id) on delete cascade,
  long_video_segment_id uuid references public.long_video_segments(id) on delete cascade,
  composition_version_id uuid not null references public.composition_versions(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint composition_current_pointers_parent_check check (num_nonnulls(video_job_id, long_video_project_id, long_video_segment_id) = 1)
);

create unique index if not exists composition_current_video_idx on public.composition_current_pointers(video_job_id) where video_job_id is not null;
create unique index if not exists composition_current_project_idx on public.composition_current_pointers(long_video_project_id) where long_video_project_id is not null;
create unique index if not exists composition_current_segment_idx on public.composition_current_pointers(long_video_segment_id) where long_video_segment_id is not null;

create or replace function public.validate_audio_parent_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.video_job_id is not null and not exists (
    select 1 from public.video_jobs job where job.id = new.video_job_id and job.user_id = new.user_id
  ) then
    raise exception 'Video job does not belong to the audio record owner.';
  end if;
  if new.long_video_project_id is not null and not exists (
    select 1 from public.long_video_projects project where project.id = new.long_video_project_id and project.user_id = new.user_id
  ) then
    raise exception 'Long-video project does not belong to the audio record owner.';
  end if;
  if new.long_video_segment_id is not null and not exists (
    select 1
    from public.long_video_segments segment
    join public.long_video_projects project on project.id = segment.project_id
    where segment.id = new.long_video_segment_id and project.user_id = new.user_id
  ) then
    raise exception 'Long-video segment does not belong to the audio record owner.';
  end if;
  return new;
end;
$$;

create or replace function public.validate_audio_revision_contract()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.voice_inference_jobs job
    where job.id = new.voice_inference_job_id
      and job.user_id = new.user_id
      and job.video_job_id is not distinct from new.video_job_id
      and job.long_video_project_id is not distinct from new.long_video_project_id
      and job.long_video_segment_id is not distinct from new.long_video_segment_id
  ) then
    raise exception 'Audio revision must match its inference job owner and media parent.';
  end if;
  return new;
end;
$$;

create or replace function public.validate_composition_current_pointer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.composition_versions version
    where version.id = new.composition_version_id
      and version.user_id = new.user_id
      and version.video_job_id is not distinct from new.video_job_id
      and version.long_video_project_id is not distinct from new.long_video_project_id
      and version.long_video_segment_id is not distinct from new.long_video_segment_id
  ) then
    raise exception 'Current composition pointer must match its version owner and media parent.';
  end if;
  return new;
end;
$$;

drop trigger if exists dialogue_cues_parent_owner on public.dialogue_cues;
create trigger dialogue_cues_parent_owner before insert or update on public.dialogue_cues
for each row execute function public.validate_audio_parent_owner();
drop trigger if exists voice_inference_jobs_parent_owner on public.voice_inference_jobs;
create trigger voice_inference_jobs_parent_owner before insert or update on public.voice_inference_jobs
for each row execute function public.validate_audio_parent_owner();
drop trigger if exists audio_revisions_parent_owner on public.audio_revisions;
create trigger audio_revisions_parent_owner before insert on public.audio_revisions
for each row execute function public.validate_audio_parent_owner();
drop trigger if exists audio_revisions_inference_contract on public.audio_revisions;
create trigger audio_revisions_inference_contract before insert on public.audio_revisions
for each row execute function public.validate_audio_revision_contract();
drop trigger if exists composition_versions_parent_owner on public.composition_versions;
create trigger composition_versions_parent_owner before insert or update on public.composition_versions
for each row execute function public.validate_audio_parent_owner();
drop trigger if exists composition_current_pointers_parent_owner on public.composition_current_pointers;
create trigger composition_current_pointers_parent_owner before insert or update on public.composition_current_pointers
for each row execute function public.validate_audio_parent_owner();
drop trigger if exists composition_current_pointers_version_contract on public.composition_current_pointers;
create trigger composition_current_pointers_version_contract before insert or update on public.composition_current_pointers
for each row execute function public.validate_composition_current_pointer();

create or replace function public.reject_audio_contract_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Audio and composition revisions are immutable.';
end;
$$;

drop trigger if exists audio_revisions_immutable on public.audio_revisions;
create trigger audio_revisions_immutable before update on public.audio_revisions
for each row execute function public.reject_audio_contract_mutation();
drop trigger if exists composition_versions_immutable on public.composition_versions;
create trigger composition_versions_immutable before update on public.composition_versions
for each row execute function public.reject_audio_contract_mutation();

drop trigger if exists set_voice_profiles_updated_at on public.voice_profiles;
create trigger set_voice_profiles_updated_at before update on public.voice_profiles
for each row execute function public.set_updated_at();
drop trigger if exists set_dialogue_cues_updated_at on public.dialogue_cues;
create trigger set_dialogue_cues_updated_at before update on public.dialogue_cues
for each row execute function public.set_updated_at();
drop trigger if exists set_voice_inference_jobs_updated_at on public.voice_inference_jobs;
create trigger set_voice_inference_jobs_updated_at before update on public.voice_inference_jobs
for each row execute function public.set_updated_at();
drop trigger if exists set_composition_current_pointers_updated_at on public.composition_current_pointers;
create trigger set_composition_current_pointers_updated_at before update on public.composition_current_pointers
for each row execute function public.set_updated_at();

alter table public.voice_profiles enable row level security;
alter table public.dialogue_cues enable row level security;
alter table public.voice_inference_jobs enable row level security;
alter table public.audio_revisions enable row level security;
alter table public.composition_versions enable row level security;
alter table public.composition_current_pointers enable row level security;

revoke all on public.voice_profiles, public.dialogue_cues, public.voice_inference_jobs, public.audio_revisions, public.composition_versions, public.composition_current_pointers from anon, authenticated;
grant select on public.voice_profiles, public.dialogue_cues, public.voice_inference_jobs, public.audio_revisions, public.composition_versions, public.composition_current_pointers to authenticated;

drop policy if exists "voice_profiles_select_own" on public.voice_profiles;
create policy "voice_profiles_select_own" on public.voice_profiles for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "dialogue_cues_select_own" on public.dialogue_cues;
create policy "dialogue_cues_select_own" on public.dialogue_cues for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "voice_inference_jobs_select_own" on public.voice_inference_jobs;
create policy "voice_inference_jobs_select_own" on public.voice_inference_jobs for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "audio_revisions_select_own" on public.audio_revisions;
create policy "audio_revisions_select_own" on public.audio_revisions for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "composition_versions_select_own" on public.composition_versions;
create policy "composition_versions_select_own" on public.composition_versions for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "composition_current_pointers_select_own" on public.composition_current_pointers;
create policy "composition_current_pointers_select_own" on public.composition_current_pointers for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.create_voice_inference_job(
  p_idempotency_key text,
  p_voice_profile_id uuid,
  p_dialogue_snapshot jsonb,
  p_source_video_reference text,
  p_video_job_id uuid default null,
  p_long_video_project_id uuid default null,
  p_long_video_segment_id uuid default null
)
returns public.voice_inference_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.voice_inference_jobs%rowtype;
  v_job public.voice_inference_jobs%rowtype;
begin
  if v_user_id is null then raise exception '请先登录。'; end if;
  if char_length(btrim(coalesce(p_idempotency_key, ''))) < 8 then raise exception 'Invalid idempotency key.'; end if;
  if num_nonnulls(p_video_job_id, p_long_video_project_id, p_long_video_segment_id) <> 1 then raise exception 'Exactly one media parent is required.'; end if;
  if jsonb_typeof(coalesce(p_dialogue_snapshot, '[]'::jsonb)) <> 'array' then raise exception 'Dialogue snapshot must be an array.'; end if;
  if char_length(btrim(coalesce(p_source_video_reference, ''))) = 0 then raise exception 'Source video reference is required.'; end if;
  if coalesce(p_source_video_reference, '') ~ '(^[A-Za-z]:[\\/]|^/|^\\\\|(^|/)\\.\\.(/|$))' then raise exception 'Source video reference must be relative.'; end if;
  if p_video_job_id is not null and not exists (
    select 1 from public.video_jobs job where job.id = p_video_job_id and job.user_id = v_user_id
  ) then raise exception 'Video job is unavailable.'; end if;
  if p_long_video_project_id is not null and not exists (
    select 1 from public.long_video_projects project where project.id = p_long_video_project_id and project.user_id = v_user_id
  ) then raise exception 'Long-video project is unavailable.'; end if;
  if p_long_video_segment_id is not null and not exists (
    select 1
    from public.long_video_segments segment
    join public.long_video_projects project on project.id = segment.project_id
    where segment.id = p_long_video_segment_id and project.user_id = v_user_id
  ) then raise exception 'Long-video segment is unavailable.'; end if;
  select * into v_existing from public.voice_inference_jobs where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then return v_existing; end if;
  if not exists (select 1 from public.voice_profiles profile where profile.id = p_voice_profile_id and profile.user_id = v_user_id and profile.status = 'ready' and profile.archived_at is null) then raise exception 'Voice profile is unavailable.'; end if;
  insert into public.voice_inference_jobs(user_id, idempotency_key, voice_profile_id, dialogue_snapshot, source_video_reference, video_job_id, long_video_project_id, long_video_segment_id)
  values (v_user_id, btrim(p_idempotency_key), p_voice_profile_id, coalesce(p_dialogue_snapshot, '[]'::jsonb), p_source_video_reference, p_video_job_id, p_long_video_project_id, p_long_video_segment_id)
  returning * into v_job;
  return v_job;
end;
$$;

revoke all on function public.create_voice_inference_job(text, uuid, jsonb, text, uuid, uuid, uuid) from public, anon;
grant execute on function public.create_voice_inference_job(text, uuid, jsonb, text, uuid, uuid, uuid) to authenticated;
