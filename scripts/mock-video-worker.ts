import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import type { WorkerJob } from "../src/types/video-jobs";
import { loadLocalEnv } from "./script-env";

const GENERATED_VIDEOS_BUCKET = "generated-videos";
const DEFAULT_POLL_INTERVAL_MS = 3000;
const HEARTBEAT_PROGRESS = [5, 20, 45, 70, 90];

loadLocalEnv();

let shouldStop = false;

process.on("SIGINT", () => {
  shouldStop = true;
  console.log("收到停止信号，当前任务处理结束后退出。");
});

function getWorkerId() {
  return `mock-worker-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function getPollIntervalMs() {
  const value = Number(process.env.MOCK_WORKER_POLL_INTERVAL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function isOnceMode() {
  return (process.env.MOCK_WORKER_ONCE ?? "").toLowerCase() === "true";
}

function getMimeType(filePath: string) {
  return filePath.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
}

function getOutputExtension(mimeType: string) {
  return mimeType === "video/webm" ? "webm" : "mp4";
}

function resolveMockVideoSource() {
  const configured = (process.env.MOCK_VIDEO_SOURCE ?? "").trim();
  const candidates = configured
    ? [configured]
    : [
        path.join(process.cwd(), "public", "mock-videos", "demo.mp4"),
        path.join(process.cwd(), "public", "demo.mp4"),
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function pickRpcRow<T>(data: T[] | T | null) {
  if (Array.isArray(data)) {
    return data[0] ?? null;
  }

  return data;
}

async function heartbeat(jobId: string, workerId: string, progress: number) {
  const admin = getSupabaseAdminClientCore();
  const { error } = await admin.rpc("heartbeat_video_job", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_progress: progress,
  });

  if (error) {
    throw new Error(error.message);
  }

  console.log(`任务 ${jobId} 进度 ${progress}%`);
}

async function failJob(jobId: string, workerId: string, message: string) {
  const admin = getSupabaseAdminClientCore();
  const safeMessage = message.split("\n")[0]?.slice(0, 300) || "模拟Worker处理失败。";
  const { error } = await admin.rpc("fail_video_job", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_error_message: safeMessage,
  });

  if (error) {
    console.log(`任务 ${jobId} 标记失败时出错：${error.message}`);
  }
}

async function processJob(job: WorkerJob, workerId: string, sourcePath: string) {
  const admin = getSupabaseAdminClientCore();
  const mimeType = getMimeType(sourcePath);
  const extension = getOutputExtension(mimeType);
  const outputPath = `${job.user_id}/${job.id}/output.${extension}`;

  console.log(`领取任务 ${job.id}`);

  try {
    for (const progress of HEARTBEAT_PROGRESS) {
      if (shouldStop) {
        throw new Error("模拟Worker被手动停止。");
      }

      await delay(700);
      await heartbeat(job.id, workerId, progress);
    }

    const [fileBuffer, fileStat] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
    const { error: uploadError } = await admin.storage.from(GENERATED_VIDEOS_BUCKET).upload(outputPath, fileBuffer, {
      contentType: mimeType,
      upsert: false,
    });

    if (uploadError && !uploadError.message.toLowerCase().includes("already exists")) {
      throw new Error(uploadError.message);
    }

    const { error: completeError } = await admin.rpc("complete_video_job", {
      p_job_id: job.id,
      p_worker_id: workerId,
      p_output_video_path: outputPath,
      p_output_size_bytes: fileStat.size,
      p_output_mime_type: mimeType,
    });

    if (completeError) {
      throw new Error(completeError.message);
    }

    console.log(`任务 ${job.id} 已完成`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "模拟Worker处理失败。";
    console.log(`任务 ${job.id} 失败：${message}`);
    await failJob(job.id, workerId, message);
  }
}

async function claimNextJob(workerId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.rpc("claim_next_video_job", {
    p_worker_id: workerId,
    p_lease_seconds: 300,
  });

  if (error) {
    throw new Error(error.message);
  }

  return pickRpcRow<WorkerJob>(data as WorkerJob[] | WorkerJob | null);
}

async function main() {
  const sourcePath = resolveMockVideoSource();
  const onceMode = isOnceMode();

  if (!sourcePath) {
    console.log("没有找到本地演示视频。请准备 public/mock-videos/demo.mp4，或设置 MOCK_VIDEO_SOURCE 指向本地 MP4/WebM。");
    return;
  }

  const workerId = getWorkerId();
  const pollIntervalMs = getPollIntervalMs();
  getSupabaseAdminClientCore();

  console.log(`模拟Worker已启动：${workerId}`);
  console.log(`使用本地演示视频：${sourcePath}`);
  console.log(`运行模式：${onceMode ? "一次性" : "持续轮询"}`);

  if (onceMode) {
    const job = await claimNextJob(workerId);

    if (!job) {
      console.log("没有可处理的任务，一次性Worker正常退出。");
      return;
    }

    await processJob(job, workerId, sourcePath);
    console.log("一次性Worker已退出。");
    return;
  }

  while (!shouldStop) {
    try {
      const job = await claimNextJob(workerId);

      if (!job) {
        await delay(pollIntervalMs);
        continue;
      }

      await processJob(job, workerId, sourcePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "模拟Worker轮询失败。";
      console.log(`Worker轮询出错：${message}`);
      await delay(pollIntervalMs);
    }
  }

  console.log("模拟Worker已退出。");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "模拟Worker启动失败。";
  console.log(`模拟Worker启动失败：${message}`);
  process.exitCode = 1;
});
