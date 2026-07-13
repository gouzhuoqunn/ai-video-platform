"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { requestSignedVideoUrl } from "@/lib/video-jobs/signed-url";
import { videoJobStatusLabels } from "@/types/video-config";
import type { SignedVideoResponse, VideoJob, VideoJobWithBalance, VideoJobStatus } from "@/types/video-jobs";

type JobCounts = Record<VideoJobStatus, number>;

type LocalJobsResponse = {
  jobs: VideoJob[];
  counts: Partial<JobCounts>;
  error?: string;
};

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
  filters?: { max_usd_per_hour: number };
  matches: CloreCandidateSummary[];
  rejected5090?: CloreCandidateSummary[];
  closest_rejected_5090?: CloreCandidateSummary[];
  error?: string;
};

type SessionResponse = {
  status: string;
  orderId: string | null;
  serverId: string | null;
  processingJobs: number;
  lastUpdatedAt: string;
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

const starterPrompt = "A clean text-only 5 second video title card, cinematic lighting, no people, no logos.";

function pickRpcJob(data: unknown): VideoJobWithBalance | null {
  if (Array.isArray(data)) return (data[0] as VideoJobWithBalance | undefined) ?? null;
  return (data as VideoJobWithBalance | null) ?? null;
}

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" ? `$${value.toFixed(3)}` : "未确认";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "尚未记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function safePromptPreview(prompt: string) {
  return prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
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
  if (job.status === "processing") {
    const remaining = Math.max(1, Math.round(fallbackMinutes * (1 - job.progress / 100)));
    return `生成中，约 ${remaining} 分钟`;
  }
  if (job.status === "queued") {
    const queue = queueOrder(jobs);
    const ahead = Math.max(0, queue.findIndex((item) => item.id === job.id));
    return `前方还有 ${ahead} 个任务，约 ${Math.max(1, (ahead + 1) * fallbackMinutes)} 分钟`;
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
  const [counts, setCounts] = useState<Partial<JobCounts>>({});
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [signedVideos, setSignedVideos] = useState<Record<string, SignedVideoResponse>>({});
  const [localResults, setLocalResults] = useState<LocalResult[]>([]);
  const [candidates, setCandidates] = useState<CloreCandidateSummary[]>([]);
  const [candidateSource, setCandidateSource] = useState("");
  const [selectedServer, setSelectedServer] = useState<CloreCandidateSummary | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [autorentRequests, setAutorentRequests] = useState<AutorentRequest[]>([]);
  const [notice, setNotice] = useState("正在恢复本地实验会话...");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isBatching, setIsBatching] = useState(false);
  const [pendingGpuChoice, setPendingGpuChoice] = useState<{ action: "confirm" | "urgent"; jobIds: string[] } | null>(null);
  const [filter, setFilter] = useState<"all" | VideoJobStatus>("all");
  const [minPrice, setMinPrice] = useState("0");
  const [maxPrice, setMaxPrice] = useState("0.70");

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const localResultForSelected = selectedJob ? localResults.find((result) => result.jobId === selectedJob.id) : null;
  const mainVideoUrl = localResultForSelected?.videoUrl ?? (selectedJob ? signedVideos[selectedJob.id]?.signedUrl : null);
  const visibleJobs = filter === "all" ? jobs : jobs.filter((job) => job.status === filter);
  const pendingJobs = visibleJobs.filter((job) => job.status === "pending_confirmation");
  const selectedPendingCount = selectedJobIds.filter((id) => jobs.find((job) => job.id === id)?.status === "pending_confirmation").length;
  const activeAutorent = autorentRequests.find((request) => !["assigned", "failed", "cancelled"].includes(request.status));

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

  const refreshJobs = useCallback(async () => {
    const response = await fetch("/api/local-lab/jobs");
    const payload = (await response.json().catch(() => ({}))) as LocalJobsResponse;
    if (!response.ok) {
      setNotice(payload.error ?? "无法读取本地任务。");
      return;
    }
    setJobs(payload.jobs);
    setCounts(payload.counts);
    setSelectedJobId((current) => current || payload.jobs[0]?.id || "");
    setSelectedJobIds((current) => current.filter((id) => payload.jobs.some((job) => job.id === id)));
  }, []);

  const refreshResults = useCallback(async () => {
    const response = await fetch("/api/local-lab/results");
    const payload = (await response.json().catch(() => ({}))) as { results?: LocalResult[] };
    if (response.ok) setLocalResults(payload.results ?? []);
  }, []);

  const refreshClore = useCallback(async () => {
    const [candidateResponse, sessionResponse, autorentResponse] = await Promise.all([
      fetch("/api/local-lab/clore/candidates"),
      fetch("/api/local-lab/clore/session"),
      fetch("/api/local-lab/clore/autorent"),
    ]);
    const candidatePayload = (await candidateResponse.json().catch(() => ({}))) as CloreCandidatesResponse;
    const sessionPayload = (await sessionResponse.json().catch(() => ({}))) as SessionResponse;
    const autorentPayload = (await autorentResponse.json().catch(() => ({}))) as { requests?: AutorentRequest[] };

    if (candidateResponse.ok) {
      setCandidates(candidatePayload.matches ?? []);
      setCandidateSource(candidatePayload.source ?? "");
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
      setNotice("Clore真实自动租用保持关闭；可以先用未生成任务和mock寻机流程。");
      await Promise.all([refreshJobs(), refreshResults(), refreshClore()]);
    }
    void restore();
    return () => {
      mounted = false;
    };
  }, [refreshClore, refreshJobs, refreshResults, supabase]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshJobs();
      void refreshResults();
      void refreshClore();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refreshClore, refreshJobs, refreshResults]);

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
      const { data, error } = await supabase.rpc("create_video_job", { p_prompt: trimmedPrompt, p_model_key: "standard-video" });
      if (error) {
        setNotice(error.message.split("\n")[0] || "创建未生成任务失败。");
        return;
      }
      const createdJob = pickRpcJob(data);
      if (createdJob) setSelectedJobId(createdJob.id);
      setPrompt("");
      setNotice("已扣除积分并创建未生成任务。确认或加急后才会进入队列。");
      await refreshJobs();
    } finally {
      setIsSubmitting(false);
    }
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
      setNotice("请先保存合法的 GPU 单价范围，Max 不得超过 $0.70/h。");
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
      const payload = (await response.json().catch(() => ({}))) as { error?: string; autorent_request?: AutorentRequest; regenerated?: VideoJob[] };
      if (!response.ok) {
        setNotice(payload.error ?? "批量操作失败。");
        await refreshJobs();
        return;
      }
      setSelectedJobIds([]);
      if (payload.regenerated?.[0]) setSelectedJobId(payload.regenerated[0].id);
      const labels = { confirm: "确认生成", urgent: "加急生成", delete: "删除", regenerate: "重新生成" };
      const gpuModeNote = gpuMode === "current" ? "已加入当前GPU队列，不创建新的自动寻机请求。" : "真实Clore自动租用暂时停用，mock寻机状态会继续推进。";
      setNotice(`${labels[action]}已提交。${gpuModeNote}`);
      await Promise.all([refreshJobs(), refreshClore()]);
    } finally {
      setIsBatching(false);
    }
  }

  async function tickAutorent() {
    const response = await fetch("/api/local-lab/clore/autorent", { method: "POST" });
    const payload = (await response.json().catch(() => ({}))) as { note?: string; error?: string };
    setNotice(payload.note ?? payload.error ?? "mock自动寻机已推进。");
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
    <main className="min-h-screen bg-[#f6f3ee] text-stone-950">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-[#f6f3ee]/95 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-emerald-700">local_lab</p>
            <h1 className="text-2xl font-bold">本地创作台</h1>
          </div>
          <div className="text-sm text-stone-600">积分 ∞ · Clore真实自动租用关闭 · active GPU {session?.orderId ? "存在" : "无"}</div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-5">
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <div className="overflow-hidden rounded-lg border border-stone-200 bg-black">
              <div className="aspect-video">
                {selectedJob?.status === "succeeded" && mainVideoUrl ? (
                  <video className="h-full w-full" controls src={mainVideoUrl} />
                ) : (
                  <div className="flex h-full flex-col justify-center p-8 text-white">
                    <p className="text-sm uppercase text-white/60">{selectedJob ? videoJobStatusLabels[selectedJob.status] : "未选择"}</p>
                    <h2 className="mt-3 text-2xl font-bold">{selectedJob ? generationLabel(selectedJob) : "暂无任务"}</h2>
                    <p className="mt-3 max-w-2xl text-white/75">
                      {selectedJob?.status === "pending_confirmation"
                        ? "尚未确认生成"
                        : selectedJob?.status === "queued"
                          ? etaText(selectedJob, jobs)
                          : selectedJob?.status === "processing"
                            ? `生成中 ${selectedJob.progress}% · ${etaText(selectedJob, jobs)}`
                            : selectedJob?.error_message ?? "点击任务卡片可在这里查看状态或播放视频。"}
                    </p>
                    {activeAutorent ? <p className="mt-4 text-sm text-emerald-200">自动寻机：{activeAutorent.status}</p> : null}
                  </div>
                )}
              </div>
            </div>

            <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
              <h2 className="text-lg font-bold">新提示词</h2>
              <textarea
                className="mt-3 min-h-36 w-full resize-y rounded-md border border-stone-200 p-3 text-sm outline-none focus:border-stone-500"
                maxLength={2000}
                onChange={(event) => setPrompt(event.target.value)}
                value={prompt}
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-stone-500">{prompt.trim().length}/2000</span>
                <button className="rounded-md bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={!user || isSubmitting} onClick={() => void submitPrompt()} type="button">
                  {isSubmitting ? "创建中..." : "创建未生成任务"}
                </button>
              </div>
              {notice ? <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p> : null}
            </section>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">任务</h2>
                <p className="text-sm text-stone-500">未生成 {counts.pending_confirmation ?? 0} · 排队 {counts.queued ?? 0} · 生成中 {counts.processing ?? 0} · 完成 {counts.succeeded ?? 0}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                {(["all", "pending_confirmation", "queued", "processing", "succeeded", "failed"] as const).map((status) => (
                  <button className={`rounded-md border px-3 py-1.5 ${filter === status ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white"}`} key={status} onClick={() => setFilter(status)} type="button">
                    {status === "all" ? "全部" : videoJobStatusLabels[status]}
                  </button>
                ))}
              </div>
            </div>

            {selectedJobIds.length > 0 ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-stone-200 bg-[#faf8f4] p-3">
                <span className="text-sm font-semibold">已选 {selectedJobIds.length}</span>
                <button className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => requestBatch("urgent")} type="button">
                  加急生成
                </button>
                <button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => requestBatch("confirm")} type="button">
                  确认生成
                </button>
                <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:bg-stone-100" disabled={isBatching} onClick={() => requestBatch("regenerate")} type="button">
                  重新生成
                </button>
                <button className="rounded-md bg-rose-700 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400" disabled={isBatching} onClick={() => requestBatch("delete")} type="button">
                  删除
                </button>
              </div>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <input checked={pendingJobs.length > 0 && pendingJobs.length === selectedPendingCount} className="h-4 w-4" onChange={selectAllPending} type="checkbox" />
              <button className="text-sm font-semibold text-stone-700" onClick={selectAllPending} type="button">
                全选未生成任务
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleJobs.map((job) => {
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

        <aside className="space-y-4">
          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">GPU 价格筛选</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-sm">
                Min USD/h
                <input className="mt-1 w-full rounded-md border border-stone-200 px-2 py-2" onChange={(event) => setMinPrice(event.target.value)} value={minPrice} />
              </label>
              <label className="text-sm">
                Max USD/h
                <input className="mt-1 w-full rounded-md border border-stone-200 px-2 py-2" onChange={(event) => setMaxPrice(event.target.value)} value={maxPrice} />
              </label>
            </div>
            <p className={`mt-2 text-xs ${priceGate.valid ? "text-emerald-700" : "text-rose-700"}`}>
              {priceGate.valid ? "价格范围有效，按含5%租客费小时价过滤。" : "非法输入不会保存或触发寻机，Max 不得超过 $0.70/h。"}
            </p>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">RTX 5090 候选</h2>
              <button className="rounded-md border border-stone-200 px-2 py-1 text-xs" onClick={() => void refreshClore()} type="button">
                刷新
              </button>
            </div>
            <p className="mt-1 text-xs text-stone-500">{candidateSource || "未加载"} · 真实自动租用暂时停用</p>
            <div className="mt-3 space-y-2">
              {filteredCandidates.slice(0, 8).map((candidate) => (
                <button
                  className={`w-full rounded-md border px-3 py-3 text-left ${selectedServer?.server_id === candidate.server_id ? "border-emerald-600 bg-emerald-50" : "border-stone-200 bg-[#faf8f4]"}`}
                  key={candidate.server_id}
                  onClick={() => setSelectedServer(candidate)}
                  onDoubleClick={() => setSelectedServer(candidate)}
                  title="双击查看详细信息"
                  type="button"
                >
                  <span className="text-lg font-bold">{formatMoney(candidate.effective_usd_per_hour ?? (candidate.normalized_usd_per_hour ? candidate.normalized_usd_per_hour * 1.05 : null))}/小时</span>
                </button>
              ))}
              {filteredCandidates.length === 0 ? <p className="text-sm text-stone-500">当前价格范围内没有候选。</p> : null}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">自动寻机</h2>
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">GPU自动租用暂时停用，等待Clore平台恢复。</p>
            <button className="mt-3 w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-semibold" onClick={() => void tickAutorent()} type="button">
              推进mock寻机tick
            </button>
            <div className="mt-3 space-y-2 text-sm">
              {autorentRequests.slice(0, 5).map((request) => (
                <div className="rounded-md border border-stone-200 bg-[#faf8f4] p-2" key={request.id}>
                  <p className="font-semibold">{request.status} · {request.priority}</p>
                  <p className="text-xs text-stone-500">Max {formatMoney(Number(request.max_effective_hourly_usd))}/h · {request.selected_server_id ?? "未选主机"}</p>
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
            <p className="mt-2 text-sm text-stone-600">
              同时最多只能有一台GPU。请选择这批任务进入当前GPU队列，或等当前GPU退订后再自动寻找最低价GPU。
            </p>
            <div className="mt-4 grid gap-2">
              <button
                className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white disabled:bg-stone-400"
                disabled={isBatching}
                onClick={() => void runBatch(pendingGpuChoice.action, "current", pendingGpuChoice.jobIds)}
                type="button"
              >
                使用当前GPU并加入{pendingGpuChoice.action === "urgent" ? "加急" : "普通"}队列
              </button>
              <button
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:bg-stone-100"
                disabled={isBatching}
                onClick={() => void runBatch(pendingGpuChoice.action, "wait_for_current_to_close", pendingGpuChoice.jobIds)}
                type="button"
              >
                等当前GPU退订后，再自动寻找最低价GPU
              </button>
              <button className="rounded-md border border-stone-200 px-3 py-2 text-sm font-semibold" onClick={() => setPendingGpuChoice(null)} type="button">
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {selectedServer ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4" onClick={() => setSelectedServer(null)}>
          <section className="w-full max-w-lg rounded-lg bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold">主机详情</h2>
                <p className="text-sm text-stone-500">Server {selectedServer.server_id}</p>
              </div>
              <button className="rounded-md border border-stone-200 px-3 py-2" onClick={() => setSelectedServer(null)} type="button">
                关闭
              </button>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-stone-500">GPU</dt><dd>{selectedServer.gpu} x {selectedServer.gpu_count ?? 1}</dd></div>
              <div><dt className="text-stone-500">显存</dt><dd>{selectedServer.gpu_memory_raw_value ?? selectedServer.gpu_memory_gb} {selectedServer.gpu_memory_raw_unit ?? "GB"}</dd></div>
              <div><dt className="text-stone-500">RAM</dt><dd>{selectedServer.ram_gb ?? "未知"} GB</dd></div>
              <div><dt className="text-stone-500">磁盘</dt><dd>{selectedServer.disk_gb ?? "未知"} GB</dd></div>
              <div><dt className="text-stone-500">网络</dt><dd>{selectedServer.download_mbps ?? "?"}/{selectedServer.upload_mbps ?? "?"} Mbps</dd></div>
              <div><dt className="text-stone-500">地区</dt><dd>{selectedServer.country ?? "未知"}</dd></div>
              <div><dt className="text-stone-500">可靠性</dt><dd>{selectedServer.reliability ?? "未知"}</dd></div>
              <div><dt className="text-stone-500">基础价</dt><dd>{formatMoney(selectedServer.base_usd_per_hour ?? selectedServer.normalized_usd_per_hour)}/h</dd></div>
              <div><dt className="text-stone-500">含费价</dt><dd>{formatMoney(selectedServer.effective_usd_per_hour)}/h</dd></div>
              <div><dt className="text-stone-500">预计总价</dt><dd>{formatMoney(selectedServer.max_session_projected_total_usd)}</dd></div>
            </dl>
          </section>
        </div>
      ) : null}
    </main>
  );
}
