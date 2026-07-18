"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FirstFrameInput } from "@/components/FirstFrameInput";

type ImageResult = { sessionId: string; date: string; imageUrl: string };
type Segment = {
  id: string;
  sequenceIndex: number;
  startSecond: number;
  endSecond: number;
  prompt: string;
  status: string;
  selectedAttemptId: string | null;
  approvalState: string;
  approvalDeadline: string | null;
  attemptsCount: number;
  attempts: Array<{ id: string; number: number; status: string }>;
  version: number;
};
type Project = {
  id: string;
  title: string;
  overallPrompt: string;
  firstFrameSource: "upload" | "existing_image" | "pure_prompt";
  firstFrameRef: string | null;
  targetDurationSeconds: number;
  totalSegments: number;
  status: string;
  nextSegmentIndex: number;
  gpuPreference: string[];
  estimate: { segmentCount: number; likelySessions: { min: number; max: number }; totalMinutes: { min: number; max: number }; projectedComputeUsd: { min: number; max: number }; creationFeeCaveat: string };
  finalVideoRef: string | null;
  finalThumbnailRef: string | null;
  mergeStatus: string;
  cleanupStatus: string;
  segmentMediaCleaned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  segments: Segment[];
};

type Props = { imageResults: ImageResult[] };
const LONG_VIDEO_DRAFT_KEY = "ai-video-platform:long-video-draft:v1";
type DraftSegment = { sequenceIndex: number; startSecond: number; endSecond: number; prompt: string };

const statusLabels: Record<string, string> = {
  pending_confirmation: "待确认",
  waiting_for_gpu: "等待显卡",
  generating: "生成中",
  awaiting_review: "等待审核",
  paused: "已暂停",
  awaiting_merge_confirmation: "等待确认合并",
  merging: "正在合并",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
  pending: "待处理",
  ready: "准备好",
  accepted: "已接受",
  invalidated: "已失效",
};

function segmentLabel(segment: Pick<Segment, "startSecond" | "endSecond">) {
  return `${segment.startSecond + 1}～${segment.endSecond}秒`;
}

function publicMediaUrl(projectId: string, kind: string, segment?: Segment) {
  const query = segment ? `?sequence=${segment.sequenceIndex}${segment.selectedAttemptId ? `&attempt=${segment.selectedAttemptId}` : ""}` : "";
  return `/api/local-lab/long-video/${projectId}/media/${kind}${query}`;
}

