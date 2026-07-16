"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { VIDEO_JOB_SELECT_FIELDS } from "@/lib/video-jobs/fields";
import { requestSignedVideoUrl } from "@/lib/video-jobs/signed-url";
import { videoJobStatusLabels } from "@/types/video-config";
import type { SignedVideoResponse, VideoJob, VideoJobStatus, VideoJobWithBalance } from "@/types/video-jobs";
import { normalizeStudioMode, STUDIO_MODE_STORAGE_KEY, type StudioMode } from "@/lib/local-lab/studio-mode";

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

type SessionResponse = {
  status: string;
  orderId: string | null;
  serverId: string | null;
  processingJobs: number;
  lastUpdatedAt: string;
  deploymentHold?: boolean;
  deploymentHoldMessage?: string | null;
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

type BatchGpuMode = "auto" | "current" | "wait_for_current_to_close";

type ImageResult = { sessionId: string; date: string; metadata: Record<string, unknown> | null; imageUrl: string };
type PendingImage = { sessionId: string; completedStages: string[]; status: "pending" | "completed" };
type PoolTaskStatus = "pending_confirmation" | "waiting_for_batch" | "armed" | "waiting_for_gpu" | "deploying" | "restoring_models" | "generating" | "syncing" | "completed" | "failed" | "cancelled";
type PoolTask = { id: string; generationType: StudioMode; prompt: string; modelProfile: string; priority: "normal" | "immediate"; status: PoolTaskStatus; createdAt: string };
type PoolSummary = {
  tasks: PoolTask[];
  counts: Partial<Record<PoolTaskStatus, number>>;
  schedulerState: string;
  imageBatchThreshold: number;
  videoBatchThreshold: number;
  tasksNeeded: { image: number; video: number };
  deploymentHold: boolean;
  marketMonitoringActive: boolean;
  estimatedMaximumSessionCost: number;
  orderBlockingReason: string;
};

const poolStatusLabels: Record<PoolTaskStatus, string> = {
  pending_confirmation: "待确认", waiting_for_batch: "等待凑批", armed: "已准备", waiting_for_gpu: "等待显卡",
  deploying: "正在部署", restoring_models: "正在恢复模型", generating: "正在生成", syncing: "正在同步",
  completed: "已完成", failed: "失败", cancelled: "已取消",
};
const schedulerStateLabels: Record<string, string> = {
  idle: "空闲", batch_ready: "批次已就绪", market_watching: "正在观察市场", candidate_found: "已找到候选",
  order_pending: "等待创建订单", session_active: "显卡会话运行中", draining: "正在排空", completed: "已完成", blocked_by_provider: "平台阻塞",
};
const autorentStatusLabels: Record<AutorentRequest["status"], string> = {
  waiting: "等待中", searching: "寻找显卡", candidate_found: "已找到候选", provisioning: "正在部署", assigned: "已分配", failed: "失败", cancelled: "已取消",
};

const starterPrompt = "A clean text-only 5 second video title card, cinematic lighting, no people, no logos.";

function pickRpcJob(data: unknown): VideoJobWithBalance | null {
  if (Array.isArray(data)) return (data[0] as VideoJobWithBalance | undefined) ?? null;
  return (data as VideoJobWithBalance | null) ?? null;
}

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" ? `$${value.toFixed(3)}` : "未确认";
}

