-- Stage 4G.1: explicit segment prompt contract. The local_lab API uses the
-- same shape before falling back to its atomic file-backed persistence.
create or replace function public.create_long_video_project_v2(
  p_title text,
  p_overall_prompt text,
  p_first_frame_source text,
  p_first_frame_ref text,
  p_target_duration_seconds integer,
  p_segments jsonb,
  p_gpu_preference text[] default array['rtx4090','rtx5090']
) returns public.long_video_projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.long_video_projects;
  v_count integer;
  v_segment jsonb;
  v_index integer;
begin
  if p_target_duration_seconds < 5 or p_target_duration_seconds > 300 or mod(p_target_duration_seconds, 5) <> 0 then
    raise exception 'invalid_duration';
  end if;
  if p_first_frame_source not in ('upload','existing_image','pure_prompt') then raise exception 'invalid_first_frame_source'; end if;
  if p_first_frame_source <> 'pure_prompt' and nullif(trim(coalesce(p_first_frame_ref,'')), '') is null then raise exception 'missing_first_frame'; end if;
  if jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) <> p_target_duration_seconds / 5 then raise exception 'invalid_segment_count'; end if;
  for v_segment, v_index in select value, ordinality - 1 from jsonb_array_elements(p_segments) with ordinality loop
    if (v_segment->>'sequenceIndex')::integer <> v_index
      or (v_segment->>'startSecond')::integer <> v_index * 5
      or (v_segment->>'endSecond')::integer <> least((v_index + 1) * 5, p_target_duration_seconds)
      or nullif(trim(coalesce(v_segment->>'prompt','')), '') is null
      or length(v_segment->>'prompt') > 2000 then raise exception 'invalid_segment_prompt';
    end if;
  end loop;
  insert into public.long_video_projects(title, overall_prompt, first_frame_source, first_frame_ref, target_duration_seconds, gpu_preference)
  values (left(trim(p_title),120), left(trim(coalesce(p_overall_prompt,'')),2000), p_first_frame_source, case when p_first_frame_source = 'pure_prompt' then null else p_first_frame_ref end, p_target_duration_seconds, p_gpu_preference)
  returning * into v_project;
  insert into public.long_video_segments(project_id, sequence_index, start_second, end_second, prompt, status)
  select v_project.id, (value->>'sequenceIndex')::integer, (value->>'startSecond')::integer, (value->>'endSecond')::integer, left(trim(value->>'prompt'),2000), case when (value->>'sequenceIndex')::integer = 0 then 'ready' else 'pending' end
  from jsonb_array_elements(p_segments) as item(value);
  return v_project;
end;
$$;

revoke all on function public.create_long_video_project_v2(text,text,text,text,integer,jsonb,text[]) from public;
