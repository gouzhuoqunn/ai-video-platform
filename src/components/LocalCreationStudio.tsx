"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { requestSignedVideoUrl } from "@/lib/video-jobs/signed-url";
import { videoJobStatusLabels } from "@/types/video-config";
import type { SignedVideoResponse, VideoJob, VideoJobWithBalance } from "@/types/video-jobs";

type JobCounts = {
  queued: number;
  processing: number;
  succeeded: number;
  failed: number;
  canceled: number;
};

type LocalJobsResponse = {
  jobs: VideoJob[];
  counts: JobCounts;
  error?: string;
};

type CloreCandidateSummary = {
  server_id: string;
  gpu: string;
  gpu_normalized_name: string;
  gpu_memory_gb: number | null;
  gpu_memory_raw_value: number | null;
  gpu_memory_raw_unit: string | null;
  gpu_memory_note: string;
  ram_gb: number | null;
  cpu_cores: number | null;
  disk_gb: number | null;
  download_mbps: number | null;
  upload_mbps: number | null;
  reliability: number | null;
  rating: number | null;
  rating_count: number | null;
  country: string | null;
  original_on_demand_price: string | null;
  normalized_usd_per_hour: number | null;
  six_hour_cost_usd: number | null;
  currently_rentable: boolean;
  risk_tier: "A" | "B" | "reject";
  risk_notes: string[];
  missing_fields: string[];
  min_billing_note?: string;
  platform_total_price_status?: string;
  rejection_reasons?: string[];
};

type CloreCandidatesResponse = {
  mode: string;
  source: string;
  wallet?: {
    available_usd_balance: number | null;
    source: string;
  };
  filters?: {
    max_usd_per_hour: number;
    assumed_minimum_rental_hours: number;
  };
  matches: CloreCandidateSummary[];
  rejected5090?: CloreCandidateSummary[];
  closest_rejected_5090?: CloreCandidateSummary[];
  selected?: CloreCandidateSummary | null;
  last_refreshed_at?: string;
  error?: string;
};

type WalletResponse = {
  available_usd_balance: number | null;
  source?: string;
  balances?: Array<{ name: string; currency: string | null; available: number | null; usd_like: boolean }>;
  error?: string;
};

type SessionResponse = {
  status: string;
  orderId: string | null;
  serverId: string | null;
  startedAt: string | null;
  lastUpdatedAt: string;
  estimatedUsdPerHour: number | null;
  processingJobs: number;
  notes: string[];
  deploymentTimeline: string[];
  localResults: {
    libraryDir: string;
    cleanupDryRun: boolean;
  };
  runtimeImage?: {
    image: string;
    customRuntimeConfigured: boolean;
    digestPinned: boolean;
    publicPullExpected: boolean;
  };
  modelCache?: {
    provider: string;
    bucketConfigured: boolean;
    endpointConfigured: boolean;
    prefix: string;
    seedFlowImplemented?: boolean;
    seedStatus?: string;
    presignedUploadSupported?: boolean;
    multipartUploadSupported?: boolean;
    currentManifestKey?: string;
    readonlyCredentialFile?: string;
    adminCredentialsOnGpu?: boolean;
    signedUrlsReturnedToBrowser?: boolean;
    readOnlyMode: boolean;
    r2Enabled: boolean;
    hfFallbackEnabled: boolean;
    officialRepo: string;
    expectedSizeGb: number;
    credentialsReturned: boolean;
  };
  error?: string;
};

type LocalResult = {
  jobId: string;
  hasVideo: boolean;
  hasThumbnail: boolean;
  videoUrl: string | null;
  thumbnailUrl: string | null;
};

type ResultsResponse = {
  results: LocalResult[];
  error?: string;
};

type OrderPlan = {
  nonce: string;
  server_id: string;
  max_price_usd_per_hour: number;
  expires_at: string;
  required_confirmation_text: string;
  execution_limits?: {
    first_session_max_budget_usd: number;
    balance_reserve_usd: number;
    hard_session_limit_minutes: number;
    order_start_timeout_minutes: number;
    worker_ready_timeout_minutes: number;
    first_gpu_session: boolean;
  };
};