function formatNumber(value: number | null | undefined, suffix = "") {
  return typeof value === "number" ? `${Number(value.toFixed(3))}${suffix}` : "未知";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "尚未记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
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

export function LocalCreationStudio() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [prompt, setPrompt] = useState(starterPrompt);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [counts, setCounts] = useState<JobCounts>({});
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [signedVideos, setSignedVideos] = useState<Record<string, SignedVideoResponse>>({});
  const [localResults, setLocalResults] = useState<LocalResult[]>([]);
  const [candidates, setCandidates] = useState<CloreCandidateSummary[]>([]);
  const [candidateSource, setCandidateSource] = useState("");
  const [selectedServerId, setSelectedServerId] = useState("");
  const [detailServer, setDetailServer] = useState<CloreCandidateSummary | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [autorentRequests, setAutorentRequests] = useState<AutorentRequest[]>([]);
  const [notice, setNotice] = useState("正在恢复本地实验会话...");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isBatching, setIsBatching] = useState(false);
  const [pendingGpuChoice, setPendingGpuChoice] = useState<{ action: "confirm" | "urgent"; jobIds: string[] } | null>(null);
  const [filter, setFilter] = useState<"all" | VideoJobStatus>("all");
  const [minPrice, setMinPrice] = useState("0");
  const [maxPrice, setMaxPrice] = useState("0.70");
  const [mode, setMode] = useState<StudioMode>("video");
  const [imageResults, setImageResults] = useState<ImageResult[]>([]);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [selectedImageId, setSelectedImageId] = useState("");
  const [pool, setPool] = useState<PoolSummary | null>(null);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const localResultForSelected = selectedJob ? localResults.find((result) => result.jobId === selectedJob.id) : null;
  const visibleJobs = filter === "all" ? jobs : jobs.filter((job) => job.status === filter);
  const pendingJobs = visibleJobs.filter((job) => job.status === "pending_confirmation");
  const selectedPendingCount = selectedJobIds.filter((id) => jobs.find((job) => job.id === id)?.status === "pending_confirmation").length;
  const activeAutorent = autorentRequests.find((request) => !["assigned", "failed", "cancelled"].includes(request.status));
  const selectedImage = imageResults.find((result) => result.sessionId === selectedImageId) ?? imageResults[0] ?? null;
  const modePoolTasks = pool?.tasks.filter((task) => task.generationType === mode) ?? [];
  const poolVideoResult = localResults.find((result) => pool?.tasks.some((task) => task.generationType === "video" && task.id === result.jobId)) ?? null;
  const poolVideoTask = poolVideoResult ? pool?.tasks.find((task) => task.id === poolVideoResult.jobId) ?? null : null;
  const previewVideoResult = localResultForSelected ?? poolVideoResult;
  const showingPoolVideo = Boolean(poolVideoResult && previewVideoResult?.jobId === poolVideoResult.jobId && !localResultForSelected);
  const mainVideoUrl = previewVideoResult?.videoUrl ?? (selectedJob ? signedVideos[selectedJob.id]?.signedUrl : null);

  const priceGate = useMemo(() => {
    const min = parsePrice(minPrice);
    const max = parsePrice(maxPrice);
    const valid = min !== null && max !== null && min >= 0 && min <= max && max <= 0.7;
    return { min, max, valid };
  }, [maxPrice, minPrice]);

  const filteredCandidates = useMemo(() => {
    if (!priceGate.valid || priceGate.min === null || priceGate.max === null) return [];
    return candidates
      .filter((candidate) => {
        const effective = candidate.effective_usd_per_hour ?? (candidate.normalized_usd_per_hour ? candidate.normalized_usd_per_hour * 1.05 : null);
        return effective !== null && effective >= priceGate.min! && effective <= priceGate.max!;
      })
      .sort((left, right) => {
        const leftPrice = left.effective_usd_per_hour ?? Number.POSITIVE_INFINITY;
        const rightPrice = right.effective_usd_per_hour ?? Number.POSITIVE_INFINITY;
        return leftPrice - rightPrice;
      });
  }, [candidates, priceGate.max, priceGate.min, priceGate.valid]);

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
    const response = await fetch("/api/local-lab/generation-pool");
    const payload = await response.json().catch(() => null) as PoolSummary | null;
    if (response.ok && payload) setPool(payload);
  }, []);

  const refreshClore = useCallback(async () => {
    const useVisualMock = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("visual_mock") === "1";
    const [candidateResponse, sessionResponse, autorentResponse] = await Promise.all([
      fetch(`/api/local-lab/clore/candidates${useVisualMock ? "?mock=1" : ""}`),
      fetch("/api/local-lab/clore/session"),
      fetch("/api/local-lab/clore/autorent"),
    ]);
    const candidatePayload = (await candidateResponse.json().catch(() => ({}))) as CloreCandidatesResponse;
    const sessionPayload = (await sessionResponse.json().catch(() => ({}))) as SessionResponse;
    const autorentPayload = (await autorentResponse.json().catch(() => ({}))) as { requests?: AutorentRequest[] };

    if (candidateResponse.ok) {
      setCandidates(candidatePayload.matches ?? []);
      setCandidateSource(candidatePayload.source ?? "");
      setSelectedServerId((current) => (current && candidatePayload.matches?.some((candidate) => candidate.server_id === current) ? current : candidatePayload.matches?.[0]?.server_id || ""));
    }
    if (sessionResponse.ok) setSession(sessionPayload);
    if (autorentResponse.ok) setAutorentRequests(autorentPayload.requests ?? []);
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
      await Promise.all([refreshJobs(data.user), refreshResults(), refreshImageResults(), refreshClore(), refreshPool()]);
    }

    void restore();
    return () => {
      mounted = false;
    };
  }, [refreshClore, refreshImageResults, refreshJobs, refreshPool, refreshResults, supabase]);

  useEffect(() => {
    setMode(normalizeStudioMode(window.localStorage.getItem(STUDIO_MODE_STORAGE_KEY)));
  }, []);

  function selectMode(next: StudioMode) {
    setMode(next);
    window.localStorage.setItem(STUDIO_MODE_STORAGE_KEY, next);
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshJobs();
      void refreshResults();
      void refreshImageResults();
      void refreshClore();
      void refreshPool();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refreshClore, refreshImageResults, refreshJobs, refreshPool, refreshResults]);

  useEffect(() => {
    if (!selectedJob || selectedJob.status !== "succeeded" || localResultForSelected?.videoUrl || signedVideos[selectedJob.id]) return;
    void requestSignedVideoUrl(selectedJob.id)
      .then((signedVideo) => setSignedVideos((current) => ({ ...current, [selectedJob.id]: signedVideo })))
      .catch((error) => setNotice(error instanceof Error ? error.message : "获取临时播放链接失败。"));
  }, [localResultForSelected?.videoUrl, selectedJob, signedVideos]);

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
      if (mode === "image") {
        const response = await fetch("/api/local-lab/generation-pool", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", generationType: "image", prompt: trimmedPrompt, modelProfile: "flux2-klein-4b" }) });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) { setNotice(payload.error ?? "创建图片任务失败。"); return; }
        setPrompt("");
        setNotice("图片任务已加入任务池，确认后将等待同类任务凑批；不会在部署暂停期间创建订单。");
        await refreshPool();
        return;
      }
      const { data, error } = await supabase.rpc("create_video_job", { p_prompt: trimmedPrompt, p_model_key: "standard-video" });
      if (error) {
        setNotice(error.message.split("\n")[0] || "创建未生成任务失败。");
        return;
      }
      const createdJob = pickRpcJob(data);
      if (createdJob) {
        setSelectedJobId(createdJob.id);
        await fetch("/api/local-lab/generation-pool", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync", tasks: [{ id: createdJob.id, generationType: "video", prompt: createdJob.prompt, modelProfile: "wan22-ti2v-5b", priority: "normal", status: "pending_confirmation", createdAt: createdJob.created_at, confirmedAt: createdJob.confirmed_at, estimatedVram: 24, outputMetadata: {} }] }) });
      }
      setPrompt("");
      setNotice("已扣除积分并创建未生成任务。确认或加急后才会进入队列。");
      await Promise.all([refreshJobs(), refreshPool()]);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function runPoolAction(action: "confirm" | "immediate" | "cancel" | "delete" | "regenerate") {
    const eligible = modePoolTasks.filter((task) => action === "confirm" || action === "immediate" ? task.status === "pending_confirmation" : !["deploying", "restoring_models", "generating", "syncing"].includes(task.status));
    if (!eligible.length) { setNotice("当前模式没有可执行该操作的任务。"); return; }
    if (mode === "video" && action === "cancel" && supabase) {
      for (const task of eligible) await supabase.rpc("cancel_video_job", { p_job_id: task.id });
    }
    const response = await fetch("/api/local-lab/generation-pool", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, taskIds: eligible.map((task) => task.id) }) });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    setNotice(response.ok ? ({ confirm: "任务已确认，等待达到批量阈值。", immediate: "立即任务已锁定批次，部署暂停期间只观察市场。", cancel: "任务已取消；视频任务沿用原退款规则。", delete: "任务已从本地调度池删除。", regenerate: "已创建新的待确认任务。" }[action]) : payload.error ?? "任务池操作失败。");
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

  function requestBatch(action: "confirm" | "urgent" | "delete" | "regenerate") {
    if (selectedJobIds.length === 0 || isBatching) return;
    if ((action === "confirm" || action === "urgent") && session?.orderId) {
      setPendingGpuChoice({ action, jobIds: [...selectedJobIds] });
      return;
    }
    void runBatch(action, "auto", selectedJobIds);
  }

  async function runBatch(action: "confirm" | "urgent" | "delete" | "regenerate", gpuMode: BatchGpuMode = "auto", targetJobIds = selectedJobIds) {
    if (targetJobIds.length === 0 || isBatching) return;
    if (!priceGate.valid || priceGate.min === null || priceGate.max === null) {
      setNotice("请先保存合法的GPU单价范围，最高不得超过 $0.70/小时。");
      return;
    }

    setIsBatching(true);
    setPendingGpuChoice(null);
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
          gpuMode,
          minEffectiveHourlyUsd: priceGate.min,
          maxEffectiveHourlyUsd: priceGate.max,
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
      const labels = { confirm: "确认生成", urgent: "立即生成", delete: "删除", regenerate: "重新生成" };
      const gpuModeNote = gpuMode === "current" ? "已加入当前GPU队列，不创建新的寻机请求。" : "任务已进入Clore调度安全门；没有合规主机时不会创建订单。";
      setNotice(`${labels[action]}已提交。${gpuModeNote}`);
      await Promise.all([refreshJobs(), refreshClore()]);
    } finally {
      setIsBatching(false);
    }
  }

  async function tickAutorent() {
    const response = await fetch("/api/local-lab/clore/autorent", { method: "POST" });
    const payload = (await response.json().catch(() => ({}))) as { note?: string; error?: string };
    setNotice(payload.note ?? payload.error ?? "调度状态已推进。");
    await Promise.all([refreshClore(), refreshPool()]);
  }

  async function cancelAutorent(requestId: string) {
    const response = await fetch(`/api/local-lab/clore/autorent/${requestId}`, { method: "DELETE" });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    setNotice(response.ok ? "自动寻机请求已取消。" : payload.error ?? "取消自动寻机失败。");
    await refreshClore();
  }

  function toggleSelected(jobId: string) {
    setSelectedJobIds((current) => (current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]));
  }

  function selectAllPending() {
    const ids = pendingJobs.map((job) => job.id);
    setSelectedJobIds(ids.length === selectedPendingCount ? [] : ids);
  }

  return (
    <main className="min-h-screen bg-[#f5f0e8] text-stone-900">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-[#f5f0e8]/95 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">local_lab</p>
            <h1 className="text-2xl font-bold">本地创作台</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link className="rounded-md border border-stone-200 bg-white px-3 py-2 font-semibold text-stone-700" href="/generate/4090">
              4090
            </Link>
            <Link className="rounded-md border border-stone-200 bg-white px-3 py-2 font-semibold text-stone-700" href="/generate/5090">
              5090
            </Link>
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">{mode === "image" ? `图片 ${imageResults.length}` : `未生成 ${counts.pending_confirmation ?? 0}`}</span>
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">{mode === "image" ? `图片任务 ${pendingImage?.status === "pending" ? 1 : 0}` : `排队 ${counts.queued ?? 0}`}</span>
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">GPU {session?.orderId ? "运行中" : "无"}</span>
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">Wan2.2 TI2V-5B</span>
            <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 font-semibold text-emerald-800">积分 ∞</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="space-y-5">
          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
            <div className="aspect-video bg-[#1f1f1f]">
              {mode === "image" && selectedImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="生成图片预览" className="h-full w-full bg-black object-contain" src={selectedImage.imageUrl} />
              ) : mode === "video" && mainVideoUrl ? (
                <video className="h-full w-full bg-black object-contain" controls playsInline src={mainVideoUrl} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center text-stone-100">
                  <p className="text-sm font-semibold text-stone-400">{mode === "image" ? (pendingImage?.status === "pending" ? "等待真实GPU" : "未选择图片") : selectedJob ? videoJobStatusLabels[selectedJob.status] : "未选择任务"}</p>
                  <h2 className="mt-3 text-2xl font-bold">{mode === "image" ? "暂无可预览图片" : selectedJob ? generationLabel(selectedJob) : "暂无可播放视频"}</h2>
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
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 bg-[#faf8f4] px-4 py-3 text-sm">
              <div>
                <p className="font-semibold">{mode === "image" ? (selectedImage?.sessionId ?? pendingImage?.sessionId ?? "首张FLUX图片") : showingPoolVideo && poolVideoTask ? safePromptPreview(poolVideoTask.prompt) : selectedJob ? safePromptPreview(selectedJob.prompt) : "选择任务后会在这里显示"}</p>
                <p className="text-stone-500">{mode === "image" ? (selectedImage ? "图片已完成并保存到本地" : "图片任务等待受控Clore调度") : showingPoolVideo ? "任务池视频已完成并保存到本地" : selectedJob ? `${videoJobStatusLabels[selectedJob.status]} · ${etaText(selectedJob, jobs)}` : "未生成任务需要确认或立即生成后才会进入队列"}</p>
              </div>
              <span className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">短期签名播放 · 本地结果优先</span>
            </div>
          </div>

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
                value={prompt}
              />
              <div className="absolute bottom-3 right-3 flex rounded-md border border-stone-300 bg-white p-1 text-sm font-semibold">
                <button className={`rounded px-3 py-1.5 ${mode === "image" ? "bg-stone-900 text-white" : "text-stone-600"}`} onClick={() => selectMode("image")} type="button">图片</button>
                <button className={`rounded px-3 py-1.5 ${mode === "video" ? "bg-stone-900 text-white" : "text-stone-600"}`} onClick={() => selectMode("video")} type="button">视频</button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-stone-500">{prompt.trim().length}/2000</span>
              <button
                className="rounded-md bg-emerald-700 px-5 py-3 text-sm font-bold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={isSubmitting || !user}
                onClick={() => void submitPrompt()}
                type="button"
              >
                {isSubmitting ? "创建中..." : mode === "image" ? "创建图片任务" : "创建未生成任务"}
              </button>
            </div>
            {notice ? <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p> : null}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">生成队列</h2>
                <p className="text-sm text-stone-500">{mode === "image" ? `图片每 ${pool?.imageBatchThreshold ?? 3} 个普通任务触发` : `视频每 ${pool?.videoBatchThreshold ?? 2} 个普通任务触发`}；立即任务无需等待阈值。</p>
              </div>
              <span className="rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{pool?.deploymentHold ? "Clore 部署已暂停" : "Clore 可由操作员恢复"}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {(["pending_confirmation", "waiting_for_batch", "waiting_for_gpu", "deploying", "restoring_models", "generating", "syncing", "completed", "failed"] as PoolTaskStatus[]).map((status) => (
                <div className="rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2" key={status}><span className="text-stone-500">{poolStatusLabels[status]}</span><strong className="ml-2">{modePoolTasks.filter((task) => task.status === status || (status === "waiting_for_gpu" && task.status === "armed")).length}</strong></div>
              ))}
            </div>
            <div className="mt-3 grid gap-1 text-sm text-stone-600 sm:grid-cols-2">
              <p>还需 {mode === "image" ? pool?.tasksNeeded.image ?? 3 : pool?.tasksNeeded.video ?? 2} 个任务触发</p>
              <p>市场监控：{pool?.marketMonitoringActive ? "运行中" : "未启动"}</p>
              <p>预计最高会话费用：${(pool?.estimatedMaximumSessionCost ?? 2.5).toFixed(2)}</p>
              <p>调度状态：{schedulerStateLabels[pool?.schedulerState ?? "idle"] ?? "未知状态"}</p>
            </div>
            <p className="mt-2 rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700">{pool?.orderBlockingReason ?? "正在读取调度门禁。"}</p>
            {mode === "video" && poolVideoResult?.thumbnailUrl && poolVideoResult.videoUrl ? (
              <div className="mt-3 flex items-center gap-3 rounded-md border border-stone-200 bg-[#faf8f4] p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="任务池视频缩略图" className="h-16 w-28 rounded object-cover" src={poolVideoResult.thumbnailUrl} />
                <div><p className="text-sm font-semibold">任务池视频已同步</p><p className="text-xs text-stone-500">刷新页面或重启应用后仍可播放本地 MP4。</p></div>
              </div>
            ) : null}
            {mode === "image" ? <div className="mt-3 flex flex-wrap gap-2">
              <button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white" onClick={() => void runPoolAction("confirm")} type="button">确认生成</button>
              <button className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-bold text-white" onClick={() => void runPoolAction("immediate")} type="button">立即生成</button>
              <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => void runPoolAction("cancel")} type="button">取消</button>
              <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => void runPoolAction("delete")} type="button">删除</button>
              <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => void runPoolAction("regenerate")} type="button">重新生成</button>
            </div> : null}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{mode === "image" ? "图片任务" : "视频任务"}</h2>
                <p className="text-sm text-stone-500">{mode === "image" ? "显示待执行首图任务和已保存图片。" : "点击任务切换主播放器；勾选任务后可批量操作。"}</p>
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

            {mode === "video" && selectedJobIds.length > 0 ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-stone-200 bg-[#faf8f4] p-3">
                <span className="text-sm font-semibold">已选 {selectedJobIds.length}</span>
                <button className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => requestBatch("urgent")} type="button">
                  立即生成
                </button>
                <button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => requestBatch("confirm")} type="button">
                  确认生成
                </button>
                <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:bg-stone-100" disabled={isBatching} onClick={() => requestBatch("regenerate")} type="button">
                  重新生成
                </button>
                <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:bg-stone-100" disabled={isBatching} onClick={() => void cancelSelectedVideoTasks()} type="button">
                  取消
                </button>
                <button className="rounded-md bg-rose-700 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => requestBatch("delete")} type="button">
                  删除
                </button>
              </div>
            ) : null}

            {mode === "video" ? <div className="mt-4 flex items-center gap-2">
              <input checked={pendingJobs.length > 0 && pendingJobs.length === selectedPendingCount} className="h-4 w-4" onChange={selectAllPending} type="checkbox" />
              <button className="text-sm font-semibold text-stone-700" onClick={selectAllPending} type="button">
                全选未生成任务
              </button>
            </div> : null}

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {mode === "image" ? (
                <>
                  {pendingImage?.status === "pending" ? (
                    <article className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <div className="flex items-center justify-between gap-2"><p className="font-semibold">首张FLUX真实图片</p><span className="rounded-md border border-amber-200 bg-white px-2 py-1 text-xs">等待调度</span></div>
                      <p className="mt-3 text-sm text-stone-600">已完成 {pendingImage.completedStages.length} 个执行阶段；任务继续保留在任务池。</p>
                    </article>
                  ) : null}
                  {imageResults.map((image) => (
                    <article className={`rounded-lg border p-3 ${selectedImage?.sessionId === image.sessionId ? "border-stone-900 bg-[#faf8f4]" : "border-stone-200"}`} key={image.sessionId}>
                      <button className="aspect-square w-full overflow-hidden rounded-md bg-stone-100" onClick={() => setSelectedImageId(image.sessionId)} type="button">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img alt="已完成图片" className="h-full w-full object-cover" src={image.imageUrl} />
                      </button>
                      <p className="mt-3 break-all text-sm font-semibold">{image.sessionId}</p><p className="mt-1 text-xs text-stone-500">{image.date} · 已完成</p>
                    </article>
                  ))}
                </>
              ) : visibleJobs.map((job) => {
                const localResult = localResults.find((result) => result.jobId === job.id);
                const selectable = job.status === "pending_confirmation" || job.status === "queued" || job.status === "failed" || job.status === "canceled" || job.status === "succeeded";
                return (
                  <article className={`relative rounded-lg border p-3 ${selectedJobId === job.id ? "border-stone-900 bg-[#faf8f4]" : "border-stone-200 bg-white"}`} key={job.id}>
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm font-semibold">
                        <input checked={selectedJobIds.includes(job.id)} className="h-4 w-4" disabled={!selectable} onChange={() => toggleSelected(job.id)} type="checkbox" />
                        {generationLabel(job)}
                      </label>
                      <span className={`rounded-md border px-2 py-1 text-xs ${statusBadgeClass(job.status)}`}>{videoJobStatusLabels[job.status]}</span>
                    </div>
                    <button className="mt-3 aspect-video w-full overflow-hidden rounded-md bg-stone-100 text-left" onClick={() => setSelectedJobId(job.id)} type="button">
                      {localResult?.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img alt="任务封面" className="h-full w-full object-cover" src={localResult.thumbnailUrl} />
                      ) : (
                        <div className="flex h-full items-center justify-center px-3 text-center text-sm text-stone-500">{etaText(job, jobs)}</div>
                      )}
                    </button>
                    <p className="mt-3 text-sm font-semibold leading-5">{safePromptPreview(job.prompt)}</p>
                    <p className="mt-2 text-xs text-stone-500">{formatDateTime(job.created_at)} · {job.priority === "urgent" ? "加急" : "普通"} · {etaText(job, jobs)}</p>
                  </article>
                );
              })}
            </div>
          </section>
        </section>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">GPU 价格筛选</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-sm">
                最低美元/小时
                <input className="mt-1 w-full rounded-md border border-stone-200 bg-[#faf8f4] px-2 py-2" onChange={(event) => setMinPrice(event.target.value)} value={minPrice} />
              </label>
              <label className="text-sm">
                最高美元/小时
                <input className="mt-1 w-full rounded-md border border-stone-200 bg-[#faf8f4] px-2 py-2" onChange={(event) => setMaxPrice(event.target.value)} value={maxPrice} />
              </label>
            </div>
            <p className={`mt-2 text-xs ${priceGate.valid ? "text-emerald-700" : "text-rose-700"}`}>
              {priceGate.valid ? "价格范围有效，按含5%租客费小时价过滤。" : "非法输入不会保存或触发寻机，最高价不得超过 $0.70/小时。"}
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
            <h2 className="text-lg font-bold">自动寻机</h2>
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{session?.deploymentHold ? "Clore自动调度已安全暂停" : "任务就绪且存在合规主机时，调度器才允许创建订单。"}</p>
            <button className="mt-3 w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-semibold" onClick={() => void tickAutorent()} type="button">
              推进调度状态
            </button>
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

      {pendingGpuChoice ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4" onClick={() => setPendingGpuChoice(null)}>
          <section className="w-full max-w-md rounded-lg bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-xl font-bold">已有GPU正在运行</h2>
            <p className="mt-2 text-sm text-stone-600">同时最多只能有一台GPU。请选择这批任务进入当前GPU队列，或等当前GPU退订后再自动寻找最低价GPU。</p>
            <div className="mt-4 grid gap-2">
              <button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => void runBatch(pendingGpuChoice.action, "current", pendingGpuChoice.jobIds)} type="button">
                使用当前GPU并加入{pendingGpuChoice.action === "urgent" ? "加急" : "普通"}队列
              </button>
              <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:bg-stone-100" disabled={isBatching} onClick={() => void runBatch(pendingGpuChoice.action, "wait_for_current_to_close", pendingGpuChoice.jobIds)} type="button">
                等当前GPU退订后，再自动寻找最低价GPU
              </button>
              <button className="rounded-md border border-stone-200 px-3 py-2 text-sm font-semibold" onClick={() => setPendingGpuChoice(null)} type="button">
                取消
              </button>
            </div>
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
