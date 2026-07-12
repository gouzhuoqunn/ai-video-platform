import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { VIDEO_JOB_SELECT_FIELDS } from "../src/lib/video-jobs/fields";
import type { VideoJobWithBalance } from "../src/types/video-jobs";
import { loadLocalEnv, requireEnv } from "./script-env";

loadLocalEnv();

const TEST_ID = `codex_worker_once_${Date.now()}_${randomBytes(4).toString("hex")}`;
const PASSWORD = `${randomBytes(18).toString("base64url")}Aa1!`;
const BUCKET = "generated-videos";
const createdUserIds: string[] = [];
const createdJobIds: string[] = [];
const createdStoragePaths: string[] = [];

type TestUser = {
  user: User;
  client: SupabaseClient;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function publicClient() {
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function pickRow<T>(data: T[] | T | null) {
  return Array.isArray(data) ? data[0] ?? null : data;
}

async function ensureNoActiveJobsBeforeTest() {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin
    .from("video_jobs")
    .select("id,status,prompt")
    .in("status", ["queued", "processing"])
    .limit(20);

  if (error) {
    throw new Error(`检查现有队列失败：${error.message}`);
  }

  const foreignActiveJobs = (data ?? []).filter((job) => !String(job.prompt ?? "").includes(TEST_ID));
  assert(foreignActiveJobs.length === 0, "检测到现有 queued/processing 任务。为避免误领取真实任务，一次性Worker验证已停止。");
}

async function createTestUser(): Promise<TestUser> {
  const admin = getSupabaseAdminClientCore();
  const email = `${TEST_ID}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { test_id: TEST_ID },
  });

  if (error || !data.user) {
    throw new Error(`创建临时测试用户失败：${error?.message ?? "no user"}`);
  }

  createdUserIds.push(data.user.id);

  const client = publicClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });

  if (signInError) {
    throw new Error(`临时测试用户登录失败：${signInError.message}`);
  }

  return { user: data.user, client };
}

async function createJob(client: SupabaseClient) {
  const { data, error } = await client.rpc("create_video_job", {
    p_prompt: `[${TEST_ID}] worker once success`,
    p_model_key: "lightweight-video",
  });

  if (error) {
    throw new Error(`创建一次性Worker测试任务失败：${error.message}`);
  }

  const job = pickRow<VideoJobWithBalance>(data as VideoJobWithBalance[] | VideoJobWithBalance | null);
  assert(job, "创建一次性Worker测试任务后没有返回任务。");
  createdJobIds.push(job.id);
  createdStoragePaths.push(`${job.user_id}/${job.id}/output.mp4`);
  return job;
}

function runWorkerOnce() {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const npmCliPath = process.env.npm_execpath;

    if (!npmCliPath) {
      reject(new Error("无法定位 npm CLI 路径。"));
      return;
    }

    const child = spawn(process.execPath, [npmCliPath, "run", "worker:mock:once"], {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, MOCK_WORKER_ONCE: "true" },
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function getJob(jobId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.from("video_jobs").select(VIDEO_JOB_SELECT_FIELDS).eq("id", jobId).single();

  if (error) {
    throw new Error(`读取一次性Worker任务失败：${error.message}`);
  }

  return data as { status: string; progress: number; output_video_path: string | null };
}

async function cleanup() {
  const admin = getSupabaseAdminClientCore();

  if (createdStoragePaths.length > 0) {
    await admin.storage.from(BUCKET).remove(createdStoragePaths);
  }

  if (createdJobIds.length > 0) {
    await admin.from("credit_transactions").delete().in("reference_id", createdJobIds);
    await admin.from("video_jobs").delete().in("id", createdJobIds);
  }

  for (const userId of createdUserIds) {
    await admin.from("credit_transactions").delete().eq("user_id", userId);
    await admin.from("credit_accounts").delete().eq("user_id", userId);
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
  }
}

async function main() {
  if (!process.env.SUPABASE_SECRET_KEY?.trim() && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("缺少环境变量：SUPABASE_SECRET_KEY 或 SUPABASE_SERVICE_ROLE_KEY");
  }

  await ensureNoActiveJobsBeforeTest();

  const emptyRun = await runWorkerOnce();
  assert(emptyRun.code === 0, "没有等待任务时一次性Worker应以退出码0正常退出。");
  assert(emptyRun.output.includes("没有可处理的任务"), "没有等待任务时一次性Worker应提示正常退出。");

  const testUser = await createTestUser();

  try {
    const job = await createJob(testUser.client);
    const run = await runWorkerOnce();
    assert(run.code === 0, "存在测试任务时一次性Worker应以退出码0退出。");
    assert(run.output.includes("领取任务") && run.output.includes("已完成"), "一次性Worker应领取并完成测试任务。");

    const completed = await getJob(job.id);
    assert(completed.status === "succeeded", "一次性Worker处理后任务状态应为 succeeded。");
    assert(completed.progress === 100, "一次性Worker处理后进度应为100。");
    assert(completed.output_video_path === `${job.user_id}/${job.id}/output.mp4`, "一次性Worker输出路径应正确。");

    const { data: signed, error: signedError } = await testUser.client.storage
      .from(BUCKET)
      .createSignedUrl(completed.output_video_path, 60);
    assert(!signedError && signed?.signedUrl, "一次性Worker完成后测试用户应能创建短期签名URL。");
    assert(!signed.signedUrl.includes("/public/"), "一次性Worker签名URL不应是永久public URL。");
  } finally {
    await testUser.client.auth.signOut();
    await cleanup();
  }

  console.log("一次性Worker验证通过：无任务正常退出，有测试任务时可领取、上传、完成并清理。");
}

void main().catch(async (error) => {
  await cleanup().catch(() => undefined);
  console.error(error instanceof Error ? error.message : "一次性Worker验证失败。");
  process.exitCode = 1;
});
