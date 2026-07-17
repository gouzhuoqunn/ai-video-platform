import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadModelAvailabilityRegistry } from "./model-availability";
import { loadProductionModelRegistry, PRODUCTION_GPU_CLASSES, PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL } from "./production-models";
export { DEFAULT_PRODUCTION_SCHEDULER_POLICY, loadSchedulerPolicy, type SchedulerPolicy } from "./scheduler-policy";

export const PRODUCTION_VERIFICATION_PATH = path.join(process.cwd(), "comfy-runtime", "production-verification.json");
export const PRODUCTION_READINESS_PATH = path.join(process.cwd(), "comfy-runtime", "production-readiness.json");

export type ProductionVerification = {
  schemaVersion: 1;
  baseline: "stage4e";
  immutable: true;
  verifiedAt: string;
  imageModel: { family: string; revision: string; currentKey: string };
  videoModel: { family: string; revision: string; currentKey: string };
  executionProfile: { gpuClass: string; gpuName: string; vramMiB: number; ramBytes: number; driver: string; cuda: string };
  runtime: { bootstrapMode: string; comfyUiCommit: string; python: string; torch: string; triton: string };
  image: { width: number; height: number; steps: number; seed: number; batch: number; inferenceMs: number; sizeBytes: number; outputSha256: string };
  video: { width: number; height: number; frames: number; fps: number; steps: number; seed: number; batch: number; inferenceMs: number; durationSeconds: number; outputSizeBytes: number; outputSha256: string };
  restores: { imageBytes: number; imageMs: number; videoBytes: number; videoMs: number; parallelDownloads: number; directR2: boolean };
  conversion: { source: string; output: string; faststart: boolean; thumbnail: string };
  cleanup: { runtimeStopped: boolean; providerOrderCancelled: boolean; activeOrders: number; runpodPods: number; runpodVolumes: number; holdsRestored: boolean };
};

export type ProductionReadiness = {
  schemaVersion: 1;
  updatedAt: string;
  model_cache_ready: boolean;
  gpu_inference_verified: boolean;
  normal_ui_pipeline_implemented: boolean;
  normal_ui_pipeline_gpu_verified: boolean;
  daily_use_release_candidate: boolean;
  production_ready: boolean;
  nextAcceptance: string;
};