type HostSortMode = "price-asc" | "price-desc" | "reliability-desc" | "rating-desc";

type DeleteResponse = {
  deleted?: boolean;
  error?: string;
};

const emptyCounts: JobCounts = {
  queued: 0,
  processing: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
};

const starterPrompt = "一位穿银色雨衣的女孩站在夜晚霓虹街道中央，镜头缓慢推进，地面积水反射蓝绿色灯光，电影感，1280x704，5秒。";

function pickRpcJob(data: unknown): VideoJobWithBalance | null {
  if (Array.isArray(data)) {
    return (data[0] as VideoJobWithBalance | undefined) ?? null;
  }

  return (data as VideoJobWithBalance | null) ?? null;
}

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "API 未确认";
}

function formatNumber(value: number | null | undefined, suffix = "") {
  return typeof value === "number" ? `${Number(value.toFixed(3))}${suffix}` : "未知";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "尚未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function safePromptPreview(prompt: string) {
  return prompt.length > 72 ? `${prompt.slice(0, 72)}...` : prompt;
}

function statusBadgeClass(status: VideoJob["status"]) {
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "processing") return "border-sky-200 bg-sky-50 text-sky-800";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-800";
  if (status === "canceled") return "border-stone-200 bg-stone-100 text-stone-700";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

