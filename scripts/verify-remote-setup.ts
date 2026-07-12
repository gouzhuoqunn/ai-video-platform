import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { VIDEO_JOB_SELECT_FIELDS } from "../src/lib/video-jobs/fields";
import type { VideoJobWithBalance, WorkerJob } from "../src/types/video-jobs";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

const BUCKET = "generated-videos";
const TEST_ID = `codex_verify_${Date.now()}_${randomBytes(4).toString("hex")}`;
const PASSWORD = `${randomBytes(18).toString("base64url")}Aa1!`;
const requiredPublicEnv = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
const serverSecretEnv = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const createdUserIds: string[] = [];
const createdStoragePaths: string[] = [];
const createdJobIds: string[] = [];

type TestUser = {
  user: User;
  client: SupabaseClient;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPresent(name: string) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function pickRow<T>(data: T[] | T | null) {
  return Array.isArray(data) ? data[0] ?? null : data;
}

function publicClient() {
  assertPresent("NEXT_PUBLIC_SUPABASE_URL");
  assertPresent("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function checkEnv() {
  for (const name of requiredPublicEnv) {
    assertPresent(name);
  }

  if (!serverSecretEnv.some((name) => process.env[name]?.trim())) {
    throw new Error("Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.");
  }
}

async function checkConnection() {
  const admin = getSupabaseAdminClientCore();
  const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });

  if (error) {
    throw new Error(`Supabase admin connection failed: ${error.message}`);
  }
}

async function checkVideoJobFields() {
  const admin = getSupabaseAdminClientCore();
  const { error } = await admin.from("video_jobs").select(VIDEO_JOB_SELECT_FIELDS).limit(1);

  if (error) {
    throw new Error(`video_jobs schema is incomplete or migrations are missing: ${error.message}`);
  }
}

async function checkBucketPrivate() {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.storage.listBuckets();

  if (error) {
    throw new Error(`Reading Storage buckets failed: ${error.message}`);
  }

  const bucket = data.find((item) => item.name === BUCKET);
  assert(bucket, `Missing Storage bucket: ${BUCKET}`);
  assert(!bucket.public, `${BUCKET} bucket must be private.`);
}

