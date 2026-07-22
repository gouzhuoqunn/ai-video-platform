import { createClient } from "@supabase/supabase-js";
import { readLocalLabCredentials } from "../src/lib/local-lab/config";
import { VIDEO_JOB_SELECT_FIELDS } from "../src/lib/video-jobs/fields";
import type { VideoJobWithBalance } from "../src/types/video-jobs";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

const SAFE_FIRST_PROMPT =
  "At sunrise, a small red paper boat glides slowly across a clear rain puddle, gentle ripples and soft reflections, cinematic camera movement, no people, no text.";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function publicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  assert(url && key, "Missing Supabase public configuration.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function pickRow<T>(data: T[] | T | null) {
  return Array.isArray(data) ? data[0] ?? null : data;
}

async function main() {
  const credentials = readLocalLabCredentials();
  const client = publicClient();
  const { error: loginError } = await client.auth.signInWithPassword({ email: credentials.email, password: credentials.password });
  if (loginError) throw new Error(`Local lab login failed: ${loginError.message}`);

  try {
    const { data: jobs, error: readError } = await client
      .from("video_jobs")
      .select(VIDEO_JOB_SELECT_FIELDS)
      .eq("user_id", credentials.userId)
      .eq("status", "queued");
    if (readError) throw new Error(`Reading queued jobs failed: ${readError.message}`);

    for (const job of jobs ?? []) {
      const { error } = await client.rpc("cancel_video_job", { p_job_id: job.id });
      if (error) throw new Error(`Canceling queued job through RPC failed: ${error.message}`);
    }

    const { data, error } = await client.rpc("create_video_job", {
      p_prompt: SAFE_FIRST_PROMPT,
      p_model_key: "standard-video",
    });
    if (error) throw new Error(`Creating safe first job failed: ${error.message}`);
    const job = pickRow<VideoJobWithBalance>(data as VideoJobWithBalance[] | VideoJobWithBalance | null);
    assert(job, "create_video_job returned no job.");

    const { count, error: countError } = await client
      .from("video_jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", credentials.userId)
      .eq("status", "queued");
    if (countError) throw new Error(`Counting queued jobs failed: ${countError.message}`);
    assert(count === 1, "Expected exactly one queued first-session job after preparation.");

    console.log(
      JSON.stringify(
        {
          canceled_previous_queued_jobs: jobs?.length ?? 0,
          created_safe_job_id: job.id,
          model_key: job.model_key,
          status: job.status,
          queued_count_after: count,
          prompt_summary: "safe red paper boat rain puddle scene, no people, no text",
          secrets_printed: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.auth.signOut().catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "safe first Wan2.2 job prep failed");
  process.exitCode = 1;
});
