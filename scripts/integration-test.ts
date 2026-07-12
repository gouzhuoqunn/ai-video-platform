import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { VIDEO_JOB_SELECT_FIELDS } from "../src/lib/video-jobs/fields";
import type { VideoJob, VideoJobWithBalance, WorkerJob } from "../src/types/video-jobs";
import { loadLocalEnv, requireEnv } from "./script-env";

loadLocalEnv();

const BUCKET = "generated-videos";
const TEST_ID = `codex_it_${Date.now()}_${randomBytes(4).toString("hex")}`;
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function pickRow<T>(data: T[] | T | null) {
  return Array.isArray(data) ? data[0] ?? null : data;
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
    throw new Error(`创建临时测试用户失败：${error?.message ?? "no user"}`);
  }

  createdUserIds.push(data.user.id);

  const client = publicClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });

  if (signInError) {
    throw new Error(`临时测试用户登录失败：${signInError.message}`);
  }

  return { email, user: data.user, client };
}

async function getBalance(userId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.from("credit_accounts").select("balance").eq("user_id", userId).maybeSingle();

  if (error) {
    throw new Error(`读取积分失败：${error.message}`);
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
    throw new Error(`读取积分流水失败：${error.message}`);
  }

  return count ?? 0;
}

async function createJob(client: SupabaseClient, promptSuffix: string, modelKey: "lightweight-video" | "standard-video") {
  const { data, error } = await client.rpc("create_video_job", {
    p_prompt: `[${TEST_ID}] ${promptSuffix}`,
    p_model_key: modelKey,
  });

  if (error) {
    throw new Error(`创建任务失败：${error.message}`);
  }

  const job = pickRow<VideoJobWithBalance>(data as VideoJobWithBalance[] | VideoJobWithBalance | null);
  assert(job, "创建任务后没有返回任务。");
  createdJobIds.push(job.id);
  return job;
}

async function getJobForUser(client: SupabaseClient, jobId: string) {
  const { data, error } = await client.from("video_jobs").select(VIDEO_JOB_SELECT_FIELDS).eq("id", jobId).maybeSingle();

  if (error) {
    throw new Error(`读取任务失败：${error.message}`);
  }

  return (data as VideoJob | null) ?? null;
}

async function getJobAdmin(jobId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.from("video_jobs").select(VIDEO_JOB_SELECT_FIELDS).eq("id", jobId).single();

  if (error) {
    throw new Error(`管理端读取任务失败：${error.message}`);
  }

  return data as VideoJob;
}

async function claim(workerId: string, leaseSeconds = 300) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.rpc("claim_next_video_job", {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });

  if (error) {
    throw new Error(`Worker领取失败：${error.message}`);
  }

  return pickRow<WorkerJob>(data as WorkerJob[] | WorkerJob | null);
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
  assert(foreignActiveJobs.length === 0, "检测到现有 queued/processing 任务。为避免误领取真实任务，远程集成测试已停止。");
}

async function testCreateAndCharge(userA: TestUser) {
  const job = await createJob(userA.client, "create and charge", "lightweight-video");
  assert(job.status === "queued", "轻量任务状态应为 queued。");
  assert(job.cost_credits === 5, "轻量任务应扣 5 积分。");
  assert(job.latest_balance === 95, "轻量任务创建后余额应为 95。");
  assert((await getBalance(userA.user.id)) === 95, "积分账户余额应为 95。");
  assert((await countTransactions(userA.user.id, job.id, "generation_charge")) === 1, "扣费流水应只有一条。");
  assert((await countTransactions(userA.user.id, job.id, "generation_charge")) === 1, "重复检查不应产生额外扣费。");
  const { error: cancelError } = await userA.client.rpc("cancel_video_job", { p_job_id: job.id });
  assert(!cancelError, `扣费测试后的 queued 任务应可取消清理：${cancelError?.message ?? ""}`);
  results.push("扣费测试通过");
}

async function testIsolation(userA: TestUser, userB: TestUser) {
  const ownedJob = await createJob(userA.client, "isolation", "lightweight-video");
  const otherRead = await getJobForUser(userB.client, ownedJob.id);
  assert(!otherRead, "第二个用户不应读取第一个用户的任务。");

  const anon = publicClient();
  const { data: anonData, error: anonError } = await anon.from("video_jobs").select("id").eq("id", ownedJob.id).maybeSingle();
  assert(Boolean(anonError) || !anonData, "匿名用户不应读取任务。");

  const { error: updateError } = await userA.client
    .from("video_jobs")
    .update({ status: "succeeded", progress: 100, cost_credits: 0, output_video_path: "bad/path.mp4" })
    .eq("id", ownedJob.id);
  assert(updateError, "普通用户不应直接修改任务受保护字段。");

  const { error: uploadError } = await userA.client.storage.from(BUCKET).upload(`${userA.user.id}/${ownedJob.id}/blocked.mp4`, new Blob(["x"]), {
    contentType: "video/mp4",
  });
  assert(uploadError, "普通用户不应直接上传到 generated-videos。");
  const { error: cancelError } = await userA.client.rpc("cancel_video_job", { p_job_id: ownedJob.id });
  assert(!cancelError, `权限测试后的 queued 任务应可取消清理：${cancelError?.message ?? ""}`);
  results.push("权限隔离测试通过");
}