export function LocalCreationStudio() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [prompt, setPrompt] = useState(starterPrompt);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [counts, setCounts] = useState<JobCounts>(emptyCounts);
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [signedVideos, setSignedVideos] = useState<Record<string, SignedVideoResponse>>({});
  const [localResults, setLocalResults] = useState<LocalResult[]>([]);
  const [notice, setNotice] = useState(() => (supabase ? "正在恢复本地实验会话..." : "Supabase 尚未配置，无法使用 local_lab。"));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancelingJobId, setCancelingJobId] = useState("");
  const [candidatePayload, setCandidatePayload] = useState<CloreCandidatesResponse | null>(null);
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [showRejected, setShowRejected] = useState(false);
  const [hostSortMode, setHostSortMode] = useState<HostSortMode>("price-asc");
  const [confirmMessage, setConfirmMessage] = useState("");
  const [promptFilter, setPromptFilter] = useState<"all" | VideoJob["status"]>("all");
  const [deleteJob, setDeleteJob] = useState<VideoJob | null>(null);
  const [deletingJobId, setDeletingJobId] = useState("");
  const [deleteMessage, setDeleteMessage] = useState("");

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const sortedCandidates = useMemo(() => {
    const riskRank = { A: 0, B: 1, reject: 2 };
    return [...(candidatePayload?.matches ?? [])].sort((left, right) => {
      const leftPrice = left.normalized_usd_per_hour ?? Number.POSITIVE_INFINITY;
      const rightPrice = right.normalized_usd_per_hour ?? Number.POSITIVE_INFINITY;
      if (hostSortMode === "price-desc" && leftPrice !== rightPrice) return rightPrice - leftPrice;
      if (hostSortMode === "price-asc" && leftPrice !== rightPrice) return leftPrice - rightPrice;
      if (hostSortMode === "reliability-desc" && left.reliability !== right.reliability) return (right.reliability ?? -1) - (left.reliability ?? -1);
      if (hostSortMode === "rating-desc" && left.rating !== right.rating) return (right.rating ?? -1) - (left.rating ?? -1);
      if (riskRank[left.risk_tier] !== riskRank[right.risk_tier]) return riskRank[left.risk_tier] - riskRank[right.risk_tier];
      if ((left.reliability ?? -1) !== (right.reliability ?? -1)) return (right.reliability ?? -1) - (left.reliability ?? -1);
      if ((left.rating ?? -1) !== (right.rating ?? -1)) return (right.rating ?? -1) - (left.rating ?? -1);
      return (right.download_mbps ?? 0) + (right.upload_mbps ?? 0) - ((left.download_mbps ?? 0) + (left.upload_mbps ?? 0));
    });
  }, [candidatePayload?.matches, hostSortMode]);
  const selectedCandidate = selectedServerId ? sortedCandidates.find((candidate) => candidate.server_id === selectedServerId) ?? null : null;
  const localResultForSelected = selectedJob ? localResults.find((result) => result.jobId === selectedJob.id) : null;
  const mainVideoUrl =
    localResultForSelected?.videoUrl ??
    (selectedJob && signedVideos[selectedJob.id] ? signedVideos[selectedJob.id].signedUrl : null);
  const filteredJobs = promptFilter === "all" ? jobs : jobs.filter((job) => job.status === promptFilter);

  const refreshJobs = useCallback(async () => {
    const response = await fetch("/api/local-lab/jobs", { method: "GET" });
    const payload = (await response.json().catch(() => ({}))) as LocalJobsResponse;
    if (!response.ok) {
      setNotice(payload.error ?? "无法读取本地任务。");
      return;
    }

    setJobs(payload.jobs);
    setCounts(payload.counts);
    setSelectedJobId((current) => current || payload.jobs[0]?.id || "");
  }, []);

  const refreshResults = useCallback(async () => {
    const response = await fetch("/api/local-lab/results", { method: "GET" });
    const payload = (await response.json().catch(() => ({}))) as ResultsResponse;
    if (response.ok) {
      setLocalResults(payload.results);
    }
  }, []);

  const refreshClore = useCallback(async () => {
    const [candidatesResponse, walletResponse, sessionResponse] = await Promise.all([
      fetch("/api/local-lab/clore/candidates"),
      fetch("/api/local-lab/clore/wallet"),
      fetch("/api/local-lab/clore/session"),
    ]);

    const [candidatesPayload, walletPayload, sessionPayload] = await Promise.all([
      candidatesResponse.json().catch(() => ({})),
      walletResponse.json().catch(() => ({})),
      sessionResponse.json().catch(() => ({})),
    ]);

    if (candidatesResponse.ok) {
      const typedCandidates = candidatesPayload as CloreCandidatesResponse;
      setCandidatePayload(typedCandidates);
      setSelectedServerId((current) => {
        if (current && typedCandidates.matches.some((candidate) => candidate.server_id === current && candidate.currently_rentable)) {
          return current;
        }
        if (current) {
          window.setTimeout(() => {
            setConfirmMessage("当前选中的主机已不在可租列表，请重新选择一台可租候选。");
          }, 0);
          return "";
        }
        return typedCandidates.matches[0]?.server_id || "";
      });
    }
    if (walletResponse.ok) setWallet(walletPayload as WalletResponse);
    if (sessionResponse.ok) setSession(sessionPayload as SessionResponse);
  }, []);

  useEffect(() => {
    const client = supabase;
    if (!client) {
      return;
    }

    const activeClient = client;
    let mounted = true;
    async function restoreSession() {
      const response = await fetch("/api/local-lab/session", { method: "POST" });
      if (!mounted) return;
      if (!response.ok) {
        setNotice("本地实验账号自动登录失败。请先运行 npm run local-lab:setup。");
        return;
      }

      const { data } = await activeClient.auth.getUser();
      if (!mounted) return;
      setUser(data.user);
      setNotice("本地实验模式已就绪。GPU 尚未启动，提示词会先停留在 queued。");
      await Promise.all([refreshJobs(), refreshResults(), refreshClore()]);
    }

    void restoreSession();

    return () => {
      mounted = false;
    };
  }, [refreshClore, refreshJobs, refreshResults, supabase]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshJobs();
      void refreshResults();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshJobs, refreshResults]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshClore();
    }, 30000);

    return () => window.clearInterval(interval);
  }, [refreshClore]);

  useEffect(() => {
    if (!selectedJob || selectedJob.status !== "succeeded" || localResultForSelected?.videoUrl || signedVideos[selectedJob.id]) {
      return;
    }

    void requestSignedVideoUrl(selectedJob.id)
      .then((signedVideo) => {
        setSignedVideos((current) => ({ ...current, [selectedJob.id]: signedVideo }));
      })
      .catch((error) => {
        setNotice(error instanceof Error ? error.message : "获取 Supabase 临时播放链接失败。");
      });
  }, [localResultForSelected?.videoUrl, selectedJob, signedVideos]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDeleteJob(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      const { data, error } = await supabase.rpc("create_video_job", {
        p_prompt: trimmedPrompt,
        p_model_key: "standard-video",
      });

      if (error) {
        setNotice(error.message.split("\n")[0] || "加入队列失败。");
        return;
      }

      const createdJob = pickRpcJob(data);
      setNotice("任务已加入生成队列。GPU 未启动时会保持 queued。");
      setPrompt("");
      if (createdJob) setSelectedJobId(createdJob.id);
      await refreshJobs();
    } catch {
      setNotice("加入队列失败，请检查本地 Supabase 配置。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function cancelJob(jobId: string) {
    if (!supabase || !user || cancelingJobId) return;
    setCancelingJobId(jobId);
    try {
      const { error } = await supabase.rpc("cancel_video_job", { p_job_id: jobId });
      if (error) {
        setNotice(error.message.split("\n")[0] || "取消任务失败。");
        return;
      }
      setNotice("queued 任务已取消。");
      await refreshJobs();
    } finally {
      setCancelingJobId("");
    }
  }

  async function deleteHistoryJob() {
    if (!deleteJob || deletingJobId) return;
    setDeletingJobId(deleteJob.id);
    setDeleteMessage("");
    try {
      const response = await fetch(`/api/local-lab/jobs/${encodeURIComponent(deleteJob.id)}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as DeleteResponse;
      if (!response.ok || !payload.deleted) {
        setDeleteMessage(payload.error ?? "删除该记录失败。");
        return;
      }

      const deletedJobId = deleteJob.id;
      setDeleteJob(null);
      setSignedVideos((current) => {
        const next = { ...current };
        delete next[deletedJobId];
        return next;
      });
      setJobs((current) => {
        const next = current.filter((job) => job.id !== deletedJobId);
        if (selectedJobId === deletedJobId) {
          setSelectedJobId(next[0]?.id ?? "");
        }
        return next;
      });
      setLocalResults((current) => current.filter((result) => result.jobId !== deletedJobId));
      setNotice("视频与页面记录已删除，内部积分审计可能保留。");
      await Promise.all([refreshJobs(), refreshResults()]);
    } finally {
      setDeletingJobId("");
    }
  }

  async function downloadJob(job: VideoJob) {
    if (localResults.find((result) => result.jobId === job.id)?.videoUrl) {
      window.location.href = `/api/local-lab/results/${encodeURIComponent(job.id)}/video`;
      return;
    }

    const signedVideo = await requestSignedVideoUrl(job.id);
    setSignedVideos((current) => ({ ...current, [job.id]: signedVideo }));
    window.location.href = signedVideo.signedUrl;
  }

  async function createPlan() {
    if (!selectedCandidate?.normalized_usd_per_hour) {
      setConfirmMessage("请先选择一个可租用候选主机。");
      return;
    }
    setConfirmMessage("正在启动 GPU 会话，后端将重新检查价格、余额、SSH、镜像和活动订单。");

    const response = await fetch("/api/local-lab/clore/order-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverId: selectedCandidate.server_id,
        maxPriceUsdPerHour: selectedCandidate.normalized_usd_per_hour,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as OrderPlan & { error?: string };
    if (!response.ok) {
      setConfirmMessage(payload.error ?? "生成订单计划失败。");
      return;
    }

    const confirmResponse = await fetch("/api/local-lab/clore/order-confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: payload.nonce,
        serverId: payload.server_id,
        maxPriceUsdPerHour: payload.max_price_usd_per_hour,
        confirmationText: "",
        riskAccepted: true,
        queuedJobCount: counts.queued,
      }),
    });
    const confirmPayload = (await confirmResponse.json().catch(() => ({}))) as { message?: string; error?: string };
    setConfirmMessage(confirmPayload.message ?? confirmPayload.error ?? "GPU 会话启动请求已交给后端保护流程。");
    await refreshClore();
  }

  return (
    <main className="min-h-screen bg-[#f5f0e8] text-stone-900">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-[#f5f0e8]/95 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">local_lab</p>
            <h1 className="text-2xl font-bold">本地 Wan2.2 创作台</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">排队 {counts.queued}</span>
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">GPU {session?.status ?? "idle"}</span>
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">Wan2.2 TI2V-5B</span>
            <span className="rounded-md border border-stone-200 bg-white px-3 py-2">本地实验模式</span>
            <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 font-semibold text-emerald-800">积分 ∞</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="space-y-5">
          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
            <div className="aspect-video bg-[#1f1f1f]">
              {mainVideoUrl ? (
                <video className="h-full w-full bg-black object-contain" controls playsInline src={mainVideoUrl} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center text-stone-200">
                  <p className="text-lg font-semibold">暂无可播放视频</p>
                  <p className="mt-2 max-w-xl text-sm text-stone-400">
                    {counts.queued > 0
                      ? "任务已进入队列，选择云端主机并启动 GPU 会话后自动生成。"
                      : "在下方输入提示词，先积累 queued 任务。"}
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
                <p className="font-semibold">{selectedJob ? safePromptPreview(selectedJob.prompt) : "等待第一个提示词"}</p>
                <p className="mt-1 text-stone-500">
                  {selectedJob ? `${videoJobStatusLabels[selectedJob.status]} · 进度 ${selectedJob.progress}% · ${formatDateTime(selectedJob.created_at)}` : notice}
                </p>
              </div>
              {selectedJob?.status === "succeeded" ? (
                <button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-semibold text-white" onClick={() => void downloadJob(selectedJob)} type="button">
                  下载视频
                </button>
              ) : null}
            </div>
          </div>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">提示词队列</h2>
              <span className="text-sm text-stone-500">{prompt.trim().length} 字</span>
            </div>
            <textarea
              className="mt-3 min-h-32 w-full resize-y rounded-md border border-stone-200 bg-[#faf8f4] p-4 leading-7 outline-none focus:border-emerald-500"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submitPrompt();
                }
              }}
              placeholder="输入文字提示词，Ctrl+Enter 加入队列"
              value={prompt}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-stone-600">{notice}</p>
              <button
                className="rounded-md bg-emerald-700 px-5 py-3 text-sm font-bold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={isSubmitting || !user}
                onClick={() => void submitPrompt()}
                type="button"
              >
                {isSubmitting ? "加入中..." : "加入生成队列"}
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-bold">历史视频</h2>
              <div className="flex flex-wrap gap-2 text-sm">
                {(["all", "queued", "processing", "succeeded", "failed"] as const).map((status) => (
                  <button
                    className={`rounded-md border px-3 py-1.5 ${promptFilter === status ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white"}`}
                    key={status}
                    onClick={() => setPromptFilter(status)}
                    type="button"
                  >
                    {status === "all" ? "全部" : videoJobStatusLabels[status]}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredJobs.map((job, index) => {
                const localResult = localResults.find((result) => result.jobId === job.id);
                return (
                  <article className="relative rounded-lg border border-stone-200 bg-[#faf8f4] p-3" key={job.id}>
                    <button
                      aria-label="删除该记录"
                      className="absolute right-5 top-5 z-10 rounded-md border border-stone-200 bg-white/95 p-1.5 text-stone-700 shadow-sm hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
                      disabled={job.status === "processing" || deletingJobId === job.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteJob(job);
                        setDeleteMessage("");
                      }}
                      title={job.status === "processing" ? "视频生成中，不能删除" : "删除该记录"}
                      type="button"
                    >
                      <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M6 6l1 15h10l1-15" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                      </svg>
                      <span className="sr-only">{job.status === "processing" ? "视频生成中，不能删除" : "删除该记录"}</span>
                    </button>
                    <button
                      className="aspect-video w-full overflow-hidden rounded-md bg-stone-200 text-left"
                      onClick={() => setSelectedJobId(job.id)}
                      type="button"
                    >
                      {localResult?.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img alt={`历史视频 ${index + 1} 封面`} className="h-full w-full object-cover" src={localResult.thumbnailUrl} />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm text-stone-500">{videoJobStatusLabels[job.status]}</div>
                      )}
                    </button>
                    <div className="mt-3 flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold leading-5">{safePromptPreview(job.prompt)}</p>
                      <span className={`shrink-0 rounded-md border px-2 py-1 text-xs ${statusBadgeClass(job.status)}`}>{videoJobStatusLabels[job.status]}</span>
                    </div>
                    <p className="mt-2 text-xs text-stone-500">{formatDateTime(job.created_at)} · {localResult?.hasVideo ? "本地已归档" : job.status === "succeeded" ? "云端副本" : "未完成"}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs" onClick={() => void navigator.clipboard.writeText(job.prompt)} type="button">
                        复制
                      </button>
                      <button className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs" onClick={() => setPrompt(job.prompt)} type="button">
                        再次使用
                      </button>
                      {job.status === "queued" ? (
                        <button className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-800" disabled={cancelingJobId === job.id} onClick={() => void cancelJob(job.id)} type="button">
                          {cancelingJobId === job.id ? "取消中" : "取消"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </section>

        <aside
          className={`fixed right-0 top-20 z-40 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-l-lg border border-stone-200 bg-white shadow-xl transition-all duration-200 lg:sticky lg:top-24 lg:w-full lg:rounded-lg lg:p-4 ${
            isPanelOpen ? "w-[min(92vw,400px)] p-4" : "w-14 p-2"
          }`}
        >
          <button
            className="mb-3 flex w-full items-center justify-between rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2 text-sm font-semibold"
            onClick={() => setIsPanelOpen((value) => !value)}
            type="button"
          >
            <span>{isPanelOpen ? "GPU 主机与部署" : "GPU"}</span>
            <span className={`h-2.5 w-2.5 rounded-full ${session?.status === "ready" ? "bg-emerald-500" : "bg-amber-500"}`} />
          </button>

          <div className={`${isPanelOpen ? "block" : "hidden"} lg:block`}>
            <div className="space-y-4 text-sm">
              <section className="rounded-lg border border-stone-200 bg-[#faf8f4] p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-bold">Clore RTX 5090 候选</h2>
                  <button className="rounded-md bg-white px-2 py-1 text-xs font-semibold" onClick={() => void refreshClore()} type="button">
                    刷新
                  </button>
                </div>
                <p className="mt-2 text-xs text-stone-500">来源：{candidatePayload?.source ?? "未加载"} · 不包含原始 API 响应</p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-stone-600" htmlFor="host-sort">
                    主机排序
                  </label>
                  <select
                    className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs"
                    id="host-sort"
                    onChange={(event) => setHostSortMode(event.target.value as HostSortMode)}
                    value={hostSortMode}
                  >
                    <option value="price-asc">价格从低到高</option>
                    <option value="price-desc">价格从高到低</option>
                    <option value="reliability-desc">可靠性从高到低</option>
                    <option value="rating-desc">评分从高到低</option>
                  </select>
                  <span className="w-full text-xs text-stone-500">最后刷新：{formatDateTime(candidatePayload?.last_refreshed_at)}</span>
                </div>
                <div className="mt-3 space-y-3">
                  {sortedCandidates.map((candidate) => (
                    <button
                      className={`w-full rounded-lg border p-3 text-left ${selectedCandidate?.server_id === candidate.server_id ? "border-emerald-500 bg-emerald-50" : "border-stone-200 bg-white"}`}
                      key={candidate.server_id}
                      onClick={() => setSelectedServerId(candidate.server_id)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold">server {candidate.server_id}</span>
                        <span className="rounded-md bg-stone-900 px-2 py-1 text-xs text-white">风险 {candidate.risk_tier}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-stone-700">
                        <span>{candidate.gpu}</span>
                        <span>{formatMoney(candidate.normalized_usd_per_hour)}/h</span>
                        <span>原价 {candidate.original_on_demand_price ?? "未知"}</span>
                        <span>6h {formatMoney(candidate.six_hour_cost_usd)}</span>
                        <span>API 显存 {formatNumber(candidate.gpu_memory_raw_value, candidate.gpu_memory_raw_unit ? ` ${candidate.gpu_memory_raw_unit}` : "")}</span>
                        <span>标称 32GB</span>
                        <span>RAM {formatNumber(candidate.ram_gb, "GB")}</span>
                        <span>CPU {formatNumber(candidate.cpu_cores, "核")}</span>
                        <span>磁盘 {formatNumber(candidate.disk_gb, "GB")}</span>
                        <span>{formatNumber(candidate.download_mbps, "↓")} / {formatNumber(candidate.upload_mbps, "↑")}</span>
                        <span>可靠性 {formatNumber(candidate.reliability)}</span>
                        <span>评分 {formatNumber(candidate.rating)} ({candidate.rating_count ?? 0})</span>
                      </div>
                      <p className="mt-2 text-xs text-stone-500">{candidate.gpu_memory_note}</p>
                    </button>
                  ))}
                </div>
                <button className="mt-3 text-xs font-semibold text-stone-600 underline" onClick={() => setShowRejected((value) => !value)} type="button">
                  {showRejected ? "隐藏被排除主机" : "查看被排除主机"}
                </button>
                {showRejected ? (
                  <div className="mt-2 space-y-2">
                    {(candidatePayload?.rejected5090 ?? candidatePayload?.closest_rejected_5090 ?? []).map((candidate) => (
                      <div className="rounded-md border border-stone-200 bg-white p-2 text-xs" key={candidate.server_id}>
                        <p className="font-semibold">server {candidate.server_id}</p>
                        <p className="mt-1 text-stone-500">{candidate.rejection_reasons?.join("；") || "未通过筛选"}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="rounded-lg border border-stone-200 bg-[#faf8f4] p-3">
                <h2 className="font-bold">当前选中主机</h2>
                <p className="mt-2">server {selectedCandidate?.server_id ?? "未选择"}</p>
                <p>钱包余额：{formatMoney(wallet?.available_usd_balance ?? candidatePayload?.wallet?.available_usd_balance)}</p>
                <p>保留 1 美元后可用：{formatMoney(Math.max(0, (wallet?.available_usd_balance ?? 0) - 1))}</p>
                <p>价格上限：{formatMoney(candidatePayload?.filters?.max_usd_per_hour)}</p>
                <p>可租状态：{selectedCandidate?.currently_rentable ? "可租" : "未知或不可租"}</p>
                <p>平台总价：{selectedCandidate?.platform_total_price_status ?? "API 未确认"}</p>
                {confirmMessage ? <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{confirmMessage}</p> : null}
                <button className="mt-3 w-full rounded-md bg-stone-900 px-3 py-2 font-bold text-white disabled:bg-stone-400" disabled={!selectedCandidate} onClick={() => void createPlan()} type="button">
                  启动GPU会话
                </button>
              </section>

              <section className="rounded-lg border border-stone-200 bg-[#faf8f4] p-3">
                <h2 className="font-bold">生成时间与任务状态</h2>
                <p className="mt-2">排队：{counts.queued} · 生成中：{counts.processing} · 已完成：{counts.succeeded} · 失败：{counts.failed}</p>
                <p className="mt-2 text-stone-600">预计剩余时间：尚未建立 Wan2.2 真实基准。完成第一批真实任务后再按移动平均估算。</p>
              </section>

              <section className="rounded-lg border border-stone-200 bg-[#faf8f4] p-3">
                <h2 className="font-bold">模型部署状态</h2>
                <p className="mt-2">当前：{session?.status ?? "idle"}</p>
                <p className="text-xs text-stone-500">更新时间：{formatDateTime(session?.lastUpdatedAt)}</p>
                <ol className="mt-3 space-y-1 text-xs text-stone-600">
                  {(session?.deploymentTimeline ?? []).map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </section>

              <section className="rounded-lg border border-stone-200 bg-[#faf8f4] p-3">
                <h2 className="font-bold">模型缓存状态</h2>
                <p className="mt-2">Runtime：{session?.runtimeImage?.customRuntimeConfigured ? "已配置" : "未发布"}</p>
                <p>镜像固定：{session?.runtimeImage?.digestPinned ? "digest" : "tag/默认"}</p>
                <p>R2 缓存：{session?.modelCache?.bucketConfigured ? "已配置" : "未配置"}</p>
                <p>模型前缀：{session?.modelCache?.prefix ?? "wan22-ti2v-5b"}</p>
                <p>模型：{session?.modelCache?.officialRepo ?? "Wan-AI/Wan2.2-TI2V-5B"}</p>
                <p>官方大小预算：{session?.modelCache?.expectedSizeGb ?? 34.2}GB</p>
                <p>Seed flow：{session?.modelCache?.seedFlowImplemented ? "presigned upload ready" : "not ready"}</p>
                <p>Seed status：{session?.modelCache?.seedStatus ?? "cache_seed_manifest_pending"}</p>
                <p>Upload mode：{session?.modelCache?.presignedUploadSupported ? "short-lived PUT" : "disabled"} / {session?.modelCache?.multipartUploadSupported ? "multipart" : "single"}</p>
                <p>GPU cache creds：{session?.modelCache?.readonlyCredentialFile ?? ".secrets/model-cache-readonly.env"}</p>
                <p>Admin creds on GPU：{session?.modelCache?.adminCredentialsOnGpu ? "blocked" : "no"}</p>
                <p>Current manifest：{session?.modelCache?.currentManifestKey ?? "wan22-ti2v-5b/current.json"}</p>
                <p className="mt-2 text-xs text-stone-500">R2 仅作为模型缓存；不会在网页返回 endpoint、Access Key、Secret 或预签名 URL。</p>
              </section>

              <section className="rounded-lg border border-stone-200 bg-[#faf8f4] p-3">
                <h2 className="font-bold">安全停止</h2>
                <button className="mt-3 w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-semibold" onClick={() => fetch("/api/local-lab/clore/session-stop", { method: "POST" }).then(() => refreshClore())} type="button">
                  安全清理并停止 GPU 会话
                </button>
                <p className="mt-2 text-xs text-stone-500">本轮停止流程仍为 dry-run，不会调用 cancel_order。</p>
              </section>
            </div>
          </div>
        </aside>
      </div>

      {deleteJob ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4">
          <section className="w-full max-w-lg rounded-lg bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold">删除该记录</h2>
                <p className="mt-1 text-sm text-stone-600">视频、封面、本地元数据、Supabase 对象和页面任务记录会被清理。</p>
              </div>
              <button className="rounded-md border border-stone-200 px-3 py-2" onClick={() => setDeleteJob(null)} type="button">
                关闭
              </button>
            </div>
            <div className="mt-4 overflow-hidden rounded-md border border-stone-200 bg-stone-100">
              {localResults.find((result) => result.jobId === deleteJob.id)?.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt="待删除视频封面"
                  className="aspect-video w-full object-cover"
                  src={localResults.find((result) => result.jobId === deleteJob.id)?.thumbnailUrl ?? ""}
                />
              ) : (
                <div className="flex aspect-video items-center justify-center text-sm text-stone-500">{videoJobStatusLabels[deleteJob.status]}</div>
              )}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <p>创建时间：{formatDateTime(deleteJob.created_at)}</p>
              <p>提示词：{safePromptPreview(deleteJob.prompt)}</p>
              {deleteMessage ? <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">{deleteMessage}</p> : null}
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button className="rounded-md border border-stone-200 px-4 py-2 font-semibold" disabled={deletingJobId === deleteJob.id} onClick={() => setDeleteJob(null)} type="button">
                取消
              </button>
              <button
                className="rounded-md bg-rose-700 px-4 py-2 font-bold text-white disabled:bg-stone-400"
                disabled={deletingJobId === deleteJob.id}
                onClick={() => void deleteHistoryJob()}
                type="button"
              >
                {deletingJobId === deleteJob.id ? "删除中..." : "确认删除"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}
