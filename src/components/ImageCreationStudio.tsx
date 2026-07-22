"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatHourlyPrice, safeFixed } from "@/lib/image-generation/formatters";

type PersistedImageResult = {
  imagePath: string;
  thumbnailPath: string;
  sha256: string;
  width: number;
  height: number;
  metadataPath: string;
  persistedAt: string;
};

type Task = {
  id: string;
  prompt?: string;
  referenceImage?: string | null;
  mode?: "text_generation" | "kontext_edit";
  steps?: number | string | null;
  loraStrength?: number | string | null;
  cfg?: number | string | null;
  sampler?: "Euler" | "FlowMatch" | string | null;
  width?: number | string | null;
  height?: number | string | null;
  gpuClass?: "rtx4090" | "rtx5090" | null;
  badge?: "低" | "高" | string;
  status?: string;
  attempts?: number;
  result?: PersistedImageResult;
};

type Runner = {
  state?: "idle" | "running" | "failed" | "completed" | "cancelling" | string;
  stage?: string;
  frozenTaskIds?: string[];
  gpuClass?: "rtx4090" | "rtx5090" | null;
  maxHourlyPrice?: number | string | null;
  currentTaskIndex?: number | null;
  currentModel?: string | null;
  promptSummary?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  host?: {
    gpu?: string | null;
    priceHourly?: number | string | null;
    serverId?: string | null;
    orderId?: string | null;
    vram?: string | null;
    cpu?: string | null;
    ram?: string | null;
    disk?: string | null;
    network?: string | null;
    location?: string | null;
    runtimeDigest?: string | null;
    httpState?: string | null;
    sshDiagnostic?: string | null;
    orderStatus?: string | null;
    deploymentState?: string | null;
    clorePorts?: string[] | null;
    cloreHttpUrls?: string[] | null;
    controllerUrl?: string | null;
    httpExternalPort?: number | string | null;
    lastHealthStatus?: number | string | null;
    lastHealthError?: string | null;
    readinessElapsedSeconds?: number | string | null;
    lastPollAt?: string | null;
    message?: string | null;
  } | null;
  error?: { stage?: string; message?: string; at?: string; cancellationError?: string; billingRisk?: string } | null;
  blocker?: string | null;
};

type StudioResponse = { tasks?: Task[]; runner?: Runner; executionReady?: boolean; maxHourlyPrice?: number };
type Point = [number, number];

const initialSettings: { steps: number; loraStrength: number; cfg: number; sampler: "Euler" | "FlowMatch" } = { steps: 30, loraStrength: 0.8, cfg: 4, sampler: "FlowMatch" };
const cells = Array.from({ length: 64 }, (_, index) => [index % 8, Math.floor(index / 8)] as Point);
const panelStorageKey = "image-studio-gpu-panel-open";

function numberOrFallback(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rectangle(start: Point, end: Point) {
  const left = Math.min(start[0], end[0]);
  const top = Math.min(start[1], end[1]);
  const widthCells = Math.max(3, Math.abs(end[0] - start[0]) + 1);
  const heightCells = Math.max(3, Math.abs(end[1] - start[1]) + 1);
  return { left, top, right: left + widthCells - 1, bottom: top + heightCells - 1, width: widthCells * 256, height: heightCells * 256 };
}

function className(gpuClass: "rtx4090" | "rtx5090" | null | undefined) {
  return gpuClass === "rtx5090" ? "RTX 5090 · 高" : "RTX 4090 · 低";
}

function elapsed(startedAt: string | null | undefined) {
  if (!startedAt) return "—";
  const timestamp = new Date(startedAt).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  return `${Math.max(0, Math.floor((Date.now() - timestamp) / 1000 / 60))} 分钟`;
}

function displayDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}

function stageLabel(stage: string | null | undefined, orderId?: string | null) {
  const labels: Record<string, string> = {
    creating_order: "正在创建订单",
    order_created_waiting_http: "订单已创建，正在等待图片运行环境",
    order_created_waiting_deployment: "订单已创建，正在等待部署",
    waiting_http_endpoint: "订单已创建，正在等待 HTTP 地址",
    checking_http_health: "正在检查 /healthz",
    runtime_ready: "图片运行环境已就绪",
    runner_exited_order_active: "Runner 已退出，订单仍活跃",
    runner_exited: "Runner 已退出",
    http_readiness_timeout_cancel_failed: "HTTP 未就绪，退租失败",
  };
  if (orderId && stage === "creating_order") return "订单已创建，正在等待图片运行环境";
  return labels[String(stage ?? "")] ?? stage ?? "当前未租用显卡";
}

