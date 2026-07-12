import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { VIDEO_JOB_SELECT_FIELDS } from "../src/lib/video-jobs/fields";
import type { VideoJob, VideoJobWithBalance, WorkerJob } from "../src/types/video-jobs";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

const BUCKET = "generated-videos";
const TEST_ID = `codex_gpu_role_${Date.now()}_${randomBytes(4).toString("hex")}`;
const PASSWORD = `${randomBytes(18).toString("base64url")}Aa1!`;
const createdUserIds: string[] = [];
const createdJobIds: string[] = [];
const createdStoragePaths: string[] = [];
const results: string[] = [];

type TestUser = {
  email: string;
  user: User;
  client: SupabaseClient;
};

type WorkerCredentials = {
  userId: string;
  email: string;
  password: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseEnvFile(content: string) {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

async function readWorkerCredentials(): Promise<WorkerCredentials> {
  const credentialPath = path.join(process.cwd(), ".secrets", "gpu-worker.env");
  if (!existsSync(credentialPath)) {
    throw new Error("Missing .secrets/gpu-worker.env. Run npm run gpu-worker:create-account first.");
  }

  const values = parseEnvFile(await readFile(credentialPath, "utf8"));
  const userId = values.get("GPU_WORKER_USER_ID")?.trim();
  const email = values.get("GPU_WORKER_EMAIL")?.trim();
  const password = values.get("GPU_WORKER_PASSWORD")?.trim();
  assert(userId && email && password, ".secrets/gpu-worker.env is missing required Worker credential fields.");
  return { userId, email, password };
}

function publicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  assert(url && key, "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function pickRow<T>(data: T[] | T | null) {
  return Array.isArray(data) ? data[0] ?? null : data;
}

async function createTestUser(label: string): Promise<TestUser> {
  const admin = getSupabaseAdminClientCore();
  const email = `${TEST_ID}_${label}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
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

  return { email, user: data.user, client };
}

async function signInWorker(credentials: WorkerCredentials) {
  const client = publicClient();
  const { data, error } = await client.auth.signInWithPassword({ email: credentials.email, password: credentials.password });
  if (error || !data.user || !data.session) {
    throw new Error(`Limited Worker login failed: ${error?.message ?? "missing session"}`);
  }

  assert(data.user.id === credentials.userId, "Limited Worker credentials do not match GPU_WORKER_USER_ID.");
  assert(data.user.app_metadata?.role === "gpu_worker", "Limited Worker app_metadata.role must be gpu_worker.");

  const payload = JSON.parse(Buffer.from(data.session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
    app_metadata?: { role?: string };
  };
  assert(payload.app_metadata?.role === "gpu_worker", "Limited Worker JWT must contain app_metadata.role=gpu_worker.");

  results.push("limited worker login and JWT role verified");
  return client;
}

async function getBalance(userId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.from("credit_accounts").select("balance").eq("user_id", userId).maybeSingle();
  if (error) {
    throw new Error(`Reading credit balance failed: ${error.message}`);
  }
  return Number(data?.balance ?? 0);
}

async function countTransactions(userId: string, jobId: string, transactionType: string) {
  const admin = getSupabaseAdminClientCore();
  const { count, error } = await admin
    .from("credit_transactions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("reference_id", jobId)
    .eq("transaction_type", transactionType);

  if (error) {
    throw new Error(`Reading credit transactions failed: ${error.message}`);
  }

  return count ?? 0;
}

async function createJob(client: SupabaseClient, suffix: string, modelKey: "standard-video" | "lightweight-video" = "standard-video") {
  const { data, error } = await client.rpc("create_video_job", {
    p_prompt: `[${TEST_ID}] ${suffix}`,
    p_model_key: modelKey,
  });

  if (error) {
    throw new Error(`Creating video job failed: ${error.message}`);
  }

  const job = pickRow<VideoJobWithBalance>(data as VideoJobWithBalance[] | VideoJobWithBalance | null);
  assert(job, "Creating video job returned no job.");
  createdJobIds.push(job.id);
  return job;
}

async function getJobAdmin(jobId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.from("video_jobs").select(VIDEO_JOB_SELECT_FIELDS).eq("id", jobId).single();
  if (error) {
    throw new Error(`Admin reading job failed: ${error.message}`);
  }
  return data as VideoJob;
}

async function ensureNoForeignActiveJobs() {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.from("video_jobs").select("id,prompt,status").in("status", ["queued", "processing"]).limit(20);
  if (error) {
    throw new Error(`Checking active jobs failed: ${error.message}`);
  }

  const foreign = (data ?? []).filter((job) => !String(job.prompt ?? "").includes(TEST_ID));
  assert(foreign.length === 0, "Found existing queued/processing jobs. Stop to avoid claiming real work.");
}

async function assertOrdinaryCannotClaim(user: TestUser, jobId: string) {
  const { data, error } = await user.client.rpc("claim_next_video_job", {
    p_worker_id: "ordinary-user",
    p_lease_seconds: 60,
  });
  assert(error || !pickRow<WorkerJob>(data as WorkerJob[] | WorkerJob | null), "Ordinary users must not claim Worker jobs.");

  const job = await getJobAdmin(jobId);
  assert(job.status === "queued", "Ordinary Worker RPC attempt must not mutate the queued job.");
  results.push("ordinary user cannot call claim_next_video_job");
}

async function assertOrdinaryCannotUpload(user: TestUser, jobId: string) {
  const { error } = await user.client.storage.from(BUCKET).upload(`${user.user.id}/${jobId}/ordinary.mp4`, new Blob(["blocked"], { type: "video/mp4" }), {
    contentType: "video/mp4",
  });
  assert(error, "Ordinary users must not upload directly to generated-videos.");
  results.push("ordinary user direct Storage upload denied");
}

function assertNoSensitiveOutput(output: string, credentials: WorkerCredentials) {
  const forbidden = [
    credentials.password,
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GPU_WORKER_PASSWORD",
    "VAST_API_KEY",
  ];

  for (const value of forbidden) {
    assert(!output.includes(value), "GPU Worker mock output contained forbidden secret-like text.");
  }

  assert(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(output), "GPU Worker mock output contained a JWT.");
  assert(!/token=|signedUrl|signed-url/i.test(output), "GPU Worker mock output contained a token or signed URL.");
}

function findPython() {
  const candidates: Array<[string, string[]]> = [
    ["python", ["--version"]],
    ["py", ["-3", "--version"]],
    ["python3", ["--version"]],
  ];

  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" });
    if (result.status === 0) {
      return command === "py" ? { command, prefix: ["-3"] } : { command, prefix: [] };
    }
  }

  throw new Error("Python is required for the GPU Worker mock role test.");
}

async function runPythonGpuWorkerMockOnce(credentials: WorkerCredentials) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-video-platform-gpu-worker-"));
  const python = findPython();
  const code = [
    "from config import WorkerConfig",
    "from worker import GpuWorker",
    "config = WorkerConfig.from_env()",
    "config.validate()",
    "worker = GpuWorker(config)",
    "worker.login()",
    "processed = worker.process_one()",
    "print('gpu-worker mock processed one job' if processed else 'gpu-worker mock found no job')",
  ].join("\n");

  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: process.env.NODE_ENV ?? "test",
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PYTHONPATH: path.join(process.cwd(), "gpu-worker"),
      SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
      SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      GPU_WORKER_EMAIL: credentials.email,
      GPU_WORKER_PASSWORD: credentials.password,
      GPU_WORKER_USER_ID: credentials.userId,
      WAN_RUNNER: "mock",
      WAN_OUTPUT_DIR: tempDir,
      WORKER_POLL_INTERVAL_SECONDS: "1",
      WORKER_LEASE_SECONDS: "120",
      HF_HUB_DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
    };

    const result = spawnSync(python.command, [...python.prefix, "-c", code], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      stdio: "pipe",
      timeout: 120000,
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assertNoSensitiveOutput(output, credentials);

    if (result.status !== 0) {
      throw new Error(`Python GPU Worker mock failed after secret-output checks: ${output.slice(0, 1200)}`);
    }

    assert(result.stdout.includes("processed one job"), "Python GPU Worker mock did not process the queued test job.");
    results.push("Python GPU Worker mock processed one job without Secret key env");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function assertSuccessLoop(userA: TestUser, userB: TestUser, workerClient: SupabaseClient, credentials: WorkerCredentials) {
  const job = await createJob(userA.client, "python worker success", "standard-video");
  assert(job.cost_credits === 10, "standard-video must cost 10 credits.");
  assert(job.latest_balance === 90, "Temporary user balance should be 90 after a standard-video charge.");
  assert((await getBalance(userA.user.id)) === 90, "Credit account should show the 10 credit charge.");
  assert((await countTransactions(userA.user.id, job.id, "generation_charge")) === 1, "Charge ledger should contain exactly one generation_charge.");

  await assertOrdinaryCannotClaim(userA, job.id);
  await assertOrdinaryCannotUpload(userA, job.id);
  await runPythonGpuWorkerMockOnce(credentials);

  const completed = await getJobAdmin(job.id);
  const outputPath = `${userA.user.id}/${job.id}/output.mp4`;
  createdStoragePaths.push(outputPath);
  assert(completed.status === "succeeded", "GPU Worker mock should complete the job.");
  assert(completed.progress === 100, "Completed job progress should be 100.");
  assert(completed.output_video_path === outputPath, "Worker output path must be user_id/job_id/output.mp4.");
  assert(completed.output_mime_type === "video/mp4", "Worker mock output MIME type should be video/mp4.");

  const { data: objectInfo, error: objectError } = await getSupabaseAdminClientCore().storage.from(BUCKET).list(`${userA.user.id}/${job.id}`);
  assert(!objectError && objectInfo?.some((item) => item.name === "output.mp4"), "Worker output object should exist in the private bucket.");

  const { data: signed, error: signedError } = await userA.client.storage.from(BUCKET).createSignedUrl(outputPath, 60);
  assert(!signedError && signed?.signedUrl, "Owning user should be able to create a short-lived signed URL.");
  assert(!signed.signedUrl.includes("/public/"), "Generated video access must use signed URLs, not public URLs.");

  const { error: otherSignedError } = await userB.client.storage.from(BUCKET).createSignedUrl(outputPath, 60);
  assert(otherSignedError, "Another ordinary user must not create a signed URL for this output.");

  const { data: workerRead, error: workerReadError } = await workerClient.from("video_jobs").select("id").eq("id", job.id).maybeSingle();
  assert(Boolean(workerReadError) || !workerRead, "gpu_worker must not directly read unrelated user jobs through table access.");

  await workerClient.storage.from(BUCKET).remove([outputPath]);
  const { data: afterDeleteAttempt, error: afterDeleteAttemptError } = await getSupabaseAdminClientCore().storage.from(BUCKET).list(`${userA.user.id}/${job.id}`);
  assert(
    !afterDeleteAttemptError && afterDeleteAttempt?.some((item) => item.name === "output.mp4"),
    "gpu_worker must not delete generated videos.",
  );

  const beforeBalance = await getBalance(userA.user.id);
  await workerClient.from("credit_accounts").update({ balance: beforeBalance + 1000 }).eq("user_id", userA.user.id);
  assert((await getBalance(userA.user.id)) === beforeBalance, "gpu_worker must not directly modify credit_accounts.");

  const beforeFakeTransactions = await countTransactions(userA.user.id, job.id, "worker_forbidden_write");
  await workerClient.from("credit_transactions").insert({
    user_id: userA.user.id,
    amount: 1,
    transaction_type: "worker_forbidden_write",
    description: "blocked",
    reference_id: job.id,
  });
  assert((await countTransactions(userA.user.id, job.id, "worker_forbidden_write")) === beforeFakeTransactions, "gpu_worker must not directly write credit_transactions.");

  const { error: adminError } = await workerClient.auth.admin.listUsers();
  assert(adminError, "gpu_worker publishable-key session must not perform service-role Auth admin operations.");

  results.push("charge, claim, heartbeat, private upload, completion, signed URL, and isolation loop verified");
}

async function assertFailureRefundLoop(userA: TestUser, workerClient: SupabaseClient, credentials: WorkerCredentials) {
  const before = await getBalance(userA.user.id);
  const job = await createJob(userA.client, "worker failure refund", "standard-video");
  assert((await getBalance(userA.user.id)) === before - 10, "Failure test job should charge 10 credits before processing.");

  const { data: claimData, error: claimError } = await workerClient.rpc("claim_next_video_job", {
    p_worker_id: credentials.userId,
    p_lease_seconds: 120,
  });
  if (claimError) {
    throw new Error(`gpu_worker failed to claim refund test job: ${claimError.message}`);
  }

  const claimed = pickRow<WorkerJob>(claimData as WorkerJob[] | WorkerJob | null);
  assert(claimed?.id === job.id, "gpu_worker should claim the failure refund test job.");
  assert(claimed.worker_id === credentials.userId, "Claimed job worker_id should be the limited Worker user id.");

  const { error: heartbeatError } = await workerClient.rpc("heartbeat_video_job", {
    p_job_id: job.id,
    p_worker_id: credentials.userId,
    p_progress: 55,
    p_lease_seconds: 120,
  });
  assert(!heartbeatError, `gpu_worker heartbeat should succeed: ${heartbeatError?.message ?? ""}`);
  assert((await getJobAdmin(job.id)).progress === 55, "gpu_worker heartbeat should update progress.");

  const { error: failError } = await workerClient.rpc("fail_video_job", {
    p_job_id: job.id,
    p_worker_id: credentials.userId,
    p_error_message: "mock failure for refund verification",
  });
  assert(!failError, `gpu_worker fail_video_job should succeed: ${failError?.message ?? ""}`);

  const failed = await getJobAdmin(job.id);
  assert(failed.status === "failed", "Failure refund job should end as failed.");
  assert((await getBalance(userA.user.id)) === before, "fail_video_job should refund the standard-video charge.");
  assert((await countTransactions(userA.user.id, job.id, "generation_refund")) === 1, "Failure refund ledger should contain exactly one refund.");

  const { error: secondFailError } = await workerClient.rpc("fail_video_job", {
    p_job_id: job.id,
    p_worker_id: credentials.userId,
    p_error_message: "second refund attempt should be rejected",
  });
  assert(secondFailError, "Repeated fail_video_job must not refund the same job twice.");
  assert((await getBalance(userA.user.id)) === before, "Repeated failure must not change the refunded balance.");
  assert((await countTransactions(userA.user.id, job.id, "generation_refund")) === 1, "Repeated failure must not create a second refund ledger entry.");

  results.push("fail_video_job refund loop verified");
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
        p_error_message: "gpu worker role test cleanup",
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

async function assertNoResidue() {
  const admin = getSupabaseAdminClientCore();
  const { count: jobCount, error: jobError } = await admin
    .from("video_jobs")
    .select("id", { count: "exact", head: true })
    .like("prompt", `%[${TEST_ID}]%`);
  assert(!jobError && jobCount === 0, "Temporary gpu_worker role test video_jobs were not fully cleaned.");

  if (createdJobIds.length > 0) {
    const { count: transactionCount, error: transactionError } = await admin
      .from("credit_transactions")
      .select("id", { count: "exact", head: true })
      .in("reference_id", createdJobIds);
    assert(!transactionError && transactionCount === 0, "Temporary gpu_worker role test credit transactions were not fully cleaned.");
  }

  for (const userId of createdUserIds) {
    const { data: authUser } = await admin.auth.admin.getUserById(userId);
    assert(!authUser.user, "Temporary gpu_worker role test Auth users were not fully cleaned.");
    const { data: objects, error: objectError } = await admin.storage.from(BUCKET).list(userId);
    assert(!objectError && (objects?.length ?? 0) === 0, "Temporary gpu_worker role test Storage objects were not fully cleaned.");
  }

  results.push("temporary users, jobs, ledgers, and Storage objects cleaned");
}

async function main() {
  if (!process.env.SUPABASE_SECRET_KEY?.trim() && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("This test harness needs SUPABASE_SECRET_KEY locally, but the GPU Worker mock process will not receive it.");
  }

  await ensureNoForeignActiveJobs();
  const credentials = await readWorkerCredentials();
  const workerClient = await signInWorker(credentials);
  const userA = await createTestUser("owner");
  const userB = await createTestUser("other");

  try {
    assert((await getBalance(userA.user.id)) === 100, "Temporary owner user should start with 100 credits.");
    assert((await getBalance(userB.user.id)) === 100, "Temporary other user should start with 100 credits.");
    await assertFailureRefundLoop(userA, workerClient, credentials);
    await assertSuccessLoop(userA, userB, workerClient, credentials);
  } finally {
    await Promise.allSettled([workerClient.auth.signOut(), userA.client.auth.signOut(), userB.client.auth.signOut()]);
    await cleanup();
  }

  await assertNoResidue();
  console.log(`Limited gpu_worker role integration test passed: ${results.join("; ")}. No secrets, tokens, or signed URLs were printed.`);
}

void main().catch(async (error) => {
  await cleanup().catch(() => undefined);
  console.error(error instanceof Error ? error.message : "Limited gpu_worker role integration test failed.");
  process.exitCode = 1;
});