export function LongVideoStudio({ imageResults }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detailId, setDetailId] = useState("");
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [title, setTitle] = useState("我的长视频");
  const [overallPrompt, setOverallPrompt] = useState("");
  const [duration, setDuration] = useState(15);
  const [prompts, setPrompts] = useState<string[]>(Array(3).fill(""));
  const [promptArchive, setPromptArchive] = useState<Record<number, string>>({});
  const [focusedDraftIndex, setFocusedDraftIndex] = useState(0);
  const [firstFrameSource, setFirstFrameSource] = useState<Project["firstFrameSource"]>("existing_image");
  const [existingImageId, setExistingImageId] = useState("");
  const [uploadRef, setUploadRef] = useState("");
  const [gpu, setGpu] = useState<"auto" | "rtx4090" | "rtx5090">("auto");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptKey = useRef("");
  const promptDirty = useRef(false);
  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;
  const detailProject = projects.find((project) => project.id === detailId) ?? selectedProject;
  const currentSegment = detailProject?.segments[segmentIndex] ?? null;
  const completedCount = detailProject?.segments.filter((segment) => segment.status === "accepted").length ?? 0;
  const reviewSeconds = currentSegment?.approvalDeadline ? Math.max(0, Math.ceil((Date.parse(currentSegment.approvalDeadline) - now) / 1000)) : 0;
  const draftSegments = useMemo<DraftSegment[]>(() => Array.from({ length: duration / 5 }, (_, sequenceIndex) => ({ sequenceIndex, startSecond: sequenceIndex * 5, endSecond: Math.min((sequenceIndex + 1) * 5, duration), prompt: promptArchive[sequenceIndex] ?? prompts[sequenceIndex] ?? "" })), [duration, promptArchive, prompts]);
  const filledDraftCount = draftSegments.filter((segment) => segment.prompt.trim()).length;
  const firstFrameReady = firstFrameSource === "pure_prompt" || (firstFrameSource === "upload" ? Boolean(uploadRef) : Boolean(existingImageId));
  const canCreate = !busy && Boolean(title.trim()) && firstFrameReady && filledDraftCount === draftSegments.length;

  const refresh = useCallback(async () => {
    const response = await fetch("/api/local-lab/long-video");
    const payload = await response.json().catch(() => ({})) as { projects?: Project[] };
    if (!response.ok) return;
    setProjects(payload.projects ?? []);
    setSelectedId((current) => current || payload.projects?.[0]?.id || "");
    setDetailId((current) => current || payload.projects?.[0]?.id || "");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!detailProject || !currentSegment) return;
    const key = `${detailProject.id}:${currentSegment.sequenceIndex}`;
    if (promptKey.current === key && promptDirty.current) return;
    promptKey.current = key;
    promptDirty.current = false;
  }, [currentSegment, detailProject]);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(LONG_VIDEO_DRAFT_KEY) ?? "null") as { title?: string; overallPrompt?: string; duration?: number; prompts?: string[] } | null;
      if (!saved) return;
      if (saved.title) setTitle(saved.title);
      if (typeof saved.overallPrompt === "string") setOverallPrompt(saved.overallPrompt);
      if (typeof saved.duration === "number" && saved.duration >= 5 && saved.duration <= 300 && saved.duration % 5 === 0) setDuration(saved.duration);
      if (Array.isArray(saved.prompts)) { setPrompts(saved.prompts); setPromptArchive(Object.fromEntries(saved.prompts.map((prompt, index) => [index, prompt]))); }
    } catch { /* ignore malformed local draft */ }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LONG_VIDEO_DRAFT_KEY, JSON.stringify({ title, overallPrompt, duration, prompts: draftSegments.map((segment) => segment.prompt) }));
  }, [title, overallPrompt, duration, draftSegments]);

  async function createProject() {
    if (busy) return;
    if (!canCreate) {
      setNotice("请先选择首帧并填写全部分段提示词。");
      return;
    }
    if (filledDraftCount !== draftSegments.length) {
      setNotice(`请填写全部分段提示词（已填写 ${filledDraftCount}/${draftSegments.length} 段）。`);
      return;
    }
    const firstFrameRef = firstFrameSource === "upload" ? uploadRef : firstFrameSource === "existing_image" ? `image:${existingImageId}` : null;
    if (firstFrameSource !== "pure_prompt" && !firstFrameRef) {
      setNotice("请先选择或上传首帧图片。");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/local-lab/long-video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", title, overallPrompt, firstFrameSource, firstFrameRef, targetDurationSeconds: duration, segments: draftSegments, gpuPreference: gpu === "auto" ? ["rtx4090", "rtx5090"] : [gpu] }) });
      const payload = await response.json().catch(() => ({})) as { project?: Project; error?: string };
      if (!response.ok || !payload.project) { setNotice(payload.error ?? "无法创建长视频项目。"); return; }
      setProjects((current) => [payload.project!, ...current.filter((project) => project.id !== payload.project!.id)]);
      setSelectedId(payload.project.id);
      setDetailId(payload.project.id);
      setSegmentIndex(0);
      window.localStorage.removeItem(LONG_VIDEO_DRAFT_KEY);
      setNotice("项目已保存为待确认；不会创建 GPU 订单或扣积分。");
    } finally { setBusy(false); }
  }

  function changeDuration(nextDuration: number) {
    setPromptArchive((current) => ({ ...current, ...Object.fromEntries(prompts.map((prompt, index) => [index, prompt])) }));
    setDuration(nextDuration);
    const nextCount = nextDuration / 5;
    setPrompts((current) => Array.from({ length: nextCount }, (_, index) => promptArchive[index] ?? current[index] ?? ""));
    setSegmentIndex((current) => Math.min(current, nextCount - 1));
    setFocusedDraftIndex((current) => Math.min(current, nextCount - 1));
  }

  function changeDraftPrompt(index: number, value: string) {
    setPromptArchive((current) => ({ ...current, [index]: value }));
    setPrompts((current) => current.map((prompt, candidate) => candidate === index ? value : prompt));
  }

  function fillEmptyDraftPrompts() {
    if (!overallPrompt.trim()) { setNotice("整体提示词为空，请逐段填写，或先补充整体提示词。"); return; }
    draftSegments.forEach((segment) => { if (!segment.prompt.trim()) changeDraftPrompt(segment.sequenceIndex, overallPrompt); });
  }

  async function uploadFirstFrame(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/local-lab/long-video/uploads", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({})) as { ref?: string; url?: string; error?: string };
      if (!response.ok || !payload.ref) { setNotice(payload.error ?? "首帧上传失败。"); return; }
      setUploadRef(payload.ref);
      setFirstFrameSource("upload");
      setNotice("首帧已安全保存，可用于创建项目。");
    } finally { setBusy(false); }
  }

  async function patchProject(action: string, segment?: Segment, extra: Record<string, unknown> = {}) {
    if (!detailProject || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/local-lab/long-video/${detailProject.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, expectedProjectVersion: detailProject.version, expectedSegmentVersion: segment?.version, sequenceIndex: segment?.sequenceIndex, ...extra }) });
      const payload = await response.json().catch(() => ({})) as { project?: Project; error?: string };
      if (!response.ok || !payload.project) { setNotice(payload.error ?? "项目状态已改变，请刷新后重试。"); await refresh(); return; }
      setProjects((current) => current.map((project) => project.id === payload.project!.id ? payload.project! : project));
      setNotice(action === "accept" ? "本段已确认，下一段仍需审核或等待 20 秒自动继续。" : action === "regenerate" ? "已保留旧尝试，并阻断所有下游分段。" : action === "pause" ? "项目已暂停，状态和已完成媒体已保存。" : action === "resume" ? "项目已恢复，将从第一段未完成分段继续。" : "项目状态已更新。");
    } finally { setBusy(false); }
  }

  async function savePrompt(project: Project, segment: Segment, value: string) {
    if (value === segment.prompt) return;
    const response = await fetch(`/api/local-lab/long-video/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update_prompt", expectedProjectVersion: project.version, expectedSegmentVersion: segment.version, sequenceIndex: segment.sequenceIndex, prompt: value }) });
    const payload = await response.json().catch(() => ({})) as { project?: Project; error?: string };
    if (response.ok && payload.project) setProjects((current) => current.map((item) => item.id === project.id ? payload.project! : item));
    else setNotice(payload.error ?? "提示词保存失败，请刷新后重试。");
  }

  function changeSegmentPrompt(value: string) {
    if (!detailProject || !currentSegment) return;
    promptDirty.current = true;
    const project = detailProject;
    const segment = currentSegment;
    if (promptTimer.current) clearTimeout(promptTimer.current);
    promptTimer.current = setTimeout(() => { promptDirty.current = false; void savePrompt(project, segment, value); }, 450);
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, segments: item.segments.map((candidate) => candidate.id === segment.id ? { ...candidate, prompt: value } : candidate) } : item));
  }

  async function mergeProject() {
    if (!detailProject || busy || !window.confirm("确认合并长视频？合并前会验证每一段的媒体、分辨率和帧率。")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/local-lab/long-video/${detailProject.id}/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedProjectVersion: detailProject.version }) });
      const payload = await response.json().catch(() => ({})) as { project?: Project; error?: string };
      if (!response.ok || !payload.project) { setNotice(payload.error ?? "合并失败，已保留分段媒体。"); return; }
      setProjects((current) => current.map((project) => project.id === payload.project!.id ? payload.project! : project));
      setNotice("长视频已合并并验证；分段媒体仅在最终文件有效后清理。");
    } finally { setBusy(false); }
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`确认删除“${project.title}”？已完成媒体也会被安全删除。`)) return;
    const response = await fetch(`/api/local-lab/long-video/${project.id}?version=${project.version}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setNotice(payload.error ?? "删除失败，媒体仍会保留以便重试。"); return; }
    setProjects((current) => current.filter((item) => item.id !== project.id));
    setSelectedId("");
    setDetailId("");
    setNotice("长视频项目和本项目任务已删除；未触碰其他任务。");
  }

  const cover = useMemo(() => {
    if (!selectedProject) return null;
    if (selectedProject.status === "completed") return publicMediaUrl(selectedProject.id, "thumbnail");
    const segment = selectedProject.segments.find((candidate) => ["awaiting_review", "accepted"].includes(candidate.status) && candidate.selectedAttemptId);
    return segment ? publicMediaUrl(selectedProject.id, "segment-thumbnail", segment) : null;
  }, [selectedProject]);

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-lg font-bold">长视频工作室</h2><p className="text-sm text-stone-500">独立于普通视频表单；每 5 秒一个分段，首帧和审核状态都会持久化。</p></div>
          <span className="rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{"长视频将分段生成，可能跨多次显卡会话续作。"}</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[180px_220px_minmax(0,1fr)_220px]">
          <label className="text-sm font-semibold">项目标题<input className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2" maxLength={120} onChange={(event) => setTitle(event.target.value)} value={title} /></label>
          <label className="text-sm font-semibold">总时长
            <select className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2" onChange={(event) => changeDuration(Number(event.target.value))} value={duration}>{Array.from({ length: 60 }, (_, index) => (index + 1) * 5).map((value) => <option key={value} value={value}>{value} 秒 · {value / 5} 段</option>)}</select>
          </label>
          <label className="text-sm font-semibold">整体提示词<textarea className="mt-1 min-h-24 w-full rounded-md border border-stone-200 bg-[#faf8f4] p-3" maxLength={2000} onChange={(event) => setOverallPrompt(event.target.value)} value={overallPrompt} /></label>
          <div className="md:col-span-3 rounded-md border border-stone-200 bg-[#faf8f4] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">分段提示词</h3><p className="text-xs text-stone-500">已填写 {filledDraftCount}/{draftSegments.length} 段；整体提示词只是共享上下文。</p></div><button className="rounded border border-stone-300 bg-white px-2 py-1 text-xs" onClick={fillEmptyDraftPrompts} type="button">填充空白段</button></div>
            {draftSegments.length <= 6 ? <div className="mt-3 grid gap-2 md:grid-cols-2">{draftSegments.map((segment) => <label className="text-sm font-semibold" key={segment.sequenceIndex}>{segment.startSecond + 1}～{segment.endSecond}秒<textarea className="mt-1 min-h-20 w-full rounded-md border border-stone-200 bg-white p-2 font-normal" maxLength={2000} onChange={(event) => changeDraftPrompt(segment.sequenceIndex, event.target.value)} value={segment.prompt} /></label>)}</div> : <div className="mt-3"><div className="flex items-center justify-between gap-2"><button className="rounded border border-stone-300 bg-white px-2 py-1 text-xs" disabled={focusedDraftIndex === 0} onClick={() => setFocusedDraftIndex((current) => current - 1)} type="button">上一段</button><span className="text-xs text-stone-500">第 {focusedDraftIndex + 1}/{draftSegments.length} 段</span><button className="rounded border border-stone-300 bg-white px-2 py-1 text-xs" disabled={focusedDraftIndex === draftSegments.length - 1} onClick={() => setFocusedDraftIndex((current) => current + 1)} type="button">下一段</button></div><label className="mt-2 block text-sm font-semibold">{draftSegments[focusedDraftIndex].startSecond + 1}～{draftSegments[focusedDraftIndex].endSecond}秒<textarea className="mt-1 min-h-24 w-full rounded-md border border-stone-200 bg-white p-2 font-normal" maxLength={2000} onChange={(event) => changeDraftPrompt(focusedDraftIndex, event.target.value)} value={draftSegments[focusedDraftIndex].prompt} /></label></div>}
          </div>
          <div className="space-y-2 text-sm"><label className="font-semibold">首帧来源<select className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2" onChange={(event) => setFirstFrameSource(event.target.value as Project["firstFrameSource"])} value={firstFrameSource}><option value="upload">上传首帧图片</option><option value="existing_image">选择已验证图片</option><option value="pure_prompt">纯提示词生成首帧</option></select></label>
            {firstFrameSource !== "pure_prompt" ? <FirstFrameInput existingImages={imageResults} selectedExistingId={firstFrameSource === "existing_image" ? existingImageId : ""} onSelectExisting={(id) => { setExistingImageId(id); setUploadRef(""); setFirstFrameSource("existing_image"); }} onFile={uploadFirstFrame} onRemove={() => { setUploadRef(""); }} disabled={busy} /> : null}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><label className="text-sm font-semibold">GPU<select className="ml-2 rounded-md border border-stone-200 bg-white px-3 py-2" onChange={(event) => setGpu(event.target.value as typeof gpu)} value={gpu}><option value="auto">自动选择</option><option value="rtx4090">RTX 4090</option><option value="rtx5090">RTX 5090</option></select></label><button className="rounded-md bg-stone-900 px-4 py-3 text-sm font-bold text-white disabled:bg-stone-400" disabled={!canCreate} onClick={() => void createProject()} type="button">{busy ? "处理中..." : "创建长视频项目"}</button></div>
      </section>

      {notice ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p> : null}

      <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">长视频项目</h2><p className="text-sm text-stone-500">已完成分段 {completedCount}/{detailProject?.totalSegments ?? 0} · 无 GPU 订单时仅保存任务状态。</p></div><span className="text-xs text-stone-500">{projects.length} 个项目</span></div>
        {projects.length === 0 ? <p className="mt-4 rounded-md bg-[#faf8f4] px-3 py-4 text-sm text-stone-500">还没有长视频项目。</p> : <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{projects.map((project) => <article className={`rounded-lg border p-3 ${selectedId === project.id ? "border-stone-900 bg-[#faf8f4]" : "border-stone-200"}`} key={project.id}><button className="w-full text-left" onClick={() => { setSelectedId(project.id); setDetailId(project.id); setSegmentIndex(Math.min(project.nextSegmentIndex, project.totalSegments - 1)); }} type="button"><div className="aspect-video overflow-hidden rounded-md bg-stone-100">{project.status === "completed" ? <video className="h-full w-full object-cover" muted playsInline src={publicMediaUrl(project.id, "video")} /> : cover && selectedId === project.id ? <img alt="长视频封面" className="h-full w-full object-cover" src={cover} /> : <div className="flex h-full items-center justify-center text-sm text-stone-500">待生成分段</div>}</div><div className="mt-3 flex items-center justify-between gap-2"><p className="font-semibold">{project.title}</p><span className="rounded border border-stone-200 px-2 py-1 text-xs">{statusLabels[project.status] ?? project.status}</span></div><p className="mt-1 text-xs text-stone-500">{project.targetDurationSeconds}秒 · {project.segments.filter((segment) => segment.status === "accepted").length}/{project.totalSegments}段 · 会话 {project.estimate.likelySessions.min}–{project.estimate.likelySessions.max}</p></button><div className="mt-3 flex flex-wrap gap-2"><button className="rounded border border-stone-300 px-2 py-1 text-xs" onClick={() => { setDetailId(project.id); setSegmentIndex(Math.min(project.nextSegmentIndex, project.totalSegments - 1)); }} type="button">查看详情</button>{project.status === "paused" ? <button className="rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-700" onClick={() => { setDetailId(project.id); void patchProject("resume"); }} type="button">继续</button> : null}<button className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700" onClick={() => void deleteProject(project)} type="button">删除</button></div></article>)}</div>}
      </section>

      {detailProject ? <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-bold">{detailProject.title}</h2><p className="text-sm text-stone-500">{statusLabels[detailProject.status] ?? detailProject.status} · 预计 {detailProject.estimate.totalMinutes.min}–{detailProject.estimate.totalMinutes.max} 分钟 · 约 ${detailProject.estimate.projectedComputeUsd.min.toFixed(2)}–${detailProject.estimate.projectedComputeUsd.max.toFixed(2)}</p></div><div className="flex flex-wrap gap-2">{["pending_confirmation", "paused"].includes(detailProject.status) ? <button className="rounded-md bg-stone-900 px-3 py-2 text-sm font-bold text-white" onClick={() => void patchProject(detailProject.status === "paused" ? "resume" : "confirm")} type="button">{detailProject.status === "paused" ? "继续长视频" : "确认生成"}</button> : null}{detailProject.status === "awaiting_merge_confirmation" ? <button className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-bold text-white" onClick={() => void mergeProject()} type="button">确认合并长视频</button> : null}{!["completed", "cancelled", "paused"].includes(detailProject.status) ? <button className="rounded-md border border-stone-300 px-3 py-2 text-sm" onClick={() => void patchProject("pause", currentSegment ?? undefined)} type="button">暂停长视频</button> : null}<button className="rounded-md border border-rose-200 px-3 py-2 text-sm text-rose-700" onClick={() => void deleteProject(detailProject)} type="button">删除项目</button></div></div>
        {detailProject.status === "completed" ? <div className="mt-4 overflow-hidden rounded-md bg-black"><video className="max-h-[520px] w-full" controls playsInline poster={publicMediaUrl(detailProject.id, "thumbnail")} src={publicMediaUrl(detailProject.id, "video")} /></div> : null}
        <div className="mt-4 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]"><div className="max-h-[440px] space-y-2 overflow-y-auto pr-1">{detailProject.segments.map((segment) => <button className={`w-full rounded-md border px-3 py-2 text-left text-sm ${segment.sequenceIndex === segmentIndex ? "border-stone-900 bg-[#faf8f4]" : "border-stone-200"}`} key={segment.id} onClick={() => setSegmentIndex(segment.sequenceIndex)} type="button"><div className="flex items-center justify-between gap-2"><span className="font-semibold">{segmentLabel(segment)}</span><span className="text-xs text-stone-500">{statusLabels[segment.status] ?? segment.status}</span></div><p className="mt-1 line-clamp-2 text-xs text-stone-500">{segment.prompt || detailProject.overallPrompt || "未填写分段提示词"}</p></button>)}</div><div>{currentSegment ? <><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-semibold">当前分段：{segmentLabel(currentSegment)}</p><p className="text-xs text-stone-500">尝试 {currentSegment.attemptsCount} 次 · 下一个分段 {currentSegment.sequenceIndex + 1}/{detailProject.totalSegments}</p></div><div className="flex gap-2"><button className="rounded border border-stone-300 px-2 py-1 text-xs" onClick={() => { const previous = detailProject.segments[currentSegment.sequenceIndex - 1]; changeSegmentPrompt(previous?.prompt ?? detailProject.overallPrompt); }} type="button">复制上一段</button><button className="rounded border border-stone-300 px-2 py-1 text-xs" onClick={() => changeSegmentPrompt("")} type="button">清空</button></div></div><textarea className="mt-3 min-h-24 w-full rounded-md border border-stone-200 bg-[#faf8f4] p-3" maxLength={2000} onChange={(event) => changeSegmentPrompt(event.target.value)} value={currentSegment.prompt} /><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><div className="flex gap-2"><button className="rounded border border-stone-300 px-2 py-1 text-sm disabled:opacity-40" disabled={segmentIndex === 0} onClick={() => setSegmentIndex((current) => current - 1)} type="button">上一段</button><button className="rounded border border-stone-300 px-2 py-1 text-sm disabled:opacity-40" disabled={segmentIndex >= detailProject.totalSegments - 1} onClick={() => setSegmentIndex((current) => current + 1)} type="button">下一段</button></div><span className="text-xs text-stone-500">提示词自动保存 · 版本 {currentSegment.version}</span></div>{currentSegment.selectedAttemptId && ["awaiting_review", "accepted"].includes(currentSegment.status) ? <div className="mt-4 overflow-hidden rounded-md bg-black"><video className="max-h-80 w-full" controls playsInline src={publicMediaUrl(detailProject.id, "segment-video", currentSegment)} /></div> : <div className="mt-4 rounded-md bg-[#faf8f4] px-3 py-8 text-center text-sm text-stone-500">本段媒体尚未保存。</div>}{currentSegment.status === "awaiting_review" ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3"><p className="font-semibold">审核倒计时：{reviewSeconds} 秒</p><p className="mt-1 text-xs text-stone-600">倒计时由服务端截止时间控制；关闭浏览器也会在到期后自动接受。</p><div className="mt-3 flex flex-wrap gap-2"><button className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-bold text-white" disabled={busy} onClick={() => void patchProject("accept", currentSegment)} type="button">确认并继续</button><button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" disabled={busy} onClick={() => void patchProject("regenerate", currentSegment)} type="button">重新生成本段</button><button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" disabled={busy} onClick={() => void patchProject("pause", currentSegment)} type="button">暂停长视频</button></div></div> : null}{["accepted", "invalidated"].includes(currentSegment.status) && currentSegment.sequenceIndex < detailProject.nextSegmentIndex ? <button className="mt-3 rounded-md border border-rose-200 px-3 py-2 text-sm text-rose-700" onClick={() => { if (window.confirm("重新生成这一段会使所有后续分段失效，是否继续？")) void patchProject("regenerate", currentSegment); }} type="button">重新生成本段并失效后续</button> : null}</> : null}</div></div><p className="mt-4 rounded-md bg-stone-50 px-3 py-2 text-xs text-stone-600">{detailProject.estimate.creationFeeCaveat}</p></section> : null}
    </div>
  );
}