async function testCancelAndRefund(userA: TestUser) {
  const before = await getBalance(userA.user.id);
  const job = await createJob(userA.client, "cancel refund", "standard-video");
  assert(job.cost_credits === 10, "标准任务应扣 10 积分。");
  assert((await getBalance(userA.user.id)) === before - 10, "标准任务创建后应扣除 10 积分。");

  const { error } = await userA.client.rpc("cancel_video_job", { p_job_id: job.id });
  assert(!error, `取消 queued 任务应成功：${error?.message ?? ""}`);
  const canceled = await getJobAdmin(job.id);
  assert(canceled.status === "canceled", "取消后状态应为 canceled。");
  assert((await getBalance(userA.user.id)) === before, "取消后积分应完全退回。");
  assert((await countTransactions(userA.user.id, job.id, "generation_refund")) === 1, "取消退款流水应只有一条。");

  const { error: secondError } = await userA.client.rpc("cancel_video_job", { p_job_id: job.id });
  assert(secondError, "再次取消必须失败。");
  assert((await getBalance(userA.user.id)) === before, "重复取消不应再次增加余额。");
  results.push("取消退款测试通过");
}

async function testWorkerClaim(userA: TestUser) {
  const job = await createJob(userA.client, "worker claim", "lightweight-video");
  const workerId = `${TEST_ID}_claim`;
  const claimed = await claim(workerId);
  assert(claimed?.id === job.id, "Worker 应领取本次创建的任务。");
  assert(claimed.status === "processing", "领取后状态应为 processing。");
  assert(claimed.worker_id === workerId, "领取后 worker_id 应正确。");
  assert(claimed.attempt_count === 1, "领取后 attempt_count 应增加。");

  const secondClaim = await claim(`${TEST_ID}_claim_2`);
  assert(!secondClaim || secondClaim.id !== job.id, "第二次领取不能领取同一任务。");

  const admin = getSupabaseAdminClientCore();
  const { error: wrongHeartbeat } = await admin.rpc("heartbeat_video_job", {
    p_job_id: job.id,
    p_worker_id: "wrong-worker",
    p_progress: 30,
    p_lease_seconds: 60,
  });
  assert(wrongHeartbeat, "heartbeat 只能由正确 worker 更新。");

  const { error: firstHeartbeat } = await admin.rpc("heartbeat_video_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_progress: 60,
    p_lease_seconds: 60,
  });
  assert(!firstHeartbeat, `正确 heartbeat 应成功：${firstHeartbeat?.message ?? ""}`);

  const { error: lowerHeartbeat } = await admin.rpc("heartbeat_video_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_progress: 20,
    p_lease_seconds: 60,
  });
  assert(!lowerHeartbeat, `低进度 heartbeat 不应失败：${lowerHeartbeat?.message ?? ""}`);
  assert((await getJobAdmin(job.id)).progress === 60, "progress 不应倒退。");
  const { error: cleanupError } = await admin.rpc("fail_video_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_error_message: "claim test cleanup",
  });
  assert(!cleanupError, `Worker领取测试后的processing任务应可标记失败清理：${cleanupError?.message ?? ""}`);
  results.push("Worker防重复领取测试通过");
  return { job, workerId };
}

async function testWorkerFailureRefund(userA: TestUser) {
  const before = await getBalance(userA.user.id);
  const job = await createJob(userA.client, "worker fail", "lightweight-video");
  const workerId = `${TEST_ID}_fail`;
  const claimed = await claim(workerId);
  assert(claimed?.id === job.id, "失败测试任务应被领取。");

  const admin = getSupabaseAdminClientCore();
  const { error } = await admin.rpc("fail_video_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_error_message: "mock failure without internal details",
  });
  assert(!error, `fail_video_job 应成功：${error?.message ?? ""}`);
  const failed = await getJobAdmin(job.id);
  assert(failed.status === "failed", "失败后状态应为 failed。");
  assert((await getBalance(userA.user.id)) === before, "失败后积分应退回。");
  assert((await countTransactions(userA.user.id, job.id, "generation_refund")) === 1, "失败退款流水应唯一。");

  const { error: secondError } = await admin.rpc("fail_video_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_error_message: "second fail",
  });
  assert(secondError, "重复失败不应再次成功。");
  assert((await getBalance(userA.user.id)) === before, "重复失败不应再次退款。");
  assert(!/[A-Z]:\\|\/home\/|stack|SUPABASE|SECRET|KEY/i.test(failed.error_message ?? ""), "用户可见错误不应包含内部路径、堆栈或密钥字样。");
  results.push("Worker失败退款测试通过");
}