export function loadProductionVerification(filePath = PRODUCTION_VERIFICATION_PATH): ProductionVerification {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as ProductionVerification;
  if (value.schemaVersion !== 1 || value.baseline !== "stage4e" || value.immutable !== true) throw new Error("production_verification_invalid");
  if (!/^[a-f0-9]{64}$/.test(value.image.outputSha256) || !/^[a-f0-9]{64}$/.test(value.video.outputSha256)) throw new Error("production_verification_sha_invalid");
  if (JSON.stringify(value).match(/[A-Za-z]:[\\/]|\/(?:home|root|workspace|tmp)\//)) throw new Error("production_verification_contains_absolute_path");
  return value;
}

export function loadProductionReadiness(filePath = PRODUCTION_READINESS_PATH): ProductionReadiness {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as ProductionReadiness;
  if (value.schemaVersion !== 1 || value.production_ready !== false || value.normal_ui_pipeline_gpu_verified !== false) throw new Error("production_readiness_semantics_invalid");
  return value;
}

export function productionReadinessGate(modelProfile: string, gpuClass?: string) {
  const verification = loadProductionVerification();
  const availability = loadModelAvailabilityRegistry().models.find((model) => model.modelProfile === modelProfile);
  const registry = loadProductionModelRegistry();
  const family = registry.families.find((entry) => entry.id === modelProfile);
  const verifiedModel = modelProfile === PRODUCTION_IMAGE_MODEL ? verification.imageModel : modelProfile === PRODUCTION_VIDEO_MODEL ? verification.videoModel : null;
  if (!availability || !family || !verifiedModel) return { allowed: false, reason: "该模型不是默认生产模型；仅可在明确的 legacy/debug 模式中使用。", model: availability ?? null };
  if (!availability.cached || !availability.restoreReady || !availability.executableWorkflow) return { allowed: false, reason: "生产模型的 R2 指针、恢复状态或工作流尚未同时就绪。", model: availability };
  if (availability.currentKey !== verifiedModel.currentKey || availability.revision !== verifiedModel.revision || family.currentKey !== verifiedModel.currentKey || family.revision !== verifiedModel.revision) {
    return { allowed: false, reason: "生产缓存指针或模型修订与已验证基线不一致。", model: availability };
  }
  const gpuProfiles = registry.profiles.filter((profile) => profile.familyId === modelProfile && PRODUCTION_GPU_CLASSES.includes(profile.gpuClass as (typeof PRODUCTION_GPU_CLASSES)[number]));
  if (!gpuProfiles.length || gpuProfiles.some((profile) => !existsSync(path.join(process.cwd(), profile.workflow)))) return { allowed: false, reason: "生产工作流文件未就绪。", model: availability };
  if (gpuClass && !gpuProfiles.some((profile) => profile.gpuClass === gpuClass)) return { allowed: false, reason: "所选显卡没有经过登记的生产工作流。", model: availability };
  return { allowed: true, reason: "R2 指针、工作流、显卡配置和 Stage 4E 验证基线一致。", model: availability };
}

export type EstimableTask = {
  generationType: "image" | "video";
  jobForm?: "image_only" | "video_from_generated_image" | "video_from_existing_image";
};

function range(valueMs: number, low = 0.8, high = 1.3) {
  return { minMinutes: Math.max(1, Math.round(valueMs * low / 60_000)), maxMinutes: Math.max(1, Math.round(valueMs * high / 60_000)) };
}

export function estimateProductionSession(tasks: EstimableTask[], options: { activeSession?: boolean; imageModelLoaded?: boolean; videoModelLoaded?: boolean; hourlyUsdRange?: [number, number] } = {}) {
  const verification = loadProductionVerification();
  const imageCount = tasks.filter((task) => task.generationType === "image").length;
  const videoCount = tasks.filter((task) => task.generationType === "video").length;
  const needsImage = imageCount > 0;
  const needsVideo = videoCount > 0;
  const bootstrapMs = options.activeSession ? 0 : 9 * 60_000;
  const imageRestoreMs = needsImage && !options.imageModelLoaded ? verification.restores.imageMs : 0;
  const videoRestoreMs = needsVideo && !options.videoModelLoaded ? verification.restores.videoMs : 0;
  const inferenceMs = imageCount * verification.image.inferenceMs + videoCount * verification.video.inferenceMs;
  const conversionMs = videoCount * 45_000;
  const totalMs = bootstrapMs + imageRestoreMs + videoRestoreMs + inferenceMs + conversionMs;
  const hourly = options.hourlyUsdRange ?? [0.23, 0.35];
  const time = range(totalMs, 0.8, 1.25);
  return {
    imageRestore: range(imageRestoreMs || verification.restores.imageMs),
    videoRestore: range(videoRestoreMs || verification.restores.videoMs),
    imageInference: range(verification.image.inferenceMs),
    videoInference: range(verification.video.inferenceMs),
    totalSession: time,
    projectedComputeUsd: {
      min: Number((time.minMinutes / 60 * hourly[0]).toFixed(2)),
      max: Number((time.maxMinutes / 60 * hourly[1]).toFixed(2)),
    },
    creationFeeCaveat: "Clore 创建费、租客费和按分钟取整可能使钱包扣款高于纯计算估算。",
    gpuToR2Restore: true,
    userLocalDownloadBytesExcluded: true,
    reuse: {
      activeSession: options.activeSession === true,
      imageModel: needsImage && options.imageModelLoaded === true,
      videoModel: needsVideo && options.videoModelLoaded === true,
    },
  };
}

export type GroupableProductionTask = EstimableTask & {
  id: string;
  modelProfile: string;
  modelRevision?: string;
  gpuPreference: string[];
  width?: number;
  height?: number;
  frames?: number | null;
  contentMode?: "production" | "legacy_debug";
  inputImageJobId?: string | null;
  inputImageVerified?: boolean;
};

export function productionBatchGroupingKey(task: GroupableProductionTask) {
  const profile = `${task.width ?? 0}x${task.height ?? 0}x${task.frames ?? 1}`;
  return [task.modelProfile, task.modelRevision ?? "current", [...task.gpuPreference].sort().join("+"), profile, task.contentMode ?? "production", task.inputImageJobId ? "i2v" : "no-input"].join("|");
}

export function planSequentialProductionSession(tasks: GroupableProductionTask[]) {
  const imageTasks = tasks.filter((task) => task.generationType === "image");
  const availableImageIds = new Set(imageTasks.map((task) => task.id));
  const videoTasks = tasks.filter((task) => task.generationType === "video" && task.inputImageJobId && (task.inputImageVerified || availableImageIds.has(task.inputImageJobId)));
  const group = (items: GroupableProductionTask[]) => {
    const groups = new Map<string, GroupableProductionTask[]>();
    for (const task of items) {
      const key = productionBatchGroupingKey(task);
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    return [...groups.entries()].map(([key, groupedTasks]) => ({ key, tasks: groupedTasks }));
  };
  return {
    imageGroups: group(imageTasks),
    unloadImageModels: imageTasks.length > 0 && videoTasks.length > 0,
    videoGroups: group(videoTasks),
    skippedVideoTaskIds: tasks.filter((task) => task.generationType === "video" && !videoTasks.includes(task)).map((task) => task.id),
    failureIsolation: "per_job",
    cleanupAfterFinalTask: true,
  };
}
