"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { VIDEO_JOB_SELECT_FIELDS } from "@/lib/video-jobs/fields";
import { requestSignedVideoUrl } from "@/lib/video-jobs/signed-url";
import { videoJobStatusLabels } from "@/types/video-config";
import type { SignedVideoResponse, VideoJob, VideoJobStatus } from "@/types/video-jobs";
import { normalizeStudioMode, normalizeVideoSubmode, STUDIO_MODE_STORAGE_KEY, VIDEO_SUBMODE_STORAGE_KEY, type OrdinaryStudioMode, type StudioMode } from "@/lib/local-lab/studio-mode";
import { isManualCandidateDisplayPriceAllowed, LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR } from "@/lib/local-lab/gpu-price-filter";
import { LongVideoStudio, longVideoPublicMediaUrl, type LongVideoProject } from "@/components/LongVideoStudio";
import { BillingPanel } from "@/components/BillingPanel";
import { FirstFrameInput } from "@/components/FirstFrameInput";
import {
  defaultGpuExecutionState,
  executionActionFor,
  rentalEligibilityFor,
  type ConfirmedQueueCounts,
  type GpuExecutionState,
  type RequiredGpuClass,
} from "@/lib/generation/gpu-execution-state";
import type { VideoModelKey } from "@/lib/generation/video-profiles";
import { mergeTasksByUpdatedAt, selectGalleryTasks, type TaskMediaType, type VideoTaskSubtype } from "@/lib/generation/gallery-routing";

type JobCounts = Partial<Record<VideoJobStatus, number>>;

type CloreCandidateSummary = {
  server_id: string;
  gpu: string;
  gpu_count?: number | null;
  gpu_memory_gb: number | null;
  gpu_memory_raw_value: number | null;
  gpu_memory_raw_unit: string | null;
  ram_gb: number | null;
  cpu_cores: number | null;
  disk_gb: number | null;
  download_mbps: number | null;
  upload_mbps: number | null;
  reliability: number | null;
  rating: number | null;
  rating_count: number | null;
  country: string | null;
  normalized_usd_per_hour: number | null;
  base_usd_per_hour?: number | null;
  effective_usd_per_hour?: number | null;
  creation_fee_usd?: number | null;
  max_session_projected_total_usd?: number | null;
  original_on_demand_price: string | null;
  currently_rentable: boolean;
  risk_tier: "A" | "B" | "reject";
  rejection_reasons?: string[];
};

type CloreCandidatesResponse = {
  source: string;
  wallet?: { available_usd_balance: number | null };
  matches: CloreCandidateSummary[];
  error?: string;
};

type LocalResult = {
  jobId: string;
  hasVideo: boolean;
  hasThumbnail: boolean;
  videoUrl: string | null;
  thumbnailUrl: string | null;
};

type AutorentRequest = {
  id: string;
  status: "waiting" | "searching" | "candidate_found" | "provisioning" | "assigned" | "failed" | "cancelled";
  priority: "normal" | "urgent";
  selected_server_id: string | null;
  max_effective_hourly_usd: number;
  created_at: string;
};

type ImageResult = { sessionId: string; date: string; metadata: Record<string, unknown> | null; imageUrl: string };
type PendingImage = { sessionId: string; completedStages: string[]; status: "pending" | "completed" };
type RentalPlan = {
  nonce: string;
  server_id: string;
  max_price_usd_per_hour: number;
  required_confirmation_text: string;
  expires_at: string;
  generation_family: OrdinaryStudioMode;
  gpu_class: RequiredGpuClass;
  confirmed_task_ids: string[];
};
type PoolTaskStatus = "waiting_for_local_audio" | "local_audio_queued" | "local_audio_generating" | "local_audio_failed" | "local_audio_ready" | "pending_confirmation" | "waiting_for_batch" | "armed" | "waiting_for_gpu" | "deploying" | "provisioning" | "restoring_models" | "restoring_image_model" | "generating_image" | "unloading_image_model" | "restoring_video_model" | "generating_video" | "downloading_transcoding" | "generating" | "syncing" | "cancel_requested" | "completed" | "failed" | "cancelled";
type PoolTask = {
  id: string;
  mediaType: TaskMediaType;
  videoSubtype: VideoTaskSubtype;
  galleryParentId: string | null;
  classificationError: string | null;
  generationType: OrdinaryStudioMode;
  prompt: string;
  negativePrompt: string;
  modelProfile: string;
  modelRevision: string;
  gpuPreference: string[];
  requiredGpuClass: RequiredGpuClass;
  priority: "normal" | "immediate";
  status: PoolTaskStatus;
  createdAt: string;
  updatedAt: string;
  jobForm: "image_only" | "video_from_generated_image" | "video_from_existing_image" | "long_video_segment" | "long_video_first_frame";
  inputImageJobId: string | null;
  generationNumber: number;
  width: number;
  height: number;
  frames: number | null;
  fps: number | null;
  audioOrigin?: "none" | "local_voice_conditioning" | "native_model";
  audioBinding?: { status: "waiting_for_local_audio" | "local_audio_queued" | "local_audio_generating" | "local_audio_failed" | "local_audio_ready" } | null;
  attempts: Array<{ id: string; number: number; resumeBoundary: PoolTaskStatus; status: string }>;
};
type ProductionModelSummary = { modelProfile: string; displayName: string; cacheStatus: string; cacheReady: boolean; inferenceVerified: boolean; workflowReady: boolean; restoreBytes: number; uniqueRestoreBytes: number; sharedBytes: number; revision: string; gpuProfiles: string[] };
type PoolSummary = {
  tasks: PoolTask[];
  invalidTaskRecords?: Array<{ id: string; mediaType: TaskMediaType; error: string | null }>;
  counts: Partial<Record<PoolTaskStatus, number>>;
  schedulerState: string;
  selectedBatchId: string | null;
  imageBatchThreshold: number;
  videoBatchThreshold: number;
  combinedBatchThreshold: number;
  maximumWaitMinutes: number;
  tasksNeeded: { image: number; video: number };
  deploymentHold: boolean;
  marketMonitoringActive: boolean;
  estimatedMaximumSessionCost: number;
  orderBlockingReason: string;
  productionModels: Record<OrdinaryStudioMode, ProductionModelSummary>;
  estimatedSessionDurationMinutes: { minMinutes: number; maxMinutes: number };
  costEstimate: {
    imageRestore: { minMinutes: number; maxMinutes: number };
    videoRestore: { minMinutes: number; maxMinutes: number };
    imageInference: { minMinutes: number; maxMinutes: number };
    videoInference: { minMinutes: number; maxMinutes: number };
    totalSession: { minMinutes: number; maxMinutes: number };
    projectedComputeUsd: { min: number; max: number };
    creationFeeCaveat: string;
    reuse: { activeSession: boolean; imageModel: boolean; videoModel: boolean };
  };
  session: {
    phase: string;
    activeTaskIds: string[];
    approximateSpendUsd: number;
    estimatedRemainingMinutes: number;
    automaticShutdownAt: string | null;
    shutdownMode: "immediate" | "after_current" | null;
  } | null;
  confirmedQueueCounts: ConfirmedQueueCounts;
  confirmedVideoQueueCounts: Record<"silent" | "audible", Record<RequiredGpuClass, number>>;
  execution: GpuExecutionState;
  readiness: {
    model_cache_ready: boolean;
    gpu_inference_verified: boolean;
    normal_ui_pipeline_implemented: boolean;
    normal_ui_pipeline_gpu_verified: boolean;
    daily_use_release_candidate: boolean;
    production_ready: boolean;
  };
};

function mergePoolSummary(current: PoolSummary | null, incoming: PoolSummary): PoolSummary {
  if (!current) return incoming;
  return { ...incoming, tasks: mergeTasksByUpdatedAt(current.tasks, incoming.tasks) };
}

const poolStatusLabels: Record<PoolTaskStatus, string> = {
  waiting_for_local_audio: "等待本地生成声音", local_audio_queued: "声音正在本地队列中等待", local_audio_generating: "声音正在生成", local_audio_failed: "声音生成失败", local_audio_ready: "声音生成成功",
  pending_confirmation: "待确认", waiting_for_batch: "等待凑批", armed: "已准备", waiting_for_gpu: "等待显卡",
  deploying: "正在部署", restoring_models: "正在恢复模型", generating: "正在生成", syncing: "正在同步",
  provisioning: "正在准备主机", restoring_image_model: "恢复图片模型", generating_image: "生成图片",
  unloading_image_model: "卸载图片模型", restoring_video_model: "恢复视频模型", generating_video: "生成视频",
  downloading_transcoding: "下载并转码", cancel_requested: "等待安全停止",
  completed: "已完成", failed: "失败", cancelled: "已取消",
};
const schedulerStateLabels: Record<string, string> = {
  idle: "空闲", batch_ready: "批次已就绪", market_watching: "正在观察市场", candidate_found: "已找到候选",
  order_pending: "等待创建订单", session_active: "显卡会话运行中", draining: "正在排空", cleanup_pending: "等待清理", completed: "已完成", blocked_by_provider: "平台阻塞",
};
const autorentStatusLabels: Record<AutorentRequest["status"], string> = {
  waiting: "等待中", searching: "寻找显卡", candidate_found: "已找到候选", provisioning: "正在部署", assigned: "已分配", failed: "失败", cancelled: "已取消",
};

const starterPrompt = "整洁的五秒纯文字片头，电影感灯光，无人物，无标志。";
const emptyExecution = defaultGpuExecutionState(0);
const EXECUTION_QUEUE_STORAGE_KEY = "ai-video-platform:execution-queue:v1";

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" ? `$${value.toFixed(3)}` : "未确认";
}

function formatNumber(value: number | null | undefined, suffix = "") {
  return typeof value === "number" ? `${Number(value.toFixed(3))}${suffix}` : "未知";
}

function safePromptPreview(prompt: string) {
  return prompt.length > 76 ? `${prompt.slice(0, 76)}...` : prompt;
}

function generationLabel(job: VideoJob) {
  if (job.generation_number <= 1) return "原视频";
  if (job.generation_number === 2) return "二次生成";
  if (job.generation_number === 3) return "三次生成";
  return `第${job.generation_number}次生成`;
}

function statusBadgeClass(status: VideoJobStatus) {
  if (status === "pending_confirmation") return "border-zinc-300 bg-zinc-50 text-zinc-800";
  if (status === "queued") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "processing") return "border-sky-200 bg-sky-50 text-sky-800";
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-stone-200 bg-stone-100 text-stone-700";
}

function queueOrder(jobs: VideoJob[]) {
  return [...jobs]
    .filter((job) => job.status === "queued")
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority === "urgent" ? -1 : 1;
      return Date.parse(left.confirmed_at ?? left.created_at) - Date.parse(right.confirmed_at ?? right.created_at);
    });
}

function etaText(job: VideoJob | null, jobs: VideoJob[]) {
  if (!job) return "暂无任务";
  const fallbackMinutes = 8;
  if (job.status === "pending_confirmation") return "尚未确认生成";
  if (job.status === "queued") {
    const queue = queueOrder(jobs);
    const ahead = Math.max(0, queue.findIndex((item) => item.id === job.id));
    return `前方还有 ${ahead} 个任务，约 ${Math.max(1, (ahead + 1) * fallbackMinutes)} 分钟`;
  }
  if (job.status === "processing") {
    const remaining = Math.max(1, Math.round(fallbackMinutes * (1 - job.progress / 100)));
    return `生成中，约 ${remaining} 分钟`;
  }
  if (job.status === "succeeded") return "已完成";
  if (job.status === "failed") return "生成失败";
  return "已取消";
}