async function testMockVideoSuccess(userA: TestUser, userB: TestUser) {
  const job = await createJob(userA.client, "mock video success", "lightweight-video");
  const workerId = `${TEST_ID}_success`;
  const claimed = await claim(workerId);
  assert(claimed?.id === job.id, "成功流程任务应被领取。");

  const sourcePath = path.join(process.cwd(), "public", "mock-videos", "demo.mp4");
  const [fileBuffer, fileStat] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
  const outputPath = `${userA.user.id}/${job.id}/output.mp4`;
  createdStoragePaths.push(outputPath);

  const admin = getSupabaseAdminClientCore();
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(outputPath, fileBuffer, {
    contentType: "video/mp4",
    upsert: false,
  });
  assert(!uploadError, `模拟视频上传应成功：${uploadError?.message ?? ""}`);

  const { error: completeError } = await admin.rpc("complete_video_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_output_video_path: outputPath,
    p_output_size_bytes: fileStat.size,
    p_output_mime_type: "video/mp4",
  });
  assert(!completeError, `complete_video_job 应成功：${completeError?.message ?? ""}`);

  const completed = await getJobAdmin(job.id);
  assert(completed.status === "succeeded", "完成后状态应为 succeeded。");
  assert(completed.progress === 100, "完成后 progress 应为 100。");
  assert(completed.output_video_path === outputPath, "输出路径应为 user_id/job_id/output.mp4。");

  const { data: objectInfo, error: objectError } = await admin.storage.from(BUCKET).list(`${userA.user.id}/${job.id}`);
  assert(!objectError && objectInfo?.some((item) => item.name === "output.mp4"), "视频对象应存在于私有 bucket。");

  const { data: signed, error: signedError } = await userA.client.storage.from(BUCKET).createSignedUrl(outputPath, 60);
  assert(!signedError && signed?.signedUrl, "第一个测试用户应能创建短期签名 URL。");
  assert(!signed.signedUrl.includes("/public/"), "签名 URL 不应是永久 public URL。");

  const { error: otherSignedError } = await userB.client.storage.from(BUCKET).createSignedUrl(outputPath, 60);
  assert(otherSignedError, "第二个测试用户不应访问第一个用户的视频文件。");
  results.push("模拟视频上传与私有视频权限隔离测试通过");
}