async function createTestUser(label: string, role?: "gpu_worker"): Promise<TestUser> {
  const admin = getSupabaseAdminClientCore();
  const email = `${TEST_ID}_${label}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: role ? { role } : undefined,
    user_metadata: { test_id: TEST_ID },
  });

  if (error || !data.user) {
    throw new Error(`Creating temporary ${label} user failed: ${error?.message ?? "no user returned"}`);
  }

  createdUserIds.push(data.user.id);

  const client = publicClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) {
    throw new Error(`Signing in temporary ${label} user failed: ${signInError.message}`);
  }

  return { user: data.user, client };
}

async function createJob(client: SupabaseClient) {
  const { data, error } = await client.rpc("create_video_job", {
    p_prompt: `[${TEST_ID}] verify limited gpu worker storage`,
    p_model_key: "standard-video",
  });

  if (error) {
    throw new Error(`Creating verification video job failed: ${error.message}`);
  }

  const job = pickRow<VideoJobWithBalance>(data as VideoJobWithBalance[] | VideoJobWithBalance | null);
  assert(job, "Creating verification video job returned no job.");
  createdJobIds.push(job.id);
  return job;
}

async function ensureNoForeignActiveJobs() {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.from("video_jobs").select("id,prompt,status").in("status", ["queued", "processing"]).limit(20);
  if (error) {
    throw new Error(`Checking active jobs failed: ${error.message}`);
  }

  const foreign = (data ?? []).filter((job) => !String(job.prompt ?? "").includes(TEST_ID));
  assert(foreign.length === 0, "Remote verification found existing queued/processing jobs. Stop to avoid claiming real work.");
}

async function checkWorkerRpcExistsAndServiceRoleAllowed() {
  const admin = getSupabaseAdminClientCore();
  const { error } = await admin.rpc("heartbeat_video_job", {
    p_job_id: randomUUID(),
    p_worker_id: "verify-remote-service-role",
    p_progress: 10,
    p_lease_seconds: 30,
  });

  assert(error, "Service-role heartbeat probe should reach business logic and fail on the fake job id.");
  const message = error.message.toLowerCase();
  assert(!message.includes("function") && !message.includes("permission denied") && !message.includes("worker role required"), "Worker RPC is not available to service_role.");
}

async function checkOrdinaryUserCannotCallWorkerRpc(user: TestUser) {
  const { error } = await user.client.rpc("heartbeat_video_job", {
    p_job_id: randomUUID(),
    p_worker_id: "ordinary-user",
    p_progress: 10,
    p_lease_seconds: 30,
  });

  assert(error, "Ordinary authenticated users must not be able to call Worker RPCs.");
}

async function checkGpuWorkerCanCallWorkerRpc(worker: TestUser) {
  const { error } = await worker.client.rpc("heartbeat_video_job", {
    p_job_id: randomUUID(),
    p_worker_id: "ignored-for-gpu-worker",
    p_progress: 10,
    p_lease_seconds: 30,
  });

  assert(error, "GPU worker heartbeat probe should reach business logic and fail on the fake job id.");
  const message = error.message.toLowerCase();
  assert(!message.includes("permission denied") && !message.includes("worker role required"), "Worker RPC did not accept app_metadata.role=gpu_worker.");
}

async function checkStoragePolicies(user: TestUser, worker: TestUser) {
  const admin = getSupabaseAdminClientCore();
  const job = await createJob(user.client);

  const { error: ordinaryUploadError } = await user.client.storage.from(BUCKET).upload(`${user.user.id}/${job.id}/blocked.mp4`, new Blob(["x"], { type: "video/mp4" }), {
    contentType: "video/mp4",
  });
  assert(ordinaryUploadError, "Ordinary users must not be able to upload to generated-videos.");

  const { data: claimData, error: claimError } = await worker.client.rpc("claim_next_video_job", {
    p_worker_id: "ignored-for-gpu-worker",
    p_lease_seconds: 120,
  });
  if (claimError) {
    throw new Error(`gpu_worker claim_next_video_job failed: ${claimError.message}`);
  }

  const claimed = pickRow<WorkerJob>(claimData as WorkerJob[] | WorkerJob | null);
  assert(claimed?.id === job.id, "gpu_worker did not claim the verification job.");
  assert(claimed.worker_id === worker.user.id, "gpu_worker claim must store auth.uid() as worker_id.");

  const wrongUserPath = `${worker.user.id}/${job.id}/output.mp4`;
  const { error: wrongUserUploadError } = await worker.client.storage.from(BUCKET).upload(wrongUserPath, new Blob(["wrong user"], { type: "video/mp4" }), {
    contentType: "video/mp4",
  });
  assert(wrongUserUploadError, "gpu_worker must not upload to a path owned by another user.");

  const invalidNamePath = `${user.user.id}/${job.id}/not-output.mp4`;
  const { error: invalidNameUploadError } = await worker.client.storage.from(BUCKET).upload(invalidNamePath, new Blob(["wrong name"], { type: "video/mp4" }), {
    contentType: "video/mp4",
  });
  assert(invalidNameUploadError, "gpu_worker must only upload output.mp4 or output.webm.");

  const invalidMimePath = `${user.user.id}/${job.id}/output.txt`;
  const { error: invalidMimeUploadError } = await worker.client.storage.from(BUCKET).upload(invalidMimePath, new Blob(["wrong type"], { type: "text/plain" }), {
    contentType: "text/plain",
  });
  assert(invalidMimeUploadError, "gpu_worker must not upload non-mp4/webm objects.");

  for (const extension of ["mp4", "webm"] as const) {
    const mimeType = extension === "webm" ? "video/webm" : "video/mp4";
    const outputPath = `${user.user.id}/${job.id}/output.${extension}`;
    const { error: workerUploadError } = await worker.client.storage.from(BUCKET).upload(outputPath, new Blob([`mock ${extension}`], { type: mimeType }), {
      contentType: mimeType,
      upsert: false,
    });

    if (workerUploadError) {
      throw new Error(`gpu_worker upload to ${extension} output path failed: ${workerUploadError.message}`);
    }
    createdStoragePaths.push(outputPath);
  }

  const mp4Path = `${user.user.id}/${job.id}/output.mp4`;
  const { error: workerDownloadError } = await worker.client.storage.from(BUCKET).download(mp4Path);
  assert(workerDownloadError, "gpu_worker must not read unrelated user Storage objects.");

  await worker.client.storage.from(BUCKET).remove([mp4Path]);
  const { data: afterDeleteAttempt, error: afterDeleteAttemptError } = await admin.storage.from(BUCKET).list(`${user.user.id}/${job.id}`);
  assert(
    !afterDeleteAttemptError && afterDeleteAttempt?.some((item) => item.name === "output.mp4"),
    "gpu_worker must not delete generated videos.",
  );
}

function checkBuildScript() {
  const buildScript = process.env.npm_package_scripts_build ?? "";

  if (buildScript.includes("SUPABASE_SECRET_KEY") || buildScript.includes("SUPABASE_SERVICE_ROLE_KEY")) {
    throw new Error("The regular build script must not depend on a server Secret key.");
  }
}

async function cleanup() {
  const admin = getSupabaseAdminClientCore();

  if (createdStoragePaths.length > 0) {
    await admin.storage.from(BUCKET).remove(createdStoragePaths);
  }

  for (const jobId of createdJobIds) {
    const { data: job } = await admin.from("video_jobs").select("worker_id,status").eq("id", jobId).maybeSingle();
    if (job?.status === "processing" && job.worker_id) {
      await admin.rpc("fail_video_job", {
        p_job_id: jobId,
        p_worker_id: job.worker_id,
        p_error_message: "verify remote cleanup",
      });
    }
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
  checkEnv();
  checkBuildScript();
  await checkConnection();
  await checkVideoJobFields();
  await checkBucketPrivate();
  await checkWorkerRpcExistsAndServiceRoleAllowed();
  await ensureNoForeignActiveJobs();

  const user = await createTestUser("ordinary");
  const worker = await createTestUser("worker", "gpu_worker");

  try {
    await checkOrdinaryUserCannotCallWorkerRpc(user);
    await checkGpuWorkerCanCallWorkerRpc(worker);
    await checkStoragePolicies(user, worker);
  } finally {
    await Promise.allSettled([user.client.auth.signOut(), worker.client.auth.signOut()]);
    await cleanup();
  }

  console.log("Remote Supabase verification passed: Worker RPC, limited gpu_worker role, private Storage, and upload policies are active. No secrets were printed.");
}

void main().catch(async (error) => {
  await cleanup().catch(() => undefined);
  console.error(error instanceof Error ? error.message : "Remote verification failed.");
  process.exitCode = 1;
});