function parsePrice(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function qualityBadge(width: number, height: number) {
  if (width >= 1920 || height >= 1920) return "高";
  if (width >= 1280 || height >= 720) return "中";
  return "低";
}

function longVideoCardClass(project: LongVideoProject) {
  if (project.status === "failed") return "border-rose-200 bg-rose-50";
  if (project.gpuPreference.length === 1 && project.gpuPreference[0] === "rtx5090") return "border-emerald-200 bg-emerald-50";
  if (project.gpuPreference.length === 1 && project.gpuPreference[0] === "rtx4090") return "border-sky-200 bg-sky-50";
  return "border-stone-200 bg-stone-100";
}

function imageResultQuality(metadata: Record<string, unknown> | null) {
  const width = Number(metadata?.final_width ?? metadata?.width ?? metadata?.generation_width ?? 0);
  const height = Number(metadata?.final_height ?? metadata?.height ?? metadata?.generation_height ?? 0);
  return qualityBadge(width, height);
}

export function LocalCreationStudio() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [prompt, setPrompt] = useState(starterPrompt);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [counts, setCounts] = useState<JobCounts>({});
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [selectedPoolTaskIds, setSelectedPoolTaskIds] = useState<string[]>([]);
  const poolRefreshSequence = useRef(0);
  const [signedVideos, setSignedVideos] = useState<Record<string, SignedVideoResponse>>({});
  const [localResults, setLocalResults] = useState<LocalResult[]>([]);
  const [candidates, setCandidates] = useState<CloreCandidateSummary[]>([]);
  const [candidateSource, setCandidateSource] = useState("");
  const [selectedServerId, setSelectedServerId] = useState("");
  const [detailServer, setDetailServer] = useState<CloreCandidateSummary | null>(null);
  const [autorentRequests, setAutorentRequests] = useState<AutorentRequest[]>([]);
  const [notice, setNotice] = useState("正在恢复本地实验会话...");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isBatching, setIsBatching] = useState(false);
  const [selectedExecutionGpuClass, setSelectedExecutionGpuClass] = useState<RequiredGpuClass | null>(null);
  const [selectedVideoModelKey, setSelectedVideoModelKey] = useState<VideoModelKey | null>(null);
  const [isStartingExecution, setIsStartingExecution] = useState(false);
  const [pendingGpuAction, setPendingGpuAction] = useState<"stop" | "stop_model" | "cancel" | null>(null);
  const [rentalSuccessOpen, setRentalSuccessOpen] = useState(false);
  const [rentalPlan, setRentalPlan] = useState<RentalPlan | null>(null);
  const [rentalConfirmationText, setRentalConfirmationText] = useState("");
  const [rentalRiskAccepted, setRentalRiskAccepted] = useState(false);
  const [selectedLongVideoIds, setSelectedLongVideoIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | VideoJobStatus>("all");
  const [minPrice, setMinPrice] = useState("0");
  const [maxPrice, setMaxPrice] = useState(String(LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR));
  const [mode, setMode] = useState<StudioMode>("video");
  const [videoSubmode, setVideoSubmode] = useState<"video" | "long_video">("video");
  const [imageResults, setImageResults] = useState<ImageResult[]>([]);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [selectedImageId, setSelectedImageId] = useState("");
  const [pool, setPool] = useState<PoolSummary | null>(null);
  const [negativePrompt, setNegativePrompt] = useState("");
  const [seed, setSeed] = useState("");
  const [imageSizePreset, setImageSizePreset] = useState<"square_1024" | "medium_image_4090" | "medium_image_5090" | "high_image_5090">("square_1024");
  const [videoSource, setVideoSource] = useState<"generated" | "existing">("generated");
  const [videoProfile, setVideoProfile] = useState<"low_video_4090" | "medium_video_4090" | "medium_video_5090" | "high_video_5090" | "audible_low_video_4090" | "audible_medium_video_5090" | "audible_high_video_5090">("low_video_4090");
  const [existingImageJobId, setExistingImageJobId] = useState("");
  const [uploadedFirstFrameRef, setUploadedFirstFrameRef] = useState("");
  const [showBilling, setShowBilling] = useState(false);
  const [longVideoProjects, setLongVideoProjects] = useState<LongVideoProject[]>([]);
  const [selectedLongVideoId, setSelectedLongVideoId] = useState("");
  const [selectedLongSegmentIndex, setSelectedLongSegmentIndex] = useState(0);
  const [selectedVideoKind, setSelectedVideoKind] = useState<"short" | "long">("short");
  const [clockNow, setClockNow] = useState(0);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const automaticCancelRequested = useRef(false);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const localResultForSelected = selectedJob ? localResults.find((result) => result.jobId === selectedJob.id) : null;
  const visibleJobs = filter === "all" ? jobs : jobs.filter((job) => job.status === filter);
  const pendingJobs = visibleJobs.filter((job) => job.status === "pending_confirmation");
  const selectedPendingCount = selectedJobIds.filter((id) => jobs.find((job) => job.id === id)?.status === "pending_confirmation").length;
  const activeAutorent = autorentRequests.find((request) => !["assigned", "failed", "cancelled"].includes(request.status));
  const selectedImage = imageResults.find((result) => result.sessionId === selectedImageId) ?? imageResults[0] ?? null;
  const ordinaryMode: OrdinaryStudioMode = mode === "long_video" ? "video" : mode;
  const modePoolTasks = pool ? selectGalleryTasks(pool.tasks, ordinaryMode) : [];
  const selectedPoolTask = selectedPoolTaskIds.length ? (pool?.tasks.find((task) => task.id === selectedPoolTaskIds[0]) ?? null) : null;
  const selectedPoolFamily = selectedPoolTask?.generationType ?? null;
  const poolTaskSelectable = (task: PoolTask) => {
    if (task.status !== "pending_confirmation" && task.status !== "local_audio_ready") return false;
    if (task.audioOrigin === "local_voice_conditioning" && task.audioBinding?.status !== "local_audio_ready") return false;
    if (selectedPoolFamily && task.generationType !== selectedPoolFamily) return false;
    return true;
  };
  const queuedPoolTasks = modePoolTasks.filter((task) => ["waiting_for_batch", "armed", "waiting_for_gpu"].includes(task.status));
  const poolVideoResult = localResults.find((result) => pool?.tasks.some((task) => task.generationType === "video" && task.id === result.jobId)) ?? null;
  const poolVideoTask = poolVideoResult ? pool?.tasks.find((task) => task.id === poolVideoResult.jobId) ?? null : null;
  const previewVideoResult = localResultForSelected ?? poolVideoResult;
  const showingPoolVideo = Boolean(poolVideoResult && previewVideoResult?.jobId === poolVideoResult.jobId && !localResultForSelected);
  const mainVideoUrl = previewVideoResult?.videoUrl ?? (selectedJob ? signedVideos[selectedJob.id]?.signedUrl : null);
  const selectedLongVideo = longVideoProjects.find((project) => project.id === selectedLongVideoId) ?? longVideoProjects[0] ?? null;
  const acceptedLongSegments = selectedLongVideo?.segments.filter((segment) => ["accepted", "awaiting_review"].includes(segment.status) && segment.selectedAttemptId) ?? [];
  const latestAcceptedLongSegment = acceptedLongSegments.at(-1) ?? null;
  const selectedLongSegment = selectedLongVideo?.segments[selectedLongSegmentIndex] ?? latestAcceptedLongSegment;
  const playableLongSegment = selectedLongSegment?.selectedAttemptId && ["accepted", "awaiting_review"].includes(selectedLongSegment.status) ? selectedLongSegment : latestAcceptedLongSegment;
  const longVideoPreviewUrl = selectedLongVideo
    ? selectedLongVideo.finalVideoRef
      ? longVideoPublicMediaUrl(selectedLongVideo.id, "video")
      : playableLongSegment
        ? longVideoPublicMediaUrl(selectedLongVideo.id, "segment-video", playableLongSegment)
        : null
    : null;
  const activeVideoUrl = selectedVideoKind === "long" ? longVideoPreviewUrl : mainVideoUrl;
  const previewFolderRequest = useMemo(() => {
    if (mode === "image" && selectedImage) return { label: "打开图片文件夹", identity: { kind: "image", sessionId: selectedImage.sessionId } };
    if (selectedVideoKind === "long" && selectedLongVideo) {
      if (selectedLongVideo.finalVideoRef) return { label: "打开长视频文件夹", identity: { kind: "long-video", projectId: selectedLongVideo.id } };
      if (playableLongSegment?.selectedAttemptId) return { label: "打开片段文件夹", identity: { kind: "long-video-segment", projectId: selectedLongVideo.id, sequenceIndex: playableLongSegment.sequenceIndex, attemptId: playableLongSegment.selectedAttemptId } };
    }
    if (previewVideoResult?.videoUrl) return { label: "打开视频文件夹", identity: { kind: "short-video", jobId: previewVideoResult.jobId } };
    return null;
  }, [mode, playableLongSegment, previewVideoResult, selectedImage, selectedLongVideo, selectedVideoKind]);
  const execution = pool?.execution ?? emptyExecution;
  const visibleQueueCounts = useMemo(() => {
    if (ordinaryMode === "image") return pool?.confirmedQueueCounts?.image ?? { rtx4090: 0, rtx5090: 0 };
    const soundMode = selectedVideoModelKey === "video_ltx_native_audio" ? "audible" : "silent";
    return pool?.confirmedVideoQueueCounts?.[soundMode] ?? { rtx4090: 0, rtx5090: 0 };
  }, [ordinaryMode, pool?.confirmedQueueCounts, pool?.confirmedVideoQueueCounts, selectedVideoModelKey]);
  const selectedQueueCount = selectedExecutionGpuClass ? visibleQueueCounts[selectedExecutionGpuClass] : 0;
  const rentalEligibility = useMemo(() => rentalEligibilityFor({
    state: execution,
    tasks: pool?.tasks ?? [],
    family: ordinaryMode,
    gpuClass: selectedExecutionGpuClass,
    modelKey: ordinaryMode === "video" ? selectedVideoModelKey : "image_flux",
    manualAuthorization: true,
  }), [execution, ordinaryMode, pool?.tasks, selectedExecutionGpuClass, selectedVideoModelKey]);
  const executionAction = selectedExecutionGpuClass
    ? rentalEligibility.eligible
      ? executionActionFor(execution, ordinaryMode, selectedExecutionGpuClass, rentalEligibility.executableCount)
      : { kind: "blocked" as const, label: null, disabled: true, reason: rentalEligibility.reason }
    : null;
  const queueSelectionLocked = isStartingExecution || ["searching", "deploying", "stopping", "canceling"].includes(execution.activity);
  const idleCancelSeconds = execution.idleCancelAt && clockNow
    ? Math.max(0, Math.ceil((Date.parse(execution.idleCancelAt) - clockNow) / 1000))
    : 120;
  const activeQueue = pool?.tasks.filter((task) => !["completed", "cancelled"].includes(task.status)) ?? [];
  const simplifiedSessionStatus = activeQueue.some((task) => ["failed"].includes(task.status))
    ? "失败"
    : activeQueue.some((task) => ["generating", "generating_image", "generating_video", "downloading_transcoding", "syncing"].includes(task.status))
      ? "生成中"
      : activeQueue.length
        ? "排队"
        : "已完成";
  const deployedFamilyLabel = execution.deployedModel === "image_flux" ? "图片模型" : execution.deployedModel === "video_wan_silent" ? "无声视频模型" : execution.deployedModel === "video_ltx_native_audio" ? "有声视频模型" : execution.deployedModel === "none" ? "未部署" : "状态未知";
  const currentModeDeployed = Boolean(execution.rentedGpuClass) && execution.deployedFamily === ordinaryMode;
  const activeGenerationFamily = execution.activeExecution?.generationFamily ?? (execution.deployedFamily === "image" || execution.deployedFamily === "video" ? execution.deployedFamily : null);
  const executionQueueOptions = ordinaryMode === "image"
    ? ([{ gpuClass: "rtx4090", modelKey: null, label: "RTX 4090", count: pool?.confirmedQueueCounts?.image.rtx4090 ?? 0 }, { gpuClass: "rtx5090", modelKey: null, label: "RTX 5090", count: pool?.confirmedQueueCounts?.image.rtx5090 ?? 0 }] as const)
    : ([
      { gpuClass: "rtx4090", modelKey: "video_wan_silent", label: "无声 RTX 4090", count: pool?.confirmedVideoQueueCounts?.silent.rtx4090 ?? 0 },
      { gpuClass: "rtx5090", modelKey: "video_wan_silent", label: "无声 RTX 5090", count: pool?.confirmedVideoQueueCounts?.silent.rtx5090 ?? 0 },
      { gpuClass: "rtx4090", modelKey: "video_ltx_native_audio", label: "有声 RTX 4090", count: pool?.confirmedVideoQueueCounts?.audible.rtx4090 ?? 0 },
      { gpuClass: "rtx5090", modelKey: "video_ltx_native_audio", label: "有声 RTX 5090", count: pool?.confirmedVideoQueueCounts?.audible.rtx5090 ?? 0 },
    ] as const);

  async function openPreviewFolder() {
    if (!previewFolderRequest || isOpeningFolder) return;
    setIsOpeningFolder(true);
    try {
      const response = await fetch("/api/local-lab/open-folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(previewFolderRequest.identity),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setNotice(payload.error ?? "无法打开本地文件夹。");
    } catch {
      setNotice("无法打开本地文件夹，请确认平台正在 Windows 本机运行。");
    } finally {
      setIsOpeningFolder(false);
    }
  }

  const selectExecutionQueue = useCallback((gpuClass: RequiredGpuClass | null, modelKey: VideoModelKey | null = null) => {
    setSelectedExecutionGpuClass(gpuClass);
    if (ordinaryMode === "video") setSelectedVideoModelKey(modelKey);
    if (gpuClass) window.localStorage.setItem(EXECUTION_QUEUE_STORAGE_KEY, JSON.stringify({ family: ordinaryMode, gpuClass, modelKey }));
    else window.localStorage.removeItem(EXECUTION_QUEUE_STORAGE_KEY);
  }, [ordinaryMode]);

  const priceGate = useMemo(() => {
    const min = parsePrice(minPrice);
    const max = parsePrice(maxPrice);
    const valid = min !== null && max !== null && min >= 0 && min <= max && isManualCandidateDisplayPriceAllowed(max);
    return { min, max, valid };
  }, [maxPrice, minPrice]);

  const filteredCandidates = useMemo(() => {
    if (!priceGate.valid || priceGate.min === null || priceGate.max === null) return [];
    return candidates
      .filter((candidate) => {
        const effective = candidate.effective_usd_per_hour ?? (candidate.normalized_usd_per_hour ? candidate.normalized_usd_per_hour * 1.05 : null);
        const gpuClass = /5090/i.test(candidate.gpu) ? "rtx5090" : /4090/i.test(candidate.gpu) ? "rtx4090" : null;
        return effective !== null
          && effective >= priceGate.min!
          && effective <= priceGate.max!
          && isManualCandidateDisplayPriceAllowed(effective)
          && (!selectedExecutionGpuClass || gpuClass === selectedExecutionGpuClass);
      })
      .sort((left, right) => {
        const leftPrice = left.effective_usd_per_hour ?? Number.POSITIVE_INFINITY;
        const rightPrice = right.effective_usd_per_hour ?? Number.POSITIVE_INFINITY;
        return leftPrice - rightPrice;
      });
  }, [candidates, priceGate.max, priceGate.min, priceGate.valid, selectedExecutionGpuClass]);

  const selectedCandidate = selectedServerId ? filteredCandidates.find((candidate) => candidate.server_id === selectedServerId) ?? null : null;

  const refreshJobs = useCallback(async (currentUser: User | null = user) => {
    if (!supabase || !currentUser) {
      setJobs([]);
      setCounts({});
      return;
    }

    const { data, error } = await supabase
      .from("video_jobs")
      .select(VIDEO_JOB_SELECT_FIELDS)
      .eq("user_id", currentUser.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      setNotice("无法读取本地任务，请确认数据库迁移已应用。");
      return;
    }

    const nextJobs = ((data as VideoJob[] | null) ?? []).filter((job) => !job.deleted_at);
    const nextCounts = nextJobs.reduce<JobCounts>((acc, job) => {
      acc[job.status] = (acc[job.status] ?? 0) + 1;
      return acc;
    }, {});
    setJobs(nextJobs);
    setCounts(nextCounts);
    setSelectedJobId((current) => current || nextJobs[0]?.id || "");
    setSelectedJobIds((current) => current.filter((id) => nextJobs.some((job) => job.id === id)));
  }, [supabase, user]);

  const refreshResults = useCallback(async () => {
    const response = await fetch("/api/local-lab/results");
    const payload = (await response.json().catch(() => ({}))) as { results?: LocalResult[] };
    if (response.ok) setLocalResults(payload.results ?? []);
  }, []);

  const refreshImageResults = useCallback(async () => {
    const response = await fetch("/api/local-lab/image-results");
    const payload = (await response.json().catch(() => ({}))) as { results?: ImageResult[]; pending?: PendingImage | null };
    if (!response.ok) return;
    setImageResults(payload.results ?? []);
    setPendingImage(payload.pending ?? null);
    setSelectedImageId((current) => current || payload.results?.[0]?.sessionId || "");
  }, []);

  const refreshPool = useCallback(async () => {
    const sequence = ++poolRefreshSequence.current;
    const query = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const fixture = query?.get("gpu_fixture");
    const response = await fetch(`/api/local-lab/generation-pool${fixture ? `?fixture=${encodeURIComponent(fixture)}` : ""}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as PoolSummary | null;
    if (sequence === poolRefreshSequence.current && response.ok && payload) setPool((current) => mergePoolSummary(current, payload));
  }, []);

  const refreshLongVideos = useCallback(async () => {
    const response = await fetch("/api/local-lab/long-video");
    const payload = await response.json().catch(() => ({})) as { projects?: LongVideoProject[] };
    if (!response.ok) return;
    setLongVideoProjects(payload.projects ?? []);
    setSelectedLongVideoId((current) => current || payload.projects?.[0]?.id || "");
  }, []);

  const searchCloreCandidates = useCallback(async () => {
    const useVisualMock = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("visual_mock") === "1";
    const candidateResponse = await fetch(`/api/local-lab/clore/candidates${useVisualMock ? "?mock=1" : ""}`);
    const candidatePayload = (await candidateResponse.json().catch(() => ({}))) as CloreCandidatesResponse;
    if (candidateResponse.ok) {
      setCandidates(candidatePayload.matches ?? []);
      setCandidateSource(candidatePayload.source ?? "");
      setSelectedServerId((current) => (current && candidatePayload.matches?.some((candidate) => candidate.server_id === current) ? current : candidatePayload.matches?.[0]?.server_id || ""));
    }
    return candidateResponse.ok ? candidatePayload.matches ?? [] : [];
  }, []);

  const refreshClore = useCallback(async () => {
    const [, autorentResponse] = await Promise.all([
      searchCloreCandidates(),
      fetch("/api/local-lab/clore/autorent"),
    ]);
    const autorentPayload = (await autorentResponse.json().catch(() => ({}))) as { requests?: AutorentRequest[] };
    if (autorentResponse.ok) setAutorentRequests(autorentPayload.requests ?? []);
  }, [searchCloreCandidates]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    // Hydration starts from the same deterministic snapshot as the server.
    // Legacy contract: setMode(normalizeStudioMode(window.localStorage.getItem(STUDIO_MODE_STORAGE_KEY)))
    const storedMode = normalizeStudioMode(window.localStorage.getItem(STUDIO_MODE_STORAGE_KEY));
    setMode(storedMode);
    setVideoSubmode(normalizeVideoSubmode(window.localStorage.getItem(VIDEO_SUBMODE_STORAGE_KEY) ?? storedMode));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    const auth = client.auth;
    let mounted = true;

    async function restore() {
      const response = await fetch("/api/local-lab/session", { method: "POST" });
      if (!mounted) return;
      if (!response.ok) {
        setNotice("本地账号恢复失败，请确认通过 127.0.0.1 访问并已配置 local_lab。");
        return;
      }
      const { data } = await auth.getUser();
      if (!mounted) return;
      setUser(data.user);
      setNotice("本地实验模式已就绪。自动调度仅使用Clore，并受任务与候选安全门控制。");
      await Promise.all([refreshJobs(data.user), refreshResults(), refreshImageResults(), refreshClore(), refreshPool(), refreshLongVideos()]);
    }

    void restore();
    return () => {
      mounted = false;
    };
  }, [refreshClore, refreshImageResults, refreshJobs, refreshLongVideos, refreshPool, refreshResults, supabase]);

  useEffect(() => {
    if (!pool) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    const active = pool.execution.activeExecution;
    if (active?.generationFamily === ordinaryMode && visibleQueueCounts[active.gpuClass] > 0) {
      setSelectedExecutionGpuClass(active.gpuClass);
      return;
    }
    try {
      const stored = JSON.parse(window.localStorage.getItem(EXECUTION_QUEUE_STORAGE_KEY) ?? "null") as { family?: OrdinaryStudioMode; gpuClass?: RequiredGpuClass; modelKey?: VideoModelKey } | null;
      if (stored?.family === ordinaryMode && (stored.gpuClass === "rtx4090" || stored.gpuClass === "rtx5090") && visibleQueueCounts[stored.gpuClass] > 0) {
        setSelectedExecutionGpuClass(stored.gpuClass);
        if (ordinaryMode === "video" && (stored.modelKey === "video_wan_silent" || stored.modelKey === "video_ltx_native_audio")) setSelectedVideoModelKey(stored.modelKey);
      } else if (selectedExecutionGpuClass && visibleQueueCounts[selectedExecutionGpuClass] === 0) {
        setSelectedExecutionGpuClass(null);
        window.localStorage.removeItem(EXECUTION_QUEUE_STORAGE_KEY);
      }
    } catch {
      window.localStorage.removeItem(EXECUTION_QUEUE_STORAGE_KEY);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [ordinaryMode, pool, selectedExecutionGpuClass, visibleQueueCounts]);

  function selectMode(next: StudioMode) {
    setMode(next);
    setSelectedPoolTaskIds([]);
    if (!queueSelectionLocked) selectExecutionQueue(null);
    window.localStorage.setItem(STUDIO_MODE_STORAGE_KEY, next);
    if (next === "video" || next === "long_video") {
      setVideoSubmode(next === "long_video" ? "long_video" : "video");
      window.localStorage.setItem(VIDEO_SUBMODE_STORAGE_KEY, next === "long_video" ? "long_video" : "video");
    }
  }

  function selectVideoSubmode(next: "video" | "long_video") {
    setVideoSubmode(next);
    setMode(next);
    setSelectedPoolTaskIds([]);
    if (!queueSelectionLocked) selectExecutionQueue(null);
    window.localStorage.setItem(VIDEO_SUBMODE_STORAGE_KEY, next);
    window.localStorage.setItem(STUDIO_MODE_STORAGE_KEY, next);
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshJobs();
      void refreshResults();
      void refreshImageResults();
      void refreshClore();
      void refreshPool();
      void refreshLongVideos();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refreshClore, refreshImageResults, refreshJobs, refreshLongVideos, refreshPool, refreshResults]);

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (execution.notice === "rental_succeeded") setRentalSuccessOpen(true);
    if (execution.notice === "gpu_canceled") selectExecutionQueue(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [execution.notice, selectExecutionQueue]);

  useEffect(() => {
    const due = execution.activity === "idle"
      && Boolean(execution.rentedGpuClass)
      && Boolean(execution.idleCancelAt)
      && idleCancelSeconds <= 0;
    if (!due) {
      automaticCancelRequested.current = false;
      return;
    }
    if (automaticCancelRequested.current) return;
    automaticCancelRequested.current = true;
    void requestGpuAction("cancel_gpu", true);
  }, [execution.activity, execution.idleCancelAt, execution.rentedGpuClass, idleCancelSeconds]);

  useEffect(() => {
    if (!selectedJob || selectedJob.status !== "succeeded" || localResultForSelected?.videoUrl || signedVideos[selectedJob.id]) return;
    void requestSignedVideoUrl(selectedJob.id)
      .then((signedVideo) => setSignedVideos((current) => ({ ...current, [selectedJob.id]: signedVideo })))
      .catch((error) => setNotice(error instanceof Error ? error.message : "获取临时播放链接失败。"));
  }, [localResultForSelected?.videoUrl, selectedJob, signedVideos]);

  async function uploadFirstFrame(file: File) {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch("/api/local-lab/long-video/uploads", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({})) as { ref?: string; uploadId?: string; error?: string };
    if (!response.ok || !payload.ref) { setNotice(payload.error ?? "首帧上传失败。"); return; }
    setUploadedFirstFrameRef(payload.ref);
    setVideoSource("existing");
    setNotice("首帧已上传并选择为视频输入。");
  }

  function selectedGpuForProfile() {
    if (mode === "image") return imageSizePreset === "square_1024" || imageSizePreset === "medium_image_4090" ? "rtx4090" : "rtx5090";
    return videoProfile.endsWith("4090") ? "rtx4090" : "rtx5090";
  }

  async function submitPrompt() {
    if (!supabase || !user || isSubmitting) return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setNotice("请先填写提示词。");
      return;
    }
    if (trimmedPrompt.length > 2000) {
      setNotice("提示词不能超过 2000 个字符。");
      return;
    }

    setIsSubmitting(true);
    try {
      const parsedSeed = seed.trim() ? Number(seed) : null;
      if (parsedSeed !== null && (!Number.isSafeInteger(parsedSeed) || parsedSeed <= 0)) {
        setNotice("种子必须是正整数，留空则自动生成。");
        return;
      }
      const jobForm = mode === "image" ? "image_only" : videoSource === "existing" ? "video_from_existing_image" : "video_from_generated_image";
      const sourceImageId = uploadedFirstFrameRef || existingImageJobId || selectedImage?.sessionId || "";
      if (jobForm === "video_from_existing_image" && !sourceImageId) {
        setNotice("请先选择一张已经保存的本地图片。");
        return;
      }
      const response = await fetch("/api/local-lab/generation-pool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          generationType: ordinaryMode,
          mediaType: ordinaryMode,
          jobForm,
          prompt: trimmedPrompt,
          negativePrompt,
          seed: parsedSeed,
           sizePreset: mode === "image" ? imageSizePreset : videoProfile,
           existingImageJobId: sourceImageId || null,
           gpuPreference: [selectedGpuForProfile()],
          startMode: "pending",
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; tasks?: PoolTask[]; pool?: PoolSummary };
      if (!response.ok) {
        setNotice(payload.error ?? "创建任务失败。");
        return;
      }
      setPrompt("");
      setNegativePrompt("");
      setSeed("");
      if (payload.pool) setPool((current) => mergePoolSummary(current, payload.pool!));
      setNotice("任务已保存为待确认，不扣重复积分，也不会启动显卡。");
      await refreshPool();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function runPoolAction(action: "confirm" | "cancel" | "delete" | "retry" | "regenerate", targetTaskIds?: string[]) {
    const expandedIds = new Set(targetTaskIds ?? []);
    const allPoolTasks = pool?.tasks ?? modePoolTasks;
    const requested = targetTaskIds?.length ? allPoolTasks.filter((task) => expandedIds.has(task.id)) : modePoolTasks;
    const eligible = requested.filter((task) => action === "confirm" ? poolTaskSelectable(task) : action === "retry" ? task.status === "failed" : !["deploying", "provisioning", "restoring_models", "restoring_image_model", "generating_image", "unloading_image_model", "restoring_video_model", "generating_video", "downloading_transcoding", "generating", "syncing"].includes(task.status));
    if (!eligible.length) { setNotice("当前模式没有可执行该操作的任务。"); return; }
    if (mode === "video" && action === "cancel" && supabase) {
      for (const task of eligible) await supabase.rpc("cancel_video_job", { p_job_id: task.id });
    }
    const response = await fetch("/api/local-lab/generation-pool", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, generationType: ordinaryMode, taskIds: eligible.map((task) => task.id) }) });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    setNotice(response.ok ? ({ confirm: "任务已确认，并进入对应的显卡等待队列。", cancel: "任务已取消或已请求安全停止。", delete: "任务已从本地调度池删除。", retry: "失败步骤已创建新尝试，并从最后验证边界继续。", regenerate: "已创建新的待确认输出，旧结果继续保留。" }[action]) : payload.error ?? "任务池操作失败。");
    if (response.ok && action === "confirm") setSelectedPoolTaskIds([]);
    await Promise.all([refreshPool(), refreshJobs()]);
  }

  async function cancelSelectedVideoTasks() {
    if (!supabase || !selectedJobIds.length) return;
    for (const jobId of selectedJobIds) {
      const job = jobs.find((item) => item.id === jobId);
      if (job && ["pending_confirmation", "queued"].includes(job.status)) await supabase.rpc("cancel_video_job", { p_job_id: jobId });
    }
    await fetch("/api/local-lab/generation-pool", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", taskIds: selectedJobIds }) });
    setSelectedJobIds([]);
    setNotice("已取消可取消的视频任务；积分退款继续由原有数据库规则处理。");
    await Promise.all([refreshJobs(), refreshPool()]);
  }

  function requestBatch(action: "confirm" | "delete" | "regenerate") {
    if (selectedJobIds.length === 0 || isBatching) return;
    void runBatch(action, selectedJobIds);
  }

  async function confirmSelectedVideoTasks() {
    if (isBatching) return;
    const jobIds = selectedJobIds.filter((id) => jobs.find((job) => job.id === id)?.status === "pending_confirmation");
    const projects = selectedLongVideoIds
      .map((id) => longVideoProjects.find((project) => project.id === id))
      .filter((project): project is LongVideoProject => project?.status === "pending_confirmation");
    if (!jobIds.length && !projects.length) {
      setNotice("所选视频任务已经确认或不可确认。");
      return;
    }
    setIsBatching(true);
    try {
      if (jobIds.length) {
        const response = await fetch("/api/local-lab/jobs/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "confirm", jobIds }),
        });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "短视频确认失败。");
      }
      for (const project of projects) {
        const response = await fetch(`/api/local-lab/long-video/${project.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "confirm", expectedProjectVersion: project.version }),
        });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `长视频“${project.title}”确认失败。`);
      }
      setSelectedJobIds([]);
      setSelectedLongVideoIds([]);
      setNotice("确认生成已提交：短视频和长视频共同进入视频族队列，不会寻找或租用显卡。");
    } catch (error) {
      setNotice(error instanceof Error ? `${error.message} 已保留当前选择，请刷新状态后重试。` : "视频任务确认失败，已保留当前选择。");
    } finally {
      await Promise.all([refreshJobs(), refreshPool(), refreshLongVideos()]);
      setIsBatching(false);
    }
  }

  async function runBatch(action: "confirm" | "delete" | "regenerate", targetJobIds = selectedJobIds) {
    if (targetJobIds.length === 0 || isBatching) return;

    setIsBatching(true);
    const optimisticDeleteIds = action === "delete" ? targetJobIds : [];
    if (optimisticDeleteIds.length > 0) {
      setJobs((current) => current.filter((job) => !optimisticDeleteIds.includes(job.id)));
      setSelectedJobIds([]);
    }

    try {
      const response = await fetch("/api/local-lab/jobs/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          jobIds: targetJobIds,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; regenerated?: VideoJob[] };
      if (!response.ok) {
        setNotice(payload.error ?? "批量操作失败。");
        await refreshJobs();
        return;
      }
      setSelectedJobIds([]);
      if (payload.regenerated?.[0]) setSelectedJobId(payload.regenerated[0].id);
      const labels = { confirm: "确认生成", delete: "删除", regenerate: "重新生成" };
      setNotice(`${labels[action]}已提交。确认只进入视频等待队列，不会寻找或租用显卡。`);
      await Promise.all([refreshJobs(), refreshClore()]);
    } finally {
      setIsBatching(false);
    }
  }

  async function cancelAutorent(requestId: string) {
    const response = await fetch(`/api/local-lab/clore/autorent/${requestId}`, { method: "DELETE" });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    setNotice(response.ok ? "自动寻机请求已取消。" : payload.error ?? "取消自动寻机失败。");
    await refreshClore();
  }

  async function requestExecutionStart() {
    if (!selectedExecutionGpuClass || !executionAction || executionAction.disabled || !rentalEligibility.eligible || isStartingExecution) return;
    const startingRental = executionAction.kind === "rent";
    setIsStartingExecution(true);
    setNotice("正在搜寻符合价格要求的显卡");
    try {
      const searchedCandidates = startingRental ? await searchCloreCandidates() : [];
      const searchedCandidate = startingRental && priceGate.valid && priceGate.min !== null && priceGate.max !== null
        ? searchedCandidates
          .filter((candidate) => {
            const effective = candidate.effective_usd_per_hour ?? (candidate.normalized_usd_per_hour ? candidate.normalized_usd_per_hour * 1.05 : null);
            const gpuClass = /5090/i.test(candidate.gpu) ? "rtx5090" : /4090/i.test(candidate.gpu) ? "rtx4090" : null;
            return effective !== null && effective >= priceGate.min! && effective <= priceGate.max! && isManualCandidateDisplayPriceAllowed(effective) && gpuClass === selectedExecutionGpuClass;
          })
          .sort((left, right) => (left.effective_usd_per_hour ?? Number.POSITIVE_INFINITY) - (right.effective_usd_per_hour ?? Number.POSITIVE_INFINITY))[0] ?? null
        : null;
      const response = await fetch("/api/local-lab/generation-pool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "start_execution",
          generationType: ordinaryMode,
          gpuClass: selectedExecutionGpuClass,
          modelKey: ordinaryMode === "video" ? selectedVideoModelKey ?? "video_wan_silent" : "image_flux",
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; pool?: PoolSummary; manual_authorization_required?: boolean };
      if (payload.pool) setPool(payload.pool);
      if (!response.ok) {
        setNotice(payload.error ?? "无法开始执行队列。");
        return;
      }
      if (!startingRental) {
        setNotice("执行请求已交给受控运行器；当前订单保持不变，不会创建第二个订单。");
        return;
      }
      const basePrice = searchedCandidate?.base_usd_per_hour ?? searchedCandidate?.normalized_usd_per_hour;
      if (!searchedCandidate || basePrice === null || basePrice === undefined) {
        await abortRentalSearch("候选价格无法验证，已取消本次寻卡。");
        return;
      }
      setSelectedServerId(searchedCandidate.server_id);
      const planResponse = await fetch("/api/local-lab/clore/order-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverId: searchedCandidate.server_id, maxPriceUsdPerHour: basePrice }),
      });
      const plan = await planResponse.json().catch(() => ({})) as RentalPlan & { error?: string };
      if (!planResponse.ok || !plan.nonce) {
        await abortRentalSearch(plan.error ?? "无法创建一次性手动租用计划。");
        return;
      }
      setRentalPlan(plan);
      setRentalConfirmationText("");
      setRentalRiskAccepted(false);
      setNotice("已绑定当前显卡队列。请核对服务器与价格后完成一次性确认。");
    } finally {
      setIsStartingExecution(false);
    }
  }

  async function abortRentalSearch(message = "已取消本次手动寻卡，任务仍保留在原队列。") {
    const response = await fetch("/api/local-lab/generation-pool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "abort_search" }),
    });
    const payload = await response.json().catch(() => ({})) as { pool?: PoolSummary };
    if (payload.pool) setPool(payload.pool);
    setRentalPlan(null);
    setRentalConfirmationText("");
    setRentalRiskAccepted(false);
    setNotice(message);
  }

  async function confirmRentalPlan() {
    if (!rentalPlan || isStartingExecution) return;
    setIsStartingExecution(true);
    try {
      const response = await fetch("/api/local-lab/clore/order-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce: rentalPlan.nonce,
          serverId: rentalPlan.server_id,
          maxPriceUsdPerHour: rentalPlan.max_price_usd_per_hour,
          confirmationText: rentalConfirmationText,
          riskAccepted: rentalRiskAccepted,
          queuedJobCount: rentalPlan.confirmed_task_ids.length,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { order_created?: boolean; error?: string; message?: string };
      if (response.ok && payload.order_created) {
        setRentalPlan(null);
        setNotice("租用请求已成功，正在部署当前队列所需模型。");
        await refreshPool();
        return;
      }
      await abortRentalSearch(payload.error ?? (payload.message ? `租用未执行：${payload.message}` : "租用未执行，已恢复为未寻卡状态。"));
    } finally {
      setIsStartingExecution(false);
    }
  }

  async function requestGpuAction(action: "stop_generation" | "stop_model" | "cancel_gpu", automatic = false) {
    const response = await fetch("/api/local-lab/generation-pool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; pool?: PoolSummary };
    if (payload.pool) setPool(payload.pool);
    setNotice(response.ok
      ? action === "stop_generation"
        ? "已请求安全停止生成；GPU 保持租用，队列不会删除。"
        : automatic ? "GPU 空闲倒计时已结束，正在通过安全路径退租。" : "已请求安全退租；等待任务继续保留。"
      : payload.error ?? "GPU 操作失败。");
  }

  async function confirmGpuAction() {
    if (!pendingGpuAction) return;
    const action = pendingGpuAction === "stop" ? "stop_generation" : pendingGpuAction === "stop_model" ? "stop_model" : "cancel_gpu";
    setPendingGpuAction(null);
    await requestGpuAction(action);
  }

  function toggleSelected(jobId: string) {
    setSelectedJobIds((current) => (current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]));
  }

  function selectAllPending() {
    const ids = pendingJobs.map((job) => job.id);
    setSelectedJobIds(ids.length === selectedPendingCount ? [] : ids);
  }

  return (
    <main className="min-h-screen bg-[#f5f0e8] text-stone-900" data-studio-mode={mode}>
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-[#f5f0e8]/95 px-3 py-2 backdrop-blur">
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="hidden text-xs font-semibold uppercase tracking-wide text-emerald-700 sm:block">local_lab</p>
            <div className="flex flex-wrap gap-1 rounded-md border border-stone-200 bg-white p-1 text-sm font-semibold">
              {/* aria-pressed={mode === item} keeps the mode contract discoverable for older browser checks. */}
              {(["image", "video"] as const).map((item) => <button aria-pressed={(item === "image" ? mode === "image" : mode === "video")} className={`rounded px-3 py-1.5 ${((item === "image" && mode === "image") || (item === "video" && mode !== "image")) ? "bg-stone-900 text-white" : "text-stone-600"}`} data-mode={item} key={item} onClick={() => selectMode(item)} type="button">{item === "image" ? "图片" : "视频"}</button>)}
            </div>
            {mode !== "image" ? <div className="flex gap-1 rounded-md border border-stone-200 bg-white p-1 text-xs font-semibold"><button aria-pressed={videoSubmode === "video"} className={`rounded px-2 py-1.5 ${videoSubmode === "video" ? "bg-stone-900 text-white" : "text-stone-600"}`} data-mode="video" onClick={() => selectVideoSubmode("video")} type="button">短视频</button><button aria-pressed={videoSubmode === "long_video"} className={`rounded px-2 py-1.5 ${videoSubmode === "long_video" ? "bg-stone-900 text-white" : "text-stone-600"}`} data-mode="long_video" onClick={() => selectVideoSubmode("long_video")} type="button">长视频</button></div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link className="rounded-md border border-stone-200 bg-white px-2 py-1.5 font-semibold text-stone-700" href="/generate/4090">
              4090
            </Link>
            <Link className="rounded-md border border-stone-200 bg-white px-2 py-1.5 font-semibold text-stone-700" href="/generate/5090">
              5090
            </Link>
            <button aria-label="资费情况" className="rounded-md border border-stone-300 bg-white px-2 py-1.5 font-semibold" data-testid="billing-toggle" onClick={() => setShowBilling((current) => !current)} type="button">资费情况</button>
            <span className="rounded-md border border-stone-200 bg-white px-2 py-1.5" data-mode={mode} data-testid="studio-status">{mode === "image" ? `图片 ${imageResults.length}` : mode === "long_video" ? "长视频项目" : `未生成 ${counts.pending_confirmation ?? 0}`}</span>
            <span className="rounded-md border border-stone-200 bg-white px-2 py-1.5">GPU {!pool ? "状态加载中" : execution.activity === "searching" ? "搜寻中" : execution.rentedGpuClass ? "已租用" : "未租用"}</span>
            <span className="rounded-md border border-stone-200 bg-white px-2 py-1.5">{mode === "image" ? "UltraReal" : "Wan 2.2"}</span>
            <span className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs font-semibold text-sky-800">4090 {execution.rentedGpuClass === "rtx4090" ? "运行" : "等待"}</span>
            <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs font-semibold text-emerald-800">5090 {execution.rentedGpuClass === "rtx5090" ? "运行" : "等待"}</span>
          </div>
        </div>
      </header>

      <div className="studio-shell grid w-full gap-3 px-2 py-3">
        <section className="min-w-0 space-y-3">
          {showBilling ? <BillingPanel onClose={() => setShowBilling(false)} /> : <>
          <div className="studio-unified-preview overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
            <div className="flex h-[42vh] min-h-64 max-h-[480px] items-center justify-center bg-[#1f1f1f]">
              {mode === "image" && selectedImage ? (
                <img alt="生成图片预览" className="h-full w-full bg-black object-contain" src={selectedImage.imageUrl} />
              ) : mode !== "image" && activeVideoUrl ? (
                <video className="h-full w-full bg-black object-contain" controls playsInline src={activeVideoUrl} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center text-stone-100">
                  <p className="text-sm font-semibold text-stone-400">{mode === "image" ? (pendingImage?.status === "pending" ? "等待真实GPU" : "未选择图片") : selectedVideoKind === "long" && selectedLongVideo ? "长视频尚未完成" : selectedJob ? videoJobStatusLabels[selectedJob.status] : "未选择任务"}</p>
                  <h2 className="mt-2 text-xl font-bold">{mode === "image" ? "暂无可预览图片" : selectedVideoKind === "long" ? "暂无可播放长视频分段" : selectedJob ? generationLabel(selectedJob) : "暂无可播放视频"}</h2>
                  <p className="mt-2 max-w-xl text-sm text-stone-400">
                    {mode === "image"
                      ? "首张FLUX图片任务保留在任务池，受控Clore会话就绪后执行。"
                      : selectedJob
                      ? selectedJob.status === "queued" && activeAutorent
                        ? "正在寻找符合价格条件的GPU"
                        : etaText(selectedJob, jobs)
                      : "在下方输入提示词，先创建未生成任务。"}
                  </p>
                  {selectedJob?.status === "processing" ? (
                    <div className="mt-5 h-2 w-72 overflow-hidden rounded-full bg-stone-700">
                      <div className="h-full bg-emerald-400" style={{ width: `${selectedJob.progress}%` }} />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            {mode !== "image" && selectedVideoKind === "long" && selectedLongVideo ? <div className="flex gap-2 overflow-x-auto border-t border-stone-800 bg-stone-950 px-2 py-2" data-testid="long-video-segment-strip">
              {selectedLongVideo.segments.map((segment) => {
                const playable = Boolean(segment.selectedAttemptId && ["accepted", "awaiting_review"].includes(segment.status));
                return <button className={`w-24 shrink-0 overflow-hidden rounded border text-left ${segment.sequenceIndex === selectedLongSegment?.sequenceIndex ? "border-emerald-400" : "border-stone-700"}`} disabled={!playable} key={segment.id} onClick={() => setSelectedLongSegmentIndex(segment.sequenceIndex)} type="button">
                  <div className="aspect-video bg-stone-800">{playable ? <img alt={`分段 ${segment.sequenceIndex + 1}`} className="h-full w-full object-cover" src={longVideoPublicMediaUrl(selectedLongVideo.id, "segment-thumbnail", segment)} /> : null}</div>
                  <span className="block px-1 py-1 text-[10px] text-stone-200">第 {segment.sequenceIndex + 1} 段 · {segment.status === "accepted" ? "已完成" : "待处理"}</span>
                </button>;
              })}
            </div> : null}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 bg-[#faf8f4] px-3 py-2 text-sm">
              <div>
                <p className="font-semibold">{mode === "image" ? (selectedImage?.sessionId ?? pendingImage?.sessionId ?? "首张FLUX图片") : selectedVideoKind === "long" && selectedLongVideo ? selectedLongVideo.title : showingPoolVideo && poolVideoTask ? safePromptPreview(poolVideoTask.prompt) : selectedJob ? safePromptPreview(selectedJob.prompt) : "选择任务后会在这里显示"}</p>
                <p className="text-stone-500">{mode === "image" ? (selectedImage ? "图片已完成并保存到本地" : "图片任务等待受控Clore调度") : selectedVideoKind === "long" && selectedLongVideo ? `${selectedLongVideo.segments.filter((segment) => segment.status === "accepted").length}/${selectedLongVideo.totalSegments} 段已完成` : showingPoolVideo ? "任务池视频已完成并保存到本地" : selectedJob ? `${videoJobStatusLabels[selectedJob.status]} · ${etaText(selectedJob, jobs)}` : "未生成任务确认后才会进入对应显卡队列"}</p>
              </div>
              <div className="flex items-center gap-2">
                {selectedVideoKind === "long" && selectedLongVideo?.finalVideoRef ? (
                  <a className="rounded-md border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-800" data-testid="long-video-master-link" href={longVideoPublicMediaUrl(selectedLongVideo.id, "master")}>720P 母版</a>
                ) : null}
                <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:text-stone-400" disabled={!previewFolderRequest || isOpeningFolder} onClick={() => void openPreviewFolder()} type="button">{isOpeningFolder ? "正在打开文件夹" : previewFolderRequest?.label ?? "打开本地文件夹"}</button>
                <span className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">短期签名播放 · 本地结果优先</span>
              </div>
            </div>
          </div>

          {mode === "long_video" ? <LongVideoStudio editorOnly imageResults={imageResults} /> : <>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">新提示词</h2>
                <p className="text-sm text-stone-500">{mode === "image" ? "图片模式显示首图任务和本地图片结果。" : "提交后立即扣积分，但先停留为未生成任务。"}</p>
              </div>
              <span className="rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">Clore安全调度</span>
            </div>
            <div className="relative mt-3">
              <textarea
                className="min-h-32 w-full resize-y rounded-md border border-stone-200 bg-[#faf8f4] p-4 pb-16 leading-7 outline-none focus:border-emerald-500"
                maxLength={2000}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitPrompt();
                }
              }}
                value={prompt}
              />
              <div className="absolute bottom-3 right-3 flex rounded-md border border-stone-300 bg-white p-1 text-sm font-semibold">
                <button className={`rounded px-3 py-1.5 ${mode === "image" ? "bg-stone-900 text-white" : "text-stone-600"}`} onClick={() => selectMode("image")} type="button">图片</button>
                <button className={`rounded px-3 py-1.5 ${mode === "video" ? "bg-stone-900 text-white" : "text-stone-600"}`} onClick={() => selectMode("video")} type="button">视频</button>
              </div>
            </div>
            <details className="mt-3 rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2">
              <summary className="cursor-pointer text-sm font-semibold text-stone-700">可选负面提示词</summary>
              <textarea className="mt-2 min-h-20 w-full resize-y rounded-md border border-stone-200 bg-white p-3 text-sm outline-none focus:border-emerald-500" maxLength={1000} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="不希望出现的内容，留空使用生产默认值" value={negativePrompt} />
            </details>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {mode === "image" ? (
                <label className="text-sm font-semibold text-stone-700">尺寸
                  <select className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2" onChange={(event) => setImageSizePreset(event.target.value as typeof imageSizePreset)} value={imageSizePreset}>
                    <option value="square_1024">低 · 1024×1024 · RTX 4090</option>
                    <option value="medium_image_4090">中 · 1536×1024 · RTX 4090</option>
                    <option value="medium_image_5090">中 · 1536×1024 · RTX 5090</option>
                    <option value="high_image_5090">高 · 2048×2048 · RTX 5090（最终尺寸）</option>
                  </select>
                </label>
              ) : (
                <>
                  <label className="text-sm font-semibold text-stone-700">来源
                    <select className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2" onChange={(event) => setVideoSource(event.target.value as "generated" | "existing")} value={videoSource}>
                      <option value="generated">先生成图片</option>
                      <option value="existing">选择已有图片</option>
                    </select>
                  </label>
                  <label className="text-sm font-semibold text-stone-700">视频配置
                    <select className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2" onChange={(event) => setVideoProfile(event.target.value as typeof videoProfile)} value={videoProfile}>
                      <option value="audible_low_video_4090">有声·低 · 720P · RTX 4090</option>
                      <option value="audible_medium_video_5090">有声·中 · 720P · RTX 5090</option>
                      <option value="audible_high_video_5090">有声·高 · 1080P · RTX 5090</option>
                      <option value="low_video_4090">低 · 480P（832×480）· RTX 4090</option>
                      <option value="medium_video_4090">中 · 720P · RTX 4090</option>
                      <option value="medium_video_5090">中 · 720P · RTX 5090</option>
                      <option value="high_video_5090">高 · 1080P最终输出 · RTX 5090（720P生成后精修）</option>
                    </select>
                  </label>
                </>
              )}
              {mode === "video" && videoSource === "existing" ? <div className="sm:col-span-2"><FirstFrameInput existingImages={imageResults} selectedExistingId={existingImageJobId || selectedImage?.sessionId || ""} onSelectExisting={(id) => { setExistingImageJobId(id); setUploadedFirstFrameRef(""); }} onFile={uploadFirstFrame} onRemove={() => { setUploadedFirstFrameRef(""); }} /></div> : null}
              <label className="text-sm font-semibold text-stone-700">种子
                <input className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2" inputMode="numeric" onChange={(event) => setSeed(event.target.value)} placeholder="留空自动生成" value={seed} />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2 text-sm font-semibold">配置将使用 {selectedGpuForProfile().toUpperCase()} · 由分辨率档位决定</span>
              <span className="text-sm text-stone-500">{prompt.trim().length}/2000</span>
              <div className="flex flex-wrap gap-2">
                <button className="rounded-md bg-stone-900 px-4 py-3 text-sm font-bold text-white disabled:bg-stone-400" disabled={isSubmitting || !user} onClick={() => void submitPrompt()} type="button">
                  {isSubmitting ? "创建中..." : "创建待确认任务"}
                </button>
              </div>
            </div>
            {notice ? <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p> : null}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">生成队列</h2>
                <p className="text-sm text-stone-500">创建只保存待确认任务；确认后按生成族和 GPU 档位进入等待队列，租用仍需单独手动操作。</p>
              </div>
              <span className="rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{pool?.deploymentHold ? "Clore 部署已暂停" : "Clore 可由操作员恢复"}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {(["pending_confirmation", "waiting_for_batch", "waiting_for_gpu", "provisioning", "restoring_image_model", "generating_image", "restoring_video_model", "generating_video", "downloading_transcoding", "completed", "failed"] as PoolTaskStatus[]).map((status) => (
                <div className="rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2" key={status}><span className="text-stone-500">{poolStatusLabels[status]}</span><strong className="ml-2">{modePoolTasks.filter((task) => task.status === status || (status === "waiting_for_gpu" && task.status === "armed")).length}</strong></div>
              ))}
            </div>
            <div className="mt-3 grid gap-1 text-sm text-stone-600 sm:grid-cols-2">
              <p>当前模式：{ordinaryMode === "image" ? "图片队列" : "视频队列（短视频与长视频合并）"}</p>
              <p>租用方式：仅手动启动</p>
              <p>预计会话：{pool?.costEstimate?.totalSession.minMinutes ?? 0}–{pool?.costEstimate?.totalSession.maxMinutes ?? 0} 分钟</p>
              <p>预计计算费：${(pool?.costEstimate?.projectedComputeUsd.min ?? 0).toFixed(2)}–${(pool?.costEstimate?.projectedComputeUsd.max ?? 0).toFixed(2)}</p>
              <p>调度状态：{schedulerStateLabels[pool?.schedulerState ?? "idle"] ?? "未知状态"}</p>
            </div>
            <p className="mt-2 rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700">{pool?.orderBlockingReason ?? "正在读取调度门禁。"}</p>
            {selectedPoolTaskIds.length > 0 ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3"><span className="text-sm font-semibold">已选 {selectedPoolTaskIds.length} 个{ordinaryMode === "image" ? "图片" : "视频"}任务 · 可同时包含蓝色与绿色卡片</span><button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => void runPoolAction("confirm", selectedPoolTaskIds)} type="button">确认生成</button></div> : null}
            {pool?.productionModels?.[ordinaryMode] ? (
              <div className="mt-2 rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2 text-sm text-stone-700">
                <p className="font-semibold">{mode === "image" ? "UltraReal Flux FP8" : "Wan 2.2 Remix 14B FP8"}：缓存{pool.productionModels[ordinaryMode].cacheReady ? "已就绪" : "发布未完成"} · 推理{pool.productionModels[ordinaryMode].inferenceVerified ? "已验证" : "未验证"}</p>
                <p className="mt-1 text-xs text-stone-500">
                  配置 {selectedGpuForProfile().toUpperCase()} · 独占 {(pool.productionModels[ordinaryMode].uniqueRestoreBytes / 1024 ** 3).toFixed(1)} GiB · 共享 {(pool.productionModels[ordinaryMode].sharedBytes / 1024 ** 3).toFixed(1)} GiB · 总恢复量 {(pool.productionModels[ordinaryMode].restoreBytes / 1024 ** 3).toFixed(1)} GiB
                </p>
                <p className="mt-1 text-xs text-stone-500">模型恢复发生在 GPU 与 R2 之间，不计入本机下载流量。{pool.costEstimate?.creationFeeCaveat}</p>
              </div>
            ) : null}
            {mode === "video" && poolVideoResult?.thumbnailUrl && poolVideoResult.videoUrl ? (
              <div className="mt-3 flex items-center gap-3 rounded-md border border-stone-200 bg-[#faf8f4] p-2">
                <img alt="任务池视频缩略图" className="h-16 w-28 rounded object-cover" src={poolVideoResult.thumbnailUrl} />
                <div><p className="text-sm font-semibold">任务池视频已同步</p><p className="text-xs text-stone-500">刷新页面或重启应用后仍可播放本地 MP4。</p></div>
              </div>
            ) : null}
          </section>
          </>}

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{mode === "image" ? "图片任务" : "视频任务"}</h2>
                <p className="text-sm text-stone-500">{mode === "image" ? "仅显示图片族任务和已保存图片。" : "短视频与长视频共享本任务区；上方开关只改变创建表单。"}</p>
              </div>
              {mode === "video" ? <div className="flex flex-wrap gap-2 text-sm">
                {(["all", "pending_confirmation", "queued", "processing", "succeeded", "failed"] as const).map((status) => (
                  <button
                    className={`rounded-md border px-3 py-1.5 ${filter === status ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white"}`}
                    key={status}
                    onClick={() => setFilter(status)}
                    type="button"
                  >
                    {status === "all" ? "全部" : videoJobStatusLabels[status]}
                  </button>
                ))}
              </div> : null}
            </div>

            {mode !== "image" && selectedJobIds.length + selectedLongVideoIds.length > 0 ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-stone-200 bg-[#faf8f4] p-3">
                <span className="text-sm font-semibold">已选 {selectedJobIds.length + selectedLongVideoIds.length} 个视频任务</span>
                <button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => void confirmSelectedVideoTasks()} type="button">
                  确认生成
                </button>
                {selectedLongVideoIds.length === 0 ? <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:bg-stone-100" disabled={isBatching} onClick={() => requestBatch("regenerate")} type="button">
                  重新生成
                </button> : null}
                {selectedLongVideoIds.length === 0 ? <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:bg-stone-100" disabled={isBatching} onClick={() => void cancelSelectedVideoTasks()} type="button">
                  取消
                </button> : null}
                {selectedLongVideoIds.length === 0 ? <button className="rounded-md bg-rose-700 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => requestBatch("delete")} type="button">
                  删除
                </button> : null}
                <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => { setSelectedJobIds([]); setSelectedLongVideoIds([]); }} type="button">清除选择</button>
              </div>
            ) : null}

            {mode === "video" ? <div className="mt-4 flex items-center gap-2">
              <input checked={pendingJobs.length > 0 && pendingJobs.length === selectedPendingCount} className="h-4 w-4" onChange={selectAllPending} type="checkbox" />
              <button className="text-sm font-semibold text-stone-700" onClick={selectAllPending} type="button">
                全选未生成任务
              </button>
            </div> : null}

            {pool?.invalidTaskRecords?.length ? <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="invalid-task-records">发现 {pool.invalidTaskRecords.length} 条历史任务分类异常记录；它们已从画廊隔离，未被重新分类或删除。</p> : null}
            <div className="studio-task-grid mt-3 grid grid-cols-1 gap-1.5 min-[480px]:grid-cols-2 min-[800px]:grid-cols-4 min-[1100px]:grid-cols-6 min-[1366px]:grid-cols-8" data-testid="shared-task-gallery">
              {modePoolTasks.map((task) => {
                const queuePosition = queuedPoolTasks.findIndex((candidate) => candidate.id === task.id);
                const estimate = task.generationType === "image" ? pool?.costEstimate?.imageInference : pool?.costEstimate?.videoInference;
                const awaitingLocalAudio = task.audioOrigin === "local_voice_conditioning" && task.audioBinding?.status !== "local_audio_ready";
                return (
                  <article className={`min-w-0 rounded-md border p-1.5 text-[11px] ${task.status === "failed" ? "border-rose-200 bg-rose-50" : task.requiredGpuClass === "rtx5090" ? "border-emerald-200 bg-emerald-50" : "border-sky-200 bg-sky-50"}`} data-gpu-class={task.requiredGpuClass} key={`pool-${task.id}`}>
                    <div className="aspect-video overflow-hidden rounded bg-stone-200">
                      <div className="flex h-full items-center justify-center text-stone-500">{task.generationType === "image" ? "图片预览" : "视频预览"}</div>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <label className="flex min-w-0 items-center gap-1 font-semibold"><input aria-label={`选择任务 ${task.id}`} checked={selectedPoolTaskIds.includes(task.id)} disabled={!poolTaskSelectable(task)} onChange={() => setSelectedPoolTaskIds((current) => current.includes(task.id) ? current.filter((id) => id !== task.id) : [...current, task.id])} type="checkbox" /><span className="truncate">{task.generationType === "image" ? "图片" : "短视频"}</span></label>
                      <span className="rounded border border-stone-200 bg-white/80 px-1 py-0.5 font-bold">{qualityBadge(task.width, task.height)}</span>
                    </div>
                    <p className="mt-1 font-semibold">{awaitingLocalAudio ? `有声任务：${poolStatusLabels[task.status]}` : poolStatusLabels[task.status]}</p>
                    <p className="mt-1 line-clamp-2 min-h-8 leading-4">{task.prompt}</p>
                    <p className="mt-1 truncate text-stone-500">{task.width}×{task.height} · {queuePosition >= 0 ? `队列 ${queuePosition + 1}` : `${estimate?.minMinutes ?? 1}–${estimate?.maxMinutes ?? 1} 分钟`}</p>
                    <div className="mt-1.5 grid grid-cols-3 gap-1">
                      <button className="rounded border border-stone-200 px-1 py-1 text-stone-700 disabled:text-stone-400" disabled={!['completed', 'failed', 'cancelled'].includes(task.status)} onClick={() => void runPoolAction("regenerate", [task.id])} type="button">{awaitingLocalAudio ? "等待本地声音" : "重新生成视频"}</button>
                      <details className="text-stone-600"><summary className="cursor-pointer">{task.audioBinding ? "声音状态" : "查看详情"}</summary><p className="mt-1 break-all">{task.audioBinding ? poolStatusLabels[task.audioBinding.status] : "无声任务"}</p><p className="mt-1 break-all">任务 {task.id}</p></details>
                      {!["provisioning", "restoring_image_model", "generating_image", "unloading_image_model", "restoring_video_model", "generating_video", "downloading_transcoding"].includes(task.status) ? <button className="font-semibold text-rose-700" onClick={() => void runPoolAction("delete", [task.id])} type="button">删除</button> : null}
                    </div>
                  </article>
                );
              })}
              {mode === "image" ? (
                <>
                  {pendingImage?.status === "pending" ? (
                    <article className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <div className="flex items-center justify-between gap-2"><p className="font-semibold">首张FLUX真实图片</p><span className="rounded-md border border-amber-200 bg-white px-2 py-1 text-xs">等待调度</span></div>
                      <p className="mt-3 text-sm text-stone-600">已完成 {pendingImage.completedStages.length} 个执行阶段；任务继续保留在任务池。</p>
                    </article>
                  ) : null}
                  {imageResults.map((image) => (
                    <article className={`min-w-0 rounded-md border border-emerald-200 bg-emerald-50 p-1.5 text-[11px] ${selectedImage?.sessionId === image.sessionId ? "ring-1 ring-stone-900" : ""}`} key={image.sessionId}>
                      <button className="aspect-video w-full overflow-hidden rounded bg-stone-100" onClick={() => setSelectedImageId(image.sessionId)} type="button">
                        <img alt="已完成图片" className="h-full w-full object-contain" src={image.imageUrl} />
                      </button>
                      <div className="mt-1.5 flex items-center justify-between"><strong>图片</strong><span className="rounded border border-emerald-200 bg-white px-1 py-0.5 font-bold">{imageResultQuality(image.metadata)}</span></div>
                      <p className="mt-1 font-semibold">已完成</p>
                      <p className="mt-1 line-clamp-2 min-h-8 break-all leading-4">{String(image.metadata?.prompt ?? image.sessionId)}</p>
                      <div className="mt-1.5 flex flex-wrap gap-x-2"><button className="font-semibold" onClick={() => setSelectedImageId(image.sessionId)} type="button">查看详情</button><button className="font-semibold text-rose-700" onClick={() => setNotice("验收图片已锁定；本阶段不会删除已接受媒体。")} type="button">删除</button><button className="font-semibold" onClick={() => setNotice("验收图片已复用；本阶段不会重新生成。")} type="button">重新生成</button></div>
                    </article>
                  ))}
                </>
              ) : <>{visibleJobs.map((job) => {
                const localResult = localResults.find((result) => result.jobId === job.id);
                const selectable = job.status === "pending_confirmation" || job.status === "queued" || job.status === "failed" || job.status === "canceled" || job.status === "succeeded";
                return (
                  <article className={`relative min-w-0 rounded-md border p-1.5 text-[11px] ${job.status === "failed" ? "border-rose-200 bg-rose-50" : "border-sky-200 bg-sky-50"} ${selectedVideoKind === "short" && selectedJobId === job.id ? "ring-1 ring-stone-900" : ""}`} key={job.id}>
                    <button className="aspect-video w-full overflow-hidden rounded bg-stone-100 text-left" onClick={() => { setSelectedJobId(job.id); setSelectedVideoKind("short"); }} type="button">
                      {localResult?.thumbnailUrl ? (
                        <img alt="任务封面" className="h-full w-full object-cover" src={localResult.thumbnailUrl} />
                      ) : (
                        <div className="flex h-full items-center justify-center px-1 text-center text-stone-500">{etaText(job, jobs)}</div>
                      )}
                    </button>
                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <label className="flex min-w-0 items-center gap-1 font-semibold">
                        <input checked={selectedJobIds.includes(job.id)} className="h-4 w-4" disabled={!selectable} onChange={() => toggleSelected(job.id)} type="checkbox" />
                        <span className="truncate">短视频</span>
                      </label>
                      <span className="rounded border border-sky-200 bg-white px-1 py-0.5 font-bold">低</span>
                    </div>
                    <p className={`mt-1 font-semibold ${statusBadgeClass(job.status)}`}>{videoJobStatusLabels[job.status]}</p>
                    <p className="mt-1 line-clamp-2 min-h-8 leading-4">{job.prompt}</p>
                    <div className="mt-1.5 flex flex-wrap gap-x-2"><button className="font-semibold" onClick={() => { setSelectedJobId(job.id); setSelectedVideoKind("short"); }} type="button">查看详情</button><button className="font-semibold text-rose-700" onClick={() => void runBatch("delete", [job.id])} type="button">删除</button><button className="font-semibold" onClick={() => void runBatch("regenerate", [job.id])} type="button">重新生成</button></div>
                  </article>
                );
              })}
              {longVideoProjects.map((project) => {
                const segment = [...project.segments].reverse().find((candidate) => candidate.selectedAttemptId && ["accepted", "awaiting_review"].includes(candidate.status)) ?? null;
                const quality = project.finalVideoRef ? "高" : project.gpuPreference[0] === "rtx5090" ? "中" : "低";
                return <article className={`min-w-0 rounded-md border p-1.5 text-[11px] ${longVideoCardClass(project)} ${selectedVideoKind === "long" && selectedLongVideo?.id === project.id ? "ring-1 ring-stone-900" : ""}`} key={`long-${project.id}`}>
                  <button className="aspect-video w-full overflow-hidden rounded bg-stone-200" onClick={() => { setSelectedLongVideoId(project.id); setSelectedVideoKind("long"); setSelectedLongSegmentIndex(segment?.sequenceIndex ?? 0); }} type="button">
                    {project.finalThumbnailRef ? <img alt="长视频缩略图" className="h-full w-full object-cover" src={longVideoPublicMediaUrl(project.id, "thumbnail")} /> : segment ? <img alt="长视频分段缩略图" className="h-full w-full object-cover" src={longVideoPublicMediaUrl(project.id, "segment-thumbnail", segment)} /> : <span className="flex h-full items-center justify-center text-stone-500">待生成</span>}
                  </button>
                  <div className="mt-1.5 flex items-center justify-between gap-1"><label className="flex min-w-0 items-center gap-1 font-semibold"><input aria-label={`选择长视频 ${project.id}`} checked={selectedLongVideoIds.includes(project.id)} disabled={project.status !== "pending_confirmation"} onChange={() => setSelectedLongVideoIds((current) => current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id])} type="checkbox" /><span className="truncate">长视频</span></label><span className="rounded border border-stone-200 bg-white/80 px-1 py-0.5 font-bold">{quality}</span></div>
                  <p className="mt-1 font-semibold">{project.status === "failed" ? "失败" : project.status === "completed" ? "已完成" : project.status === "generating" ? "生成中" : "排队"}</p>
                  <p className="mt-1 line-clamp-2 min-h-8 leading-4">{project.overallPrompt || project.segments[0]?.prompt || project.title}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-2"><button className="font-semibold" onClick={() => { setSelectedLongVideoId(project.id); setSelectedVideoKind("long"); }} type="button">查看详情</button><button className="font-semibold text-rose-700" onClick={() => setNotice("请在长视频项目详情中确认后删除。")} type="button">删除</button><button className="font-semibold" onClick={() => setNotice(project.segments[0]?.status === "accepted" ? "已接受的第 0 段保持不可变；只允许从下一未完成段续作。" : "请在长视频详情中选择可重新生成的分段。")} type="button">重新生成</button></div>
                </article>;
              })}</>}
            </div>
          </section>
        </>}
        </section>

        <aside className="studio-sidebar space-y-3" data-testid="permanent-gpu-sidebar">
          <section className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between gap-2"><h2 className="font-bold">GPU 与任务</h2><span className={`rounded px-2 py-1 text-xs font-semibold ${execution.rentedGpuClass ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-700"}`}>{!pool ? "正在恢复GPU会话" : execution.activity === "searching" ? "正在搜寻显卡" : execution.activity === "canceling" ? "正在退租" : execution.rentedGpuClass ? "显卡已租用" : "当前未租用显卡"}</span></div>
            <div className="mt-2 rounded border border-stone-200 bg-[#faf8f4] p-2 text-xs text-stone-700" data-testid="deployed-family-status">
              {!pool ? <p className="font-semibold">正在加载GPU与模型状态</p> : <>
                <p>{execution.rentedGpuClass ? `当前GPU：${execution.rentedGpuClass === "rtx5090" ? "RTX 5090" : "RTX 4090"}` : "当前GPU：暂无"}</p>
                <p className="mt-1">已部署模型：{deployedFamilyLabel}</p>
                <p className="mt-1 font-semibold">{currentModeDeployed ? "当前已部署" : "当前未部署"}</p>
                {!currentModeDeployed && (execution.deployedFamily === "image" || execution.deployedFamily === "video") ? <p className="mt-1 text-amber-800">GPU当前运行{execution.deployedFamily === "image" ? "图片模型" : "视频模型"}</p> : null}
              </>}
            </div>
            <div className={`mt-2 grid gap-2 text-xs ${ordinaryMode === "video" ? "grid-cols-1" : "grid-cols-2"}`}>
              {executionQueueOptions.map((queue) => {
                const { gpuClass, modelKey } = queue;
                const selected = selectedExecutionGpuClass === gpuClass && (ordinaryMode === "image" || selectedVideoModelKey === modelKey);
                const otherSelected = selectedExecutionGpuClass !== null && !selected;
                const baseColor = gpuClass === "rtx4090" ? "border-sky-200 bg-sky-50 text-sky-950" : "border-emerald-200 bg-emerald-50 text-emerald-950";
                const selectedColor = gpuClass === "rtx4090" ? "border-sky-500 bg-sky-200 text-sky-950" : "border-emerald-500 bg-emerald-200 text-emerald-950";
                return <button
                  aria-pressed={selected}
                  className={`rounded border p-2 text-left transition ${selected ? selectedColor : otherSelected ? "border-stone-200 bg-stone-100 text-stone-400" : baseColor} disabled:cursor-not-allowed disabled:opacity-50`}
                  data-testid={modelKey === null || modelKey === "video_wan_silent" ? `execution-queue-${gpuClass}` : `execution-queue-${modelKey}-${gpuClass}`}
                  disabled={queueSelectionLocked || queue.count === 0}
                  key={`${modelKey ?? "image"}-${gpuClass}`}
                  onClick={() => selectExecutionQueue(selected ? null : gpuClass, selected ? null : modelKey)}
                  type="button"
                >
                  <strong>{queue.label}</strong>
                  <p>{queue.count} 个已确认 · 可执行 {selected && rentalEligibility.eligible ? rentalEligibility.executableCount : queue.count}</p>
                </button>;
              })}
            </div>
            <div className="mt-2 rounded border border-stone-200 bg-[#faf8f4] p-2 text-xs">
              {selectedExecutionGpuClass ? <><strong>已选择 {selectedExecutionGpuClass === "rtx4090" ? "RTX 4090" : "RTX 5090"} 执行队列</strong><p className="mt-1">队列任务 {rentalEligibility.totalCount} · 已确认 {rentalEligibility.confirmedCount} · 可执行 {rentalEligibility.executableCount}{ordinaryMode === "video" ? ` · 等待本地声音 ${rentalEligibility.audioWaitingCount}` : ""}；另一颜色保持排队。</p></> : <><strong>尚未选择执行队列</strong><p className="mt-1 text-stone-500">先选择蓝色或绿色队列，才会显示租用或继续按钮。</p></>}
            </div>
            {isStartingExecution || execution.activity === "searching" ? <div aria-live="polite" className="mt-2 flex items-center justify-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900" data-testid="gpu-searching-state"><span className="h-4 w-4 animate-spin rounded-full border-2 border-amber-800 border-t-transparent" />正在搜寻符合价格要求的显卡</div> : selectedExecutionGpuClass ? <button className="mt-2 w-full rounded-md bg-rose-700 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-300" data-testid="execution-start-action" disabled={executionAction?.disabled ?? true} onClick={() => void requestExecutionStart()} title={executionAction?.reason ?? undefined} type="button">{executionAction?.label ?? "开始任务并租用显卡"}</button> : null}
            {execution.activity === "searching" && !rentalPlan ? <button className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-xs font-semibold" onClick={() => void abortRentalSearch()} type="button">取消本次寻卡</button> : null}
            {selectedExecutionGpuClass && executionAction?.reason ? <p className="mt-2 rounded bg-amber-50 px-2 py-2 text-xs text-amber-900">{executionAction.reason}</p> : null}
            <p className="mt-2 text-xs text-stone-600">寻机状态：{activeAutorent ? autorentStatusLabels[activeAutorent.status] : "未启动"} · 队列：{simplifiedSessionStatus}</p>
            {execution.rentedGpuClass ? <div className="mt-3 grid grid-cols-3 gap-2" data-testid="rented-gpu-controls">
              <button className="rounded-md border border-amber-300 bg-white px-2 py-2 text-xs font-bold text-amber-900 disabled:opacity-50" disabled={execution.deployedModel === "none" || execution.activity === "canceling"} onClick={() => setPendingGpuAction("stop_model")} type="button">终止当前模型但不退租</button>
              <button className="rounded-md border border-amber-300 bg-amber-50 px-2 py-2 text-xs font-bold text-amber-900 disabled:opacity-50" disabled={!activeGenerationFamily || execution.activity !== "running"} onClick={() => setPendingGpuAction("stop")} type="button">终止{activeGenerationFamily === "video" ? "视频" : "图片"}生成，但不退租GPU</button>
              <button className="rounded-md bg-rose-700 px-2 py-2 text-xs font-bold text-white disabled:bg-stone-300" disabled={execution.activity === "canceling"} onClick={() => setPendingGpuAction("cancel")} type="button">退租显卡</button>
            </div> : null}
            {execution.rentedGpuClass && execution.activity === "idle" && execution.idleCancelAt ? <p className="mt-2 rounded bg-amber-50 px-2 py-2 text-xs font-semibold text-amber-900" data-testid="gpu-idle-countdown">GPU空闲，将在 {idleCancelSeconds} 秒后自动退租</p> : null}
            {execution.activity === "deploying" ? <p className="mt-2 rounded bg-sky-50 px-2 py-2 text-xs font-semibold text-sky-900">{execution.switchPhase === "unloading" ? `正在卸载${execution.deployedFamily === "video" ? "视频" : "图片"}模型` : `正在部署${execution.activeExecution?.generationFamily === "video" ? "视频" : "图片"}模型`}</p> : null}
          </section>
          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">GPU 价格筛选</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-sm">
                最低美元/小时
                <input className="mt-1 w-full rounded-md border border-stone-200 bg-[#faf8f4] px-2 py-2" onChange={(event) => setMinPrice(event.target.value)} value={minPrice} />
              </label>
              <label className="text-sm">
                最高美元/小时
                <input className="mt-1 w-full rounded-md border border-stone-200 bg-[#faf8f4] px-2 py-2" max={LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR} min="0" onChange={(event) => setMaxPrice(event.target.value)} step="0.01" type="number" value={maxPrice} />
              </label>
            </div>
            <p className={`mt-2 text-xs ${priceGate.valid ? "text-emerald-700" : "text-rose-700"}`}>
              {priceGate.valid ? "价格范围有效，按含5%租客费小时价过滤，仅用于手动查看；最终租用仍受当前任务授权和预算限制。" : `非法输入不会保存或触发寻机，最高价不得超过 $${LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR}/小时。`}
            </p>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">Clore 合规GPU候选</h2>
              <button className="rounded-md border border-stone-200 bg-[#faf8f4] px-2 py-1 text-xs font-semibold" onClick={() => void refreshClore()} type="button">
                刷新
              </button>
            </div>
            <p className="mt-2 text-xs text-stone-500">来源：{candidateSource || "未加载"} · 默认只显示含费用小时价</p>
            <div className="mt-3 space-y-2">
              {filteredCandidates.slice(0, 8).map((candidate) => {
                const effective = candidate.effective_usd_per_hour ?? (candidate.normalized_usd_per_hour ? candidate.normalized_usd_per_hour * 1.05 : null);
                return (
                  <button
                    className={`w-full rounded-md border px-3 py-3 text-left ${selectedServerId === candidate.server_id ? "border-emerald-500 bg-emerald-50" : "border-stone-200 bg-[#faf8f4]"}`}
                    key={candidate.server_id}
                    onClick={() => setSelectedServerId(candidate.server_id)}
                    onDoubleClick={() => setDetailServer(candidate)}
                    title="双击查看详细信息"
                    type="button"
                  >
                    <span className="text-lg font-bold">{formatMoney(effective)}/小时</span>
                  </button>
                );
              })}
              {filteredCandidates.length === 0 ? <p className="text-sm text-stone-500">当前价格范围内没有候选。</p> : null}
            </div>
            <p className="mt-3 text-xs text-stone-500">当前选中：{selectedCandidate ? `${formatMoney(selectedCandidate.effective_usd_per_hour)}/h` : "未选择"}</p>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">手动租用控制</h2>
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">确认任务只会进入等待队列。租用必须先在上方选择一个显卡队列，再进入现有手动授权流程；不会自动选择另一队列或模型。</p>
            <div className="mt-3 space-y-2 text-sm">
              {autorentRequests.slice(0, 5).map((request) => (
                <div className="rounded-md border border-stone-200 bg-[#faf8f4] p-2" key={request.id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold">{autorentStatusLabels[request.status]} · {request.priority === "urgent" ? "立即" : "普通"}</p>
                    {!["assigned", "failed", "cancelled"].includes(request.status) ? (
                      <button className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs" onClick={() => void cancelAutorent(request.id)} type="button">
                        取消寻找
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-stone-500">最高 {formatMoney(Number(request.max_effective_hourly_usd))}/小时 · {request.selected_server_id ?? "未选主机"}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {rentalPlan ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4" onClick={() => void abortRentalSearch()}>
          <section className="w-full max-w-lg rounded-lg bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-xl font-bold">确认手动租用</h2>
            <p className="mt-2 text-sm text-stone-600">本次计划只绑定 {rentalPlan.gpu_class === "rtx5090" ? "RTX 5090" : "RTX 4090"} {rentalPlan.generation_family === "image" ? "图片" : "视频"}队列，共 {rentalPlan.confirmed_task_ids.length} 个任务。</p>
            <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">显卡会持续计费，直到安全退租完成。请逐字输入下方服务器与价格确认文字。</p>
            <p className="mt-3 break-words rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2 text-xs font-semibold" data-testid="rental-confirmation-text">{rentalPlan.required_confirmation_text}</p>
            <textarea className="mt-3 min-h-24 w-full rounded-md border border-stone-300 p-3 text-sm" onChange={(event) => setRentalConfirmationText(event.target.value)} placeholder="输入完整确认文字" value={rentalConfirmationText} />
            <label className="mt-3 flex items-start gap-2 text-sm"><input checked={rentalRiskAccepted} className="mt-1 h-4 w-4" onChange={(event) => setRentalRiskAccepted(event.target.checked)} type="checkbox" /><span>我已核对服务器、价格和持续计费风险，并确认只执行当前显卡队列。</span></label>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-md border border-stone-200 px-3 py-2 text-sm font-semibold" onClick={() => void abortRentalSearch()} type="button">取消寻卡</button>
              <button className="rounded-md bg-rose-700 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-300" disabled={isStartingExecution || !rentalRiskAccepted || rentalConfirmationText.trim() !== rentalPlan.required_confirmation_text} onClick={() => void confirmRentalPlan()} type="button">确认租用</button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingGpuAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4" onClick={() => setPendingGpuAction(null)}>
          <section className="w-full max-w-md rounded-lg bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-xl font-bold">{pendingGpuAction === "stop" ? "确认终止生成？" : "确认退租显卡？"}</h2>
            <p className="mt-2 text-sm text-stone-600">{pendingGpuAction === "stop" ? "当前任务将停止，但GPU不会退租，仍会继续计费。" : "当前生成将停止，显卡将立即退租。未完成任务会保留在待处理队列中。"}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-md border border-stone-200 px-3 py-2 text-sm font-semibold" onClick={() => setPendingGpuAction(null)} type="button">返回</button>
              <button className="rounded-md bg-rose-700 px-3 py-2 text-sm font-bold text-white" onClick={() => void confirmGpuAction()} type="button">{pendingGpuAction === "stop" ? "确认终止" : "确认退租"}</button>
            </div>
          </section>
        </div>
      ) : null}

      {rentalSuccessOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4" onClick={() => setRentalSuccessOpen(false)}>
          <section className="w-full max-w-md rounded-lg bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-xl font-bold">租用成功</h2>
            <p className="mt-2 text-sm text-stone-600">已租用 {execution.rentedGpuClass === "rtx4090" ? "RTX 4090" : "RTX 5090"}，正在部署{execution.activeExecution?.generationFamily === "video" ? "视频" : "图片"}模型。</p>
            <button className="mt-4 w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white" onClick={() => setRentalSuccessOpen(false)} type="button">知道了</button>
          </section>
        </div>
      ) : null}

      {detailServer ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4" onClick={() => setDetailServer(null)}>
          <section className="w-full max-w-lg rounded-lg bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold">主机详情</h2>
                <p className="text-sm text-stone-500">Server {detailServer.server_id}</p>
              </div>
              <button className="rounded-md border border-stone-200 px-3 py-2" onClick={() => setDetailServer(null)} type="button">
                关闭
              </button>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-stone-500">GPU</dt><dd>{detailServer.gpu} x {detailServer.gpu_count ?? 1}</dd></div>
              <div><dt className="text-stone-500">显存</dt><dd>{detailServer.gpu_memory_raw_value ?? detailServer.gpu_memory_gb} {detailServer.gpu_memory_raw_unit ?? "GB"}</dd></div>
              <div><dt className="text-stone-500">RAM</dt><dd>{formatNumber(detailServer.ram_gb, "GB")}</dd></div>
              <div><dt className="text-stone-500">磁盘</dt><dd>{formatNumber(detailServer.disk_gb, "GB")}</dd></div>
              <div><dt className="text-stone-500">网络</dt><dd>{formatNumber(detailServer.download_mbps, "↓")} / {formatNumber(detailServer.upload_mbps, "↑")}</dd></div>
              <div><dt className="text-stone-500">地区</dt><dd>{detailServer.country ?? "未知"}</dd></div>
              <div><dt className="text-stone-500">可靠性</dt><dd>{formatNumber(detailServer.reliability)}</dd></div>
              <div><dt className="text-stone-500">基础价</dt><dd>{formatMoney(detailServer.base_usd_per_hour ?? detailServer.normalized_usd_per_hour)}/h</dd></div>
              <div><dt className="text-stone-500">含费用价</dt><dd>{formatMoney(detailServer.effective_usd_per_hour)}/h</dd></div>
              <div><dt className="text-stone-500">预计总价</dt><dd>{formatMoney(detailServer.max_session_projected_total_usd)}</dd></div>
            </dl>
          </section>
        </div>
      ) : null}
    </main>
  );
}