async function testInsufficientBalance(userA: TestUser) {
  const admin = getSupabaseAdminClientCore();
  const { error: updateError } = await admin.from("credit_accounts").update({ balance: 4 }).eq("user_id", userA.user.id);
  assert(!updateError, `设置临时低余额应成功：${updateError?.message ?? ""}`);

  const beforeJobs = createdJobIds.length;
  const { error } = await userA.client.rpc("create_video_job", {
    p_prompt: `[${TEST_ID}] insufficient balance`,
    p_model_key: "lightweight-video",
  });
  assert(error, "余额不足时 create_video_job 必须拒绝。");

  const { count, error: countError } = await admin
    .from("video_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userA.user.id)
    .eq("prompt", `[${TEST_ID}] insufficient balance`);
  assert(!countError && count === 0, "余额不足时不应创建任务。");
  assert(createdJobIds.length === beforeJobs, "余额不足任务不应进入清理任务列表。");
  results.push("余额不足测试通过");
}

async function testStaleLease(userA: TestUser) {
  await getSupabaseAdminClientCore().from("credit_accounts").update({ balance: 100 }).eq("user_id", userA.user.id);
  const job = await createJob(userA.client, "stale lease", "lightweight-video");
  const workerId = `${TEST_ID}_stale`;
  const claimed = await claim(workerId, 30);
  assert(claimed?.id === job.id, "过期租约任务应被领取。");

  const admin = getSupabaseAdminClientCore();
  const { error: leaseError } = await admin
    .from("video_jobs")
    .update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("id", job.id)
    .eq("worker_id", workerId);
  assert(!leaseError, `设置测试租约过期应成功：${leaseError?.message ?? ""}`);

  const { data, error } = await admin.rpc("requeue_stale_video_jobs");
  assert(!error, `requeue_stale_video_jobs 应成功：${error?.message ?? ""}`);
  const result = pickRow<{ requeued_count: number; failed_count: number; refunded_count: number }>(
    data as Array<{ requeued_count: number; failed_count: number; refunded_count: number }> | null,
  );
  assert(result && result.requeued_count >= 1, "未到最大尝试次数的过期任务应回到 queued。");
  assert(result.refunded_count === 0, "过期重排不应退款。");

  const requeued = await getJobAdmin(job.id);
  assert(requeued.status === "queued", "过期重排后状态应为 queued。");
  assert(!requeued.worker_id && !requeued.lease_expires_at, "过期重排后 worker_id 和 lease 应清空。");
  const { error: cancelError } = await userA.client.rpc("cancel_video_job", { p_job_id: job.id });
  assert(!cancelError, `stale lease 重排后的 queued 任务应可取消清理：${cancelError?.message ?? ""}`);
  results.push("stale lease测试通过");
}

async function testMaxAttemptsFailureRefund(userA: TestUser) {
  const before = await getBalance(userA.user.id);
  const job = await createJob(userA.client, "max attempts stale failure", "lightweight-video");
  const workerId = `${TEST_ID}_max_attempts`;
  const claimed = await claim(workerId, 30);
  assert(claimed?.id === job.id, "最大尝试次数测试任务应被领取。");

  const admin = getSupabaseAdminClientCore();
  const { error: setupError } = await admin
    .from("video_jobs")
    .update({
      max_attempts: 1,
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    .eq("id", job.id)
    .eq("worker_id", workerId);
  assert(!setupError, `设置最大尝试次数测试状态应成功：${setupError?.message ?? ""}`);

  const { data, error } = await admin.rpc("requeue_stale_video_jobs");
  assert(!error, `最大尝试次数 requeue_stale_video_jobs 应成功：${error?.message ?? ""}`);
  const result = pickRow<{ requeued_count: number; failed_count: number; refunded_count: number }>(
    data as Array<{ requeued_count: number; failed_count: number; refunded_count: number }> | null,
  );
  assert(result && result.failed_count >= 1, "达到最大尝试次数的过期任务应失败。");
  assert(result.refunded_count >= 1, "达到最大尝试次数失败时应退款。");

  const failed = await getJobAdmin(job.id);
  assert(failed.status === "failed", "达到最大尝试次数后状态应为 failed。");
  assert((await getBalance(userA.user.id)) === before, "达到最大尝试次数失败后积分应退回。");
  assert((await countTransactions(userA.user.id, job.id, "generation_refund")) === 1, "最大尝试次数退款流水应唯一。");
  results.push("最大尝试次数失败退款测试通过");
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

async function assertNoResidue() {
  const admin = getSupabaseAdminClientCore();
  const { count: jobCount, error: jobError } = await admin
    .from("video_jobs")
    .select("id", { count: "exact", head: true })
    .like("prompt", `%[${TEST_ID}]%`);
  assert(!jobError && jobCount === 0, "清理后不应残留本次测试 video_jobs。");

  if (createdJobIds.length > 0) {
    const { count: transactionCount, error: transactionError } = await admin
      .from("credit_transactions")
      .select("id", { count: "exact", head: true })
      .in("reference_id", createdJobIds);
    assert(!transactionError && transactionCount === 0, "清理后不应残留本次测试积分流水。");
  }

  for (const userId of createdUserIds) {
    const { data: authUser } = await admin.auth.admin.getUserById(userId);
    assert(!authUser.user, "清理后不应残留本次测试 auth 用户。");

    const { count: accountCount } = await admin.from("credit_accounts").select("user_id", { count: "exact", head: true }).eq("user_id", userId);
    assert(accountCount === 0, "清理后不应残留本次测试积分账户。");

    const { data: userObjects, error: objectError } = await admin.storage.from(BUCKET).list(userId);
    assert(!objectError && (userObjects?.length ?? 0) === 0, "清理后不应残留本次测试 Storage 对象。");
  }
}

async function main() {
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  if (!process.env.SUPABASE_SECRET_KEY?.trim() && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("缺少环境变量：SUPABASE_SECRET_KEY 或 SUPABASE_SERVICE_ROLE_KEY");
  }

  await ensureNoActiveJobsBeforeTest();
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");

  try {
    assert((await getBalance(userA.user.id)) === 100, "第一个临时用户初始积分应为 100。");
    assert((await getBalance(userB.user.id)) === 100, "第二个临时用户初始积分应为 100。");
    await testCreateAndCharge(userA);
    await testIsolation(userA, userB);
    await testCancelAndRefund(userA);
    await testWorkerClaim(userA);
    await testWorkerFailureRefund(userA);
    await testMockVideoSuccess(userA, userB);
    await testInsufficientBalance(userA);
    await testStaleLease(userA);
    await testMaxAttemptsFailureRefund(userA);
  } finally {
    await Promise.allSettled([userA.client.auth.signOut(), userB.client.auth.signOut()]);
    await cleanup();
  }

  await assertNoResidue();

  console.log(`远程集成测试通过：${results.join("；")}。临时数据已清理。`);
}

void main().catch(async (error) => {
  await cleanup().catch(() => undefined);
  console.error(error instanceof Error ? error.message : "远程集成测试失败。");
  process.exitCode = 1;
});