function secondsLabel(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes ? `${minutes}分${rest}秒` : `${rest}秒`;
}

function listLabel(value: unknown) {
  return Array.isArray(value) && value.length ? value.join(", ") : "—";
}

export function ImageCreationStudio() {
  const [prompt, setPrompt] = useState("");
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [corner, setCorner] = useState<Point | null>([0, 0]);
  const [hover, setHover] = useState<Point>([2, 2]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [runner, setRunner] = useState<Runner | null>(null);
  const [executionReady, setExecutionReady] = useState(false);
  const [maxHourlyPrice, setMaxHourlyPrice] = useState(0.6);
  const [panelOpen, setPanelOpen] = useState(false);
  const [hostDetails, setHostDetails] = useState(false);
  const [starting, setStarting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selection = rectangle(corner ?? [0, 0], hover);
  const draftGpuClass = selection.width <= 1280 && selection.height <= 1280 ? "rtx4090" : "rtx5090";
  const selectedTask = tasks.find((task) => task.id === selected) ?? null;
  const confirmed = tasks.filter((task) => task.status === "waiting_for_gpu");
  const completed = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const selectedBatch = selectedTask?.status === "waiting_for_gpu" ? [selectedTask] : [];
  const runnerBusy = runner?.state === "running" || runner?.state === "cancelling";
  const startBlocker = runnerBusy
    ? "已有图像批次正在启动或执行，请先等待或退租。"
    : !selectedTask
      ? "请选择一个已确认的图像任务。"
      : selectedTask.status !== "waiting_for_gpu"
        ? "请先确认图像任务。"
        : selectedTask.gpuClass === "rtx5090"
          ? "RTX 5090 高分辨率执行器尚未完成"
          : selectedTask.mode !== "text_generation" || selectedTask.referenceImage
            ? "FLUX Kontext 执行器尚未完成"
            : numberOrFallback(selectedTask.width, 0) > 1280 || numberOrFallback(selectedTask.height, 0) > 1280
              ? "RTX 4090 仅支持不超过 1280 × 1280 的任务。"
              : runner?.blocker;
  const startDisabled = starting || !executionReady || Boolean(startBlocker) || selectedBatch.length === 0 || selectedBatch.some((task) => task.gpuClass !== selectedBatch[0].gpuClass);

  const applyResponse = useCallback((data: StudioResponse) => {
    setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    setRunner(data.runner ?? null);
    setExecutionReady(data.executionReady === true);
    const serverPrice = Number(data.maxHourlyPrice);
    setMaxHourlyPrice((value) => (Number.isFinite(value) && value > 0 ? value : Number.isFinite(serverPrice) && serverPrice > 0 ? serverPrice : 0.6));
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/local-lab/image-tasks", { cache: "no-store" });
    if (response.ok) applyResponse((await response.json()) as StudioResponse);
  }, [applyResponse]);

  useEffect(() => {
    setPanelOpen(window.localStorage.getItem(panelStorageKey) === "true");
    const saved = Number(window.localStorage.getItem("image-studio-max-hourly-price"));
    if (Number.isFinite(saved) && saved > 0) setMaxHourlyPrice(saved);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((candidate) => candidate.type.startsWith("image/"));
      if (file) {
        event.preventDefault();
        readFile(file);
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);

  const setDrawer = (open: boolean) => {
    setPanelOpen(open);
    window.localStorage.setItem(panelStorageKey, String(open));
  };

  const persistPrice = async () => {
    const value = Number(safeFixed(maxHourlyPrice, 2));
    if (!Number.isFinite(value) || value <= 0) return;
    window.localStorage.setItem("image-studio-max-hourly-price", String(value));
    const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set_price", maxHourlyPrice: value }) });
    if (response.ok) applyResponse((await response.json()) as StudioResponse);
  };

  const mutate = async (action: "confirm" | "retry" | "delete", id: string) => {
    const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id }) });
    if (response.ok) applyResponse((await response.json()) as StudioResponse);
  };

  const create = async () => {
    if (!prompt.trim()) return;
    const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", prompt, referenceImage, width: selection.width, height: selection.height, ...settings }) });
    if (response.ok) {
      const data = (await response.json()) as StudioResponse & { task: Task };
      applyResponse(data);
      setSelected(data.task.id);
      setPrompt("");
    }
  };

  const startBatch = async () => {
    if (startDisabled) return;
    setStarting(true);
    try {
      const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start_batch", taskIds: selectedBatch.map((task) => task.id), maxHourlyPrice }) });
      applyResponse((await response.json()) as StudioResponse);
    } finally {
      setStarting(false);
    }
  };

  const cancelBatch = async () => {
    const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel_batch" }) });
    applyResponse((await response.json()) as StudioResponse);
  };

  const readFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setReferenceImage(String(reader.result));
    reader.readAsDataURL(file);
  };

  const clickCell = (point: Point) => {
    if (corner === null) {
      setCorner(point);
      setHover(point);
      return;
    }
    setHover(point);
    setCorner(null);
  };

  const currentClass = runner?.gpuClass ?? selectedBatch[0]?.gpuClass ?? draftGpuClass;
  const runnerError = runner?.error ?? null;
  const host = runner?.host ?? null;
  const rawStage = runner?.stage ?? "当前未租用显卡";
  const stage = stageLabel(rawStage, host?.orderId);

  const panel = (
    <aside className="h-fit border-r border-stone-700 bg-stone-900 p-4 lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto" aria-label="显卡状态">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">显卡状态</h2>
        <span className={`rounded px-2 py-1 text-xs ${runner?.state === "failed" ? "bg-rose-500/20 text-rose-200" : "bg-stone-800 text-stone-300"}`}>{stage}</span>
      </div>
      <section className="space-y-2 rounded-lg border border-stone-700 p-3 text-sm">
        <div className="flex justify-between"><span>未确认任务</span><b>{tasks.filter((task) => task.status === "pending_confirmation").length}</b></div>
        <div className="flex justify-between"><span>已确认任务</span><b>{confirmed.length}</b></div>
        <div className="flex justify-between"><span>当前选中任务</span><b>{selectedTask ? 1 : 0}</b></div>
        <div className="flex justify-between"><span>当前冻结批次</span><b>{runner?.frozenTaskIds?.length ?? 0}</b></div>
        <div className="flex justify-between"><span>已完成 / 失败</span><b>{completed} / {failed}</b></div>
      </section>
      <section className="mt-3 rounded-lg border border-stone-700 p-3 text-sm">
        <b className={currentClass === "rtx4090" ? "text-sky-300" : "text-violet-300"}>{className(currentClass)}</b>
        <p className="mt-1 text-xs text-stone-400">当前尺寸 {selectedTask ? `${selectedTask.width ?? "—"} × ${selectedTask.height ?? "—"}` : `${selection.width} × ${selection.height}`}；服务端要求 {className(currentClass)}</p>
      </section>
      <section className="mt-3 rounded-lg border border-stone-700 p-3">
        <label className="block text-sm font-medium">
          最高时价
          <input aria-label="最高时价" className="mt-2 w-full rounded border border-stone-600 bg-stone-950 px-2 py-1" type="number" min="0.01" max="100" step="0.01" value={maxHourlyPrice} onChange={(event) => setMaxHourlyPrice(Number(event.target.value))} onBlur={() => void persistPrice()} />
        </label>
        <p className="mt-1 text-xs text-stone-400">${safeFixed(maxHourlyPrice, 2)} / 小时；批次开始时会冻结此值。</p>
        <button type="button" disabled={startDisabled} title={startBlocker ?? undefined} onClick={() => void startBatch()} className="mt-3 w-full rounded bg-indigo-500 px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">开始 {selectedBatch.length} 个任务并租用显卡</button>
        {runnerBusy ? <button type="button" onClick={() => void cancelBatch()} className="mt-2 w-full rounded border border-rose-400 px-3 py-2 text-sm font-semibold text-rose-100">停止并退租 / 取消本批次</button> : null}
        {startBlocker ? <p className="mt-2 text-xs text-amber-200">{startBlocker}</p> : null}
      </section>
      {host ? (
        <section className="mt-3 rounded-lg border border-stone-700 p-3 text-sm">
          <p>{host.gpu ?? "RTX 4090"} · {formatHourlyPrice(host.priceHourly)} · 主机 {host.serverId ?? "—"} · {stage}</p>
          <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-stone-300">
            <span>订单已创建</span><b>{host.orderId ? "是" : "否"}</b>
            <span>订单 ID</span><b>{host.orderId ?? "—"}</b>
            <span>Clore 部署</span><b>{host.deploymentState ?? "—"}</b>
            <span>HTTP 地址</span><b>{host.controllerUrl ? "已获得" : "正在等待"}</b>
            <span>/healthz</span><b>{host.httpState ?? "—"}</b>
            <span>等待时间</span><b>{secondsLabel(host.readinessElapsedSeconds)}</b>
          </div>
          {host.lastHealthError ? <p className="mt-2 break-words text-xs text-amber-200">最新错误：{host.lastHealthError}</p> : null}
          <button className="mt-2 text-xs text-indigo-300" type="button" onClick={() => setHostDetails(!hostDetails)}>查看详细配置</button>
          {hostDetails ? (
            <dl className="mt-2 grid grid-cols-2 gap-1 text-xs text-stone-300">
              {[
                ["GPU", host.gpu],
                ["VRAM", host.vram],
                ["CPU", host.cpu],
                ["RAM", host.ram],
                ["磁盘", host.disk],
                ["网络", host.network],
                ["位置", host.location],
                ["订单", host.orderId],
                ["Runtime", host.runtimeDigest],
                ["HTTP", host.httpState],
                ["订单状态", host.orderStatus],
                ["部署状态", host.deploymentState],
                ["Clore 端口", listLabel(host.clorePorts)],
                ["HTTP URLs", listLabel(host.cloreHttpUrls)],
                ["Controller", host.controllerUrl],
                ["外部 8080 端口", host.httpExternalPort],
                ["Health 状态码", host.lastHealthStatus],
                ["Health 错误", host.lastHealthError],
                ["最后轮询", displayDate(host.lastPollAt)],
                ["SSH（诊断）", host.sshDiagnostic],
              ].map(([key, value]) => <div key={String(key)}><dt className="text-stone-500">{key}</dt><dd>{value ?? "—"}</dd></div>)}
            </dl>
          ) : null}
        </section>
      ) : null}
      <section className="mt-3 rounded-lg border border-stone-700 p-3 text-sm">
        <h3 className="font-medium">运行进程</h3>
        <p className="mt-1">{stage}</p>
        {host?.message ? <p className="mt-1 text-xs text-stone-300">{host.message}</p> : null}
        {host?.orderId ? <p className="mt-1 text-xs text-stone-400">订单 {host.orderId} · 部署 {host.deploymentState ?? "—"} · HTTP {host.controllerUrl ? "已获得" : "等待中"} · /healthz {host.lastHealthStatus ?? host.lastHealthError ?? "—"}</p> : null}
        <p className="mt-1 text-xs text-stone-400">任务 {runner?.currentTaskIndex === null || runner?.currentTaskIndex === undefined ? "—" : runner.currentTaskIndex + 1}/{runner?.frozenTaskIds?.length ?? 0} · {runner?.currentModel ?? "—"}</p>
        <p className="mt-1 line-clamp-2 text-xs text-stone-400">{runner?.promptSummary ?? "尚未冻结图像批次"}</p>
        <p className="mt-1 text-xs text-stone-500">已用时 {elapsed(runner?.startedAt)} · HTTP 等待 {secondsLabel(host?.readinessElapsedSeconds)} · 更新于 {displayDate(runner?.updatedAt)}</p>
        {host?.lastPollAt ? <p className="mt-1 text-xs text-stone-500">最后轮询 {displayDate(host.lastPollAt)}</p> : null}
      </section>
      {runnerError ? (
        <section className="mt-3 rounded-lg border border-rose-700/60 bg-rose-950/20 p-3 text-sm">
          <p className="font-medium text-rose-200">{runnerError.stage ?? "执行错误"}</p>
          <p className="mt-1 break-words text-rose-100">{runnerError.message ?? "未知错误"}</p>
          {runnerError.billingRisk ? <p className="mt-1 text-xs text-amber-200">{runnerError.billingRisk}</p> : null}
          {runnerError.cancellationError ? <p className="mt-1 break-words text-xs text-rose-200">退租错误：{runnerError.cancellationError}</p> : null}
          <p className="mt-1 text-xs text-rose-200/70">{displayDate(runnerError.at)}</p>
          <button className="mt-2 text-xs text-rose-100 underline" type="button" onClick={() => void navigator.clipboard.writeText(`${runnerError.stage ?? "执行错误"}\n${runnerError.message ?? "未知错误"}\n${runnerError.at ?? ""}`)}>复制错误</button>
        </section>
      ) : null}
    </aside>
  );

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <button type="button" className="fixed bottom-4 left-4 z-30 rounded bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-950 lg:hidden" onClick={() => setDrawer(true)}>显卡状态</button>
      {panelOpen ? <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setDrawer(false)}><div className="h-full w-[min(340px,90vw)] overflow-y-auto" onClick={(event) => event.stopPropagation()}>{panel}</div></div> : null}
      <div className="mx-auto grid min-h-screen max-w-[1600px] lg:grid-cols-[320px_minmax(0,1fr)_360px]">
        <div className="hidden lg:block">{panel}</div>
        <section className="m-4 rounded-2xl border border-stone-700 bg-stone-900 p-5">
          <header className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">图像工作台</h1>
              <p className="text-sm text-stone-400">Fluxed Up 10.2 · FLUX.1-Kontext-dev · AIDMA</p>
            </div>
            <span className="rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">仅图像</span>
          </header>
          <label className="block text-sm font-medium">
            提示词
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-stone-600 bg-stone-950 p-3" placeholder="描述想要创建，或基于参考图编辑的图像。" />
          </label>
          <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) readFile(file); }} onClick={() => inputRef.current?.click()} className="mt-3 cursor-pointer rounded-lg border border-dashed border-stone-600 p-3 text-sm text-stone-400">
            参考图（可选）：点击、拖入或直接粘贴。
            {referenceImage ? <img src={referenceImage} alt="参考图预览" className="mt-2 max-h-40 rounded" /> : null}
            <input ref={inputRef} className="hidden" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); }} />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label>步数 {settings.steps}<input className="w-full" type="range" min="25" max="40" value={settings.steps} onChange={(event) => setSettings({ ...settings, steps: Number(event.target.value) })} /></label>
            <label>LoRA 强度 {safeFixed(settings.loraStrength, 1)}<input className="w-full" type="range" min="0.6" max="1.1" step="0.1" value={settings.loraStrength} onChange={(event) => setSettings({ ...settings, loraStrength: Number(event.target.value) })} /></label>
            <label>CFG {safeFixed(settings.cfg, 1)}<input className="w-full" type="range" min="3.5" max="5" step="0.1" value={settings.cfg} onChange={(event) => setSettings({ ...settings, cfg: Number(event.target.value) })} /></label>
            <div><p className="mb-1">采样器</p>{(["Euler", "FlowMatch"] as const).map((sampler) => <button type="button" key={sampler} onClick={() => setSettings({ ...settings, sampler })} className={`mr-2 rounded px-3 py-1 ${settings.sampler === sampler ? "bg-indigo-500" : "bg-stone-700"}`}>{sampler}</button>)}</div>
          </div>
          <div className="mt-5">
            <div className="mb-2 flex justify-between"><b>分辨率：{selection.width} × {selection.height}</b><span className={draftGpuClass === "rtx4090" ? "text-sky-300" : "text-violet-300"}>{className(draftGpuClass)}</span></div>
            <div className="grid w-full max-w-md grid-cols-8 gap-1">{cells.map(([x, y]) => { const active = x >= selection.left && x <= selection.right && y >= selection.top && y <= selection.bottom; return <button type="button" aria-label={`${x + 1} by ${y + 1} grid cell`} onMouseEnter={() => corner && setHover([x, y])} onClick={() => clickCell([x, y])} key={`${x}-${y}`} className={`aspect-square rounded-sm ${active ? "bg-indigo-400" : "bg-stone-700 hover:bg-stone-500"}`} />; })}</div>
          </div>
          <button disabled={!prompt.trim()} onClick={() => void create()} className="mt-5 rounded-lg bg-indigo-500 px-5 py-2 font-medium disabled:opacity-40">创建图像任务</button>
        </section>
        <aside className="m-4 ml-0 rounded-2xl border border-stone-700 bg-stone-900 p-4">
          <h2 className="font-semibold">图像任务池</h2>
          <p className="mb-3 text-xs text-stone-400">{tasks.length} 项 · 仅图像</p>
          <div className="space-y-2">
            {tasks.map((task) => (
              <article onClick={() => setSelected(task.id)} key={task.id} className={`cursor-pointer rounded-lg border p-3 text-xs ${selected === task.id ? "border-indigo-400 bg-indigo-500/10" : "border-stone-700"}`}>
                <div className="flex justify-between"><span className={task.gpuClass === "rtx4090" ? "text-sky-300" : "text-violet-300"}>{className(task.gpuClass)}</span><span>{task.status ?? "pending_confirmation"}</span></div>
                <p className="mt-1 line-clamp-2">{task.prompt ?? ""}</p>
                <p className="mt-1 text-stone-400">{task.width ?? "—"}×{task.height ?? "—"} · {task.steps ?? "—"} 步 · {task.sampler ?? "—"} · LoRA {safeFixed(task.loraStrength, 1)} · CFG {safeFixed(task.cfg, 1)}{task.referenceImage ? " · 参考图" : ""}</p>
                {task.result ? <p className="mt-1 text-emerald-300">结果：{task.result.width}×{task.result.height} · SHA {task.result.sha256.slice(0, 12)}</p> : null}
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={(event) => { event.stopPropagation(); void mutate("confirm", task.id); }}>确认</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); void mutate("retry", task.id); }}>重试</button>
                  <button type="button" className="text-rose-300" onClick={(event) => { event.stopPropagation(); void mutate("delete", task.id); }}>删除</button>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
