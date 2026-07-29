"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupImageTasks, groupStatusLabel, selectStudioExecutableBatch, type GroupableImageTask, type ImageTaskGroup } from "@/lib/image-generation/image-task-groups";
import { safeFixed } from "@/lib/image-generation/formatters";
import { rentalClockSnapshot, type RentalTiming } from "@/lib/image-generation/live-runner-display";
import type { RegisteredLora } from "@/lib/image-generation/image-loras";

type Result = { width?: number; height?: number; completedAt?: string; persistedAt?: string; relativeDir?: string; pngSha256?: string; pngBytes?: number };
type Task = GroupableImageTask & { referenceImage?: string | null; negativePrompt?: string; loras?: LoraTaskSnapshot[]; steps?: number | string | null; cfg?: number | string | null; loraStrength?: number | string | null; sampler?: string | null; seed?: number; gpuClass?: "rtx4090" | "rtx5090" | null; result?: Result; attempts?: number; error?: { message?: string }; localClaim?: unknown };
type Runner = { state?: "idle" | "running" | "failed" | "completed" | "cancelling"; stage?: string; frozenTaskIds?: string[]; currentTaskIndex?: number | null; gpuClass?: "rtx4090" | "rtx5090" | null; maxHourlyPrice?: number; updatedAt?: string; host?: { orderId?: string | null; serverId?: string | null; gpu?: string | null; priceHourly?: number | null; vram?: string | null; location?: string | null; orderStatus?: string | null; deploymentState?: string | null; attemptedServerIds?: string[]; marketplaceRefreshedAt?: string | null; candidateRole?: "candidate" | "rented_host" | null; market?: { phase?: string; scannedAt?: string | null; nextScanAt?: string | null; totalServerCount?: number | null; compliantCandidateCount?: number | null; rejectedServerIds?: string[]; selectedServerId?: string | null; selectedHourlyUsd?: number | null } | null; candidateAttempts?: Array<{ serverId?: string; hourlyUsd?: number | null; event?: string }> } | null; rentalTiming?: RentalTiming | null; progress?: { displayMessage?: string; phase?: string; market?: { nextScanInSeconds?: number | null } | null; canCancelWaiting?: boolean; canStopAndCancelOrder?: boolean } | null; error?: { displayMessage?: string; isBlocking?: boolean; historical?: boolean } | null; blocker?: string | null };
type LocalProgram = { service?: "running" | "failed"; port?: number; cpuLogicalCores?: number; totalRamBytes?: number; availableRamBytes?: number; processMemoryBytes?: number; taskStoreAvailable?: boolean; imageLibraryAvailable?: boolean; refreshedAt?: string };
type GpuReadiness = Record<"rtx4090" | "rtx5090", { ready: boolean; blocker: string | null }>;
type ExecutableBatch = { plannedTaskIds: string[]; executableCount: number; excludedInconsistentTaskIds: string[] };
type Response = { tasks?: Task[]; runner?: Runner; executionReady?: boolean; executionReadiness?: GpuReadiness; executableBatches?: Record<"rtx4090" | "rtx5090", ExecutableBatch>; localProgram?: LocalProgram; maxHourlyPrice?: number; groupId?: string; error?: string; groupAction?: { blocker?: string | null } };
type StudioLogExport = { filename: string; generatedAt: string; text: string; lineCount: number; truncated: boolean; sanitized: true; sourceLabels: string[] };
type Settings = { steps: number; loraStrength: number; cfg: number; sampler: "Euler" | "FlowMatch" };
type LoraSelection = Pick<RegisteredLora, "id" | "name" | "filename" | "availability" | "builtIn"> & { strength: number; enabled: boolean };
type LoraTaskSnapshot = Pick<LoraSelection, "id" | "name" | "filename" | "strength" | "enabled">;
type LoraRegistryResponse = { items?: RegisteredLora[]; item?: RegisteredLora; message?: string; error?: string };
type AddLoraRequest = { name: string; sourceUrl: string; defaultStrength: number; presetId?: string };
type Point = [number, number]; type Resolution = { width: number; height: number };
const initialSettings: Settings = { steps: 30, loraStrength: .8, cfg: 4, sampler: "FlowMatch" };
const selectableLora = (item: Pick<RegisteredLora, "availability">) =>
  item.availability === "ready" || item.availability === "registered";
function hasActiveTaskClaim(task: Task) { const claim = task.localClaim; if (!claim || typeof claim !== "object") return Boolean(claim); const expiresAt = (claim as { leaseExpiresAt?: unknown }).leaseExpiresAt; return typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now(); }
const cells = Array.from({ length: 64 }, (_, index) => [index % 8, Math.floor(index / 8)] as Point);
const tabKey = "image-studio-selected-tab"; const countKey = "image-studio-generation-count";
const validCount = (value: string | number) => { const count = Number(value); return Number.isSafeInteger(count) && count >= 1 ? count : null; };
async function fetchJsonWithTimeout<T>(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const data = await response.json() as T;
    return { response, data };
  } finally {
    window.clearTimeout(timer);
  }
}
const title = (group: ImageTaskGroup<Task>) => group.title || "未命名图像组";
const groupPrompt = (group: ImageTaskGroup<Task>) => group.tasks[0]?.prompt || "未填写提示词";
const gpuClass = (resolution: Resolution) => resolution.width < 768 || resolution.height < 768 || resolution.width > 1536 || resolution.height > 1536 || resolution.width % 256 || resolution.height % 256 ? null : resolution.width <= 1280 && resolution.height <= 1280 ? "rtx4090" : "rtx5090";
function rectangle(start: Point, end: Point) { const left = Math.min(start[0], end[0]); const top = Math.min(start[1], end[1]); const widthCells = Math.max(3, Math.abs(start[0] - end[0]) + 1); const heightCells = Math.max(3, Math.abs(start[1] - end[1]) + 1); return { left, top, right: left + widthCells - 1, bottom: top + heightCells - 1, width: widthCells * 256, height: heightCells * 256 }; }
function mergeLoraSelections(registered: RegisteredLora[], current: LoraSelection[]) {
  const previous = new Map(current.map((item) => [item.id, item]));
  return registered.map((item): LoraSelection => {
    const existing = previous.get(item.id);
    return {
      id: item.id,
      name: item.name,
      filename: item.filename,
      availability: item.availability,
      builtIn: item.builtIn,
      strength: existing?.strength ?? item.defaultStrength,
      enabled: selectableLora(item) && (existing?.enabled ?? item.defaultEnabled),
    };
  });
}

export function ImageStudioNavigation({ tab, onChange, activeCount, resultCount }: { tab: "prompt" | "results"; onChange: (tab: "prompt" | "results") => void; activeCount: number; resultCount: number }) {
  return <nav className="flex gap-2 border-b border-stone-700 px-4 pt-4" aria-label="图像工作区导航"><button type="button" aria-pressed={tab === "prompt"} onClick={() => onChange("prompt")} className={`rounded-t-lg px-5 py-3 font-semibold ${tab === "prompt" ? "bg-indigo-500 text-white" : "bg-stone-800 text-stone-300"}`}>提示词 <span className="ml-1 text-xs">{activeCount}</span></button><button type="button" aria-pressed={tab === "results"} onClick={() => onChange("results")} className={`rounded-t-lg px-5 py-3 font-semibold ${tab === "results" ? "bg-indigo-500 text-white" : "bg-stone-800 text-stone-300"}`}>成果 <span className="ml-1 text-xs">{resultCount}</span></button></nav>;
}

function LoraManagementPanel({
  items,
  registryLoaded,
  busy,
  error,
  onChange,
  onAdd,
  onUpdate,
}: {
  items: LoraSelection[];
  registryLoaded: boolean;
  busy: boolean;
  error: string | null;
  onChange: (items: LoraSelection[]) => void;
  onAdd: (request: AddLoraRequest) => Promise<boolean>;
  onUpdate: (id: string, name: string, defaultStrength: number) => Promise<boolean>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [name, setName] = useState("");
  const [defaultStrength, setDefaultStrength] = useState(.8);
  const [presetId, setPresetId] = useState<string | undefined>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const openAdd = (item?: LoraSelection) => {
    setPresetId(item?.id);
    setName(item?.name ?? "");
    setDefaultStrength(item?.strength ?? .8);
    setSourceUrl("");
    setAddOpen(true);
  };
  const replace = (id: string, patch: Partial<LoraSelection>) =>
    onChange(items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const submitAdd = async () => {
    const succeeded = await onAdd({ name, sourceUrl, defaultStrength, ...(presetId ? { presetId } : {}) });
    if (succeeded) setAddOpen(false);
  };
  const saveEdit = async (item: LoraSelection) => {
    if (await onUpdate(item.id, editingName, item.strength)) setEditingId(null);
  };

  return <section className="mt-5 overflow-hidden rounded-xl border border-stone-600 bg-stone-950/60" aria-label="LoRA 管理">
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-700 bg-stone-950 p-3">
      <div>
        <h2 className="font-semibold">LoRA 管理</h2>
        <p className="text-xs text-stone-400">可同时启用多个；按列表顺序依次加载。</p>
      </div>
      <button type="button" disabled={busy} onClick={() => openAdd()} className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium disabled:opacity-40">添加新的LoRA</button>
    </div>
    <div className="max-h-80 space-y-3 overflow-y-auto overflow-x-hidden p-3" data-scroll-direction="vertical">
      {!registryLoaded ? <p className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">LoRA 列表尚未载入；创建旧任务时仍使用原来的单 LoRA 设置。</p> : null}
      {items.map((item) => <article key={item.id} className="rounded-lg border border-stone-700 bg-stone-900 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editingId === item.id
              ? <input aria-label={`${item.name} 显示名称`} maxLength={80} value={editingName} onChange={(event) => setEditingName(event.target.value)} className="w-full rounded border border-stone-600 bg-stone-950 px-2 py-1 font-semibold" />
              : <b className="block break-words">{item.name}</b>}
            <p className="mt-1 truncate text-xs text-stone-500">
              {item.availability === "ready"
                ? item.filename
                : item.availability === "registered"
                  ? item.filename || "已登记来源，等待生成时下载"
                  : "尚未添加模型文件"}
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <span>{item.enabled ? "已启用" : "未启用"}</span>
            <input
              aria-label={`启用 ${item.name}`}
              type="checkbox"
              checked={item.enabled}
              disabled={busy || !selectableLora(item)}
              onChange={(event) => replace(item.id, { enabled: event.target.checked })}
            />
          </label>
        </div>
        <label className="mt-3 block text-sm">
          强度 <b className="font-mono">{safeFixed(item.strength, 2)}</b>
          <input
            aria-label={`${item.name} 强度`}
            className="mt-1 w-full"
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={item.strength}
            disabled={busy || !selectableLora(item)}
            onChange={(event) => replace(item.id, { strength: Number(event.target.value) })}
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {item.availability === "missing"
            ? <button type="button" disabled={busy} onClick={() => openAdd(item)} className="rounded border border-amber-300 px-2 py-1 text-xs text-amber-100 disabled:opacity-40">添加此 LoRA</button>
            : editingId === item.id
              ? <>
                <button type="button" disabled={busy || !editingName.trim()} onClick={() => void saveEdit(item)} className="rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-100 disabled:opacity-40">保存名称和默认强度</button>
                <button type="button" disabled={busy} onClick={() => setEditingId(null)} className="rounded border border-stone-500 px-2 py-1 text-xs">取消编辑</button>
              </>
              : <button type="button" disabled={busy} onClick={() => { setEditingId(item.id); setEditingName(item.name); }} className="rounded border border-stone-500 px-2 py-1 text-xs">编辑名称/默认值</button>}
          <span className={`text-xs ${selectableLora(item) ? "text-emerald-300" : "text-amber-200"}`}>
            {item.availability === "ready"
              ? "来源身份已锁定；云端下载后会再次校验 SHA-256"
              : item.availability === "registered"
                ? "已注册，生成时下载并校验"
                : "缺少已登记来源，不能勾选"}
          </span>
        </div>
      </article>)}
      {registryLoaded && items.length === 0 ? <p className="text-sm text-stone-400">还没有可显示的 LoRA。</p> : null}
    </div>
    {error && !addOpen ? <p role="alert" className="border-t border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">{error}</p> : null}
    {addOpen ? <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4" onMouseDown={() => !busy && setAddOpen(false)}>
      <section role="dialog" aria-modal="true" aria-label="添加新的 LoRA" onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-stone-600 bg-stone-950 p-5 shadow-2xl">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">添加新的LoRA</h2><button type="button" disabled={busy} onClick={() => setAddOpen(false)}>关闭</button></div>
        <label className="mt-4 block text-sm">显示名称<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded border border-stone-600 bg-stone-900 px-3 py-2" placeholder="例如：解决男人女器官LoRA" /></label>
        <label className="mt-4 block text-sm">Civitai 或 HuggingFace 链接<textarea value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} className="mt-1 min-h-24 w-full rounded border border-stone-600 bg-stone-900 p-3" placeholder="粘贴模型页、具体版本或 .safetensors 文件链接" /></label>
        <label className="mt-4 block text-sm">默认强度 {safeFixed(defaultStrength, 2)}<input className="mt-1 w-full" type="range" min="0" max="1.5" step="0.05" value={defaultStrength} onChange={(event) => setDefaultStrength(Number(event.target.value))} /></label>
        <p className="mt-3 text-xs text-stone-400">本机保存可识别的模型来源；真正生成时由受限 Agent 下载到 ComfyUI/models/loras，并核对大小、SHA-256 与 safetensors 结构。</p>
        {error ? <p role="alert" className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">{error}</p> : null}
        <button type="button" aria-busy={busy} disabled={busy || !name.trim() || !sourceUrl.trim()} onClick={() => void submitAdd()} className="mt-4 rounded-lg bg-indigo-500 px-4 py-2 font-medium disabled:opacity-40">{busy ? "正在注册…" : "校验并注册"}</button>
      </section>
    </div> : null}
  </section>;
}

export function ImagePromptWorkspace({
  resolution,
  setResolution,
  prompt,
  setPrompt,
  negativePrompt,
  setNegativePrompt,
  referenceImage,
  setReferenceImage,
  settings,
  setSettings,
  loras,
  setLoras,
  loraRegistryLoaded,
  loraBusy,
  loraError,
  onAddLora,
  onUpdateLora,
  count,
  setCount,
  error,
  busy,
  onCreate,
}: {
  resolution: Resolution;
  setResolution: (value: Resolution) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  negativePrompt: string;
  setNegativePrompt: (value: string) => void;
  referenceImage: string | null;
  setReferenceImage: (value: string | null) => void;
  settings: Settings;
  setSettings: (value: Settings) => void;
  loras: LoraSelection[];
  setLoras: (value: LoraSelection[]) => void;
  loraRegistryLoaded: boolean;
  loraBusy: boolean;
  loraError: string | null;
  onAddLora: (request: AddLoraRequest) => Promise<boolean>;
  onUpdateLora: (id: string, name: string, defaultStrength: number) => Promise<boolean>;
  count: string;
  setCount: (value: string) => void;
  error: string | null;
  busy: boolean;
  onCreate: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [corner, setCorner] = useState<Point | null>([0, 0]);
  const [hover, setHover] = useState<Point>([2, 2]);
  const selection = rectangle(corner ?? [0, 0], hover);
  const selectedGpu = gpuClass(selection);
  const unsupported = selectedGpu === null;
  useEffect(() => {
    if (corner === null && (resolution.width !== selection.width || resolution.height !== selection.height)) {
      setResolution({ width: selection.width, height: selection.height });
    }
  }, [corner, resolution.height, resolution.width, selection.height, selection.width, setResolution]);
  const clickCell = (point: Point) => {
    if (corner === null) { setCorner(point); setHover(point); } else { setHover(point); setCorner(null); }
  };
  const readFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setReferenceImage(String(reader.result));
    reader.readAsDataURL(file);
  };
  return <section className="m-4 rounded-2xl border border-stone-700 bg-stone-900 p-5">
    <header className="mb-5 flex justify-between"><div><h1 className="text-2xl font-semibold">图像工作台</h1><p className="text-sm text-stone-400">Fluxed Up 10.2 · 多 LoRA</p></div><span className="rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">仅图像</span></header>
    <label className="block text-sm font-medium">提示词<textarea maxLength={4_000} value={prompt} onChange={(event) => setPrompt(event.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-stone-600 bg-stone-950 p-3" placeholder="描述想要创建，或基于参考图编辑的图像。" /></label>
    <label className="mt-4 block text-sm font-medium">负面提示词（Negative Prompt）<textarea aria-label="负面提示词" maxLength={4_000} value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-stone-600 bg-stone-950 p-3" placeholder="填写不希望出现在图像中的内容；留空也可以正常生成。" /></label>
    <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) readFile(file); }} onClick={() => input.current?.click()} className="mt-3 cursor-pointer rounded-lg border border-dashed border-stone-600 p-3 text-sm text-stone-400">参考图（可选）：点击、拖入或直接粘贴。{referenceImage ? <img src={referenceImage} alt="参考图预览" className="mt-2 max-h-40 rounded" /> : null}<input ref={input} className="hidden" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); }} /></div>
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <label>步数 {settings.steps}<input className="w-full" type="range" min="25" max="40" value={settings.steps} onChange={(event) => setSettings({ ...settings, steps: Number(event.target.value) })} /></label>
      <label className={loraRegistryLoaded ? "text-stone-500" : ""}>旧任务兼容 LoRA 强度 {safeFixed(settings.loraStrength, 1)}<input className="w-full" type="range" min="0.6" max="1.1" step="0.1" disabled={loraRegistryLoaded} value={settings.loraStrength} onChange={(event) => setSettings({ ...settings, loraStrength: Number(event.target.value) })} /></label>
      <label>CFG {safeFixed(settings.cfg, 1)}<input className="w-full" type="range" min="3.5" max="5" step="0.1" value={settings.cfg} onChange={(event) => setSettings({ ...settings, cfg: Number(event.target.value) })} /></label>
      <div><p className="mb-1">采样器</p>{(["Euler", "FlowMatch"] as const).map((sampler) => <button type="button" key={sampler} onClick={() => setSettings({ ...settings, sampler })} className={`mr-2 rounded px-3 py-1 ${settings.sampler === sampler ? "bg-indigo-500" : "bg-stone-700"}`}>{sampler}</button>)}</div>
    </div>
    <LoraManagementPanel items={loras} registryLoaded={loraRegistryLoaded} busy={busy || loraBusy} error={loraError} onChange={setLoras} onAdd={onAddLora} onUpdate={onUpdateLora} />
    <section className="mt-5" aria-label="分辨率绘制网格">
      <div className="mb-2 flex justify-between"><b>分辨率：{selection.width} × {selection.height}</b><span className={selectedGpu === "rtx5090" ? "text-violet-300" : selectedGpu === "rtx4090" ? "text-sky-300" : "text-amber-200"}>{selectedGpu === "rtx5090" ? "RTX 5090 · 高" : selectedGpu === "rtx4090" ? "RTX 4090 · 低" : "当前不支持"}</span></div>
      <div className="grid w-full max-w-md grid-cols-8 gap-1">{cells.map(([x, y]) => { const active = x >= selection.left && x <= selection.right && y >= selection.top && y <= selection.bottom; return <button type="button" aria-label={`${x + 1} by ${y + 1} grid cell`} onMouseEnter={() => corner && setHover([x, y])} onClick={() => clickCell([x, y])} key={`${x}-${y}`} className={`aspect-square rounded-sm ${active ? "bg-indigo-400" : "bg-stone-700 hover:bg-stone-500"}`} />; })}</div>
      <p className="mt-2 text-xs text-stone-400">第一次点击起点，悬停预览，第二次点击完成矩形选择。</p>
      {unsupported ? <p className="mt-1 text-xs text-amber-200">当前文本生图最高支持 1536 × 1536，请缩小分辨率后创建任务。</p> : null}
    </section>
    <label className="mt-5 block text-sm font-medium">连续生成 <input aria-label="连续生成张数" type="number" min="1" value={count} onChange={(event) => setCount(event.target.value)} className="mx-2 w-24 rounded border border-stone-600 bg-stone-950 px-2 py-1" /> 张</label>
    {error ? <p role="alert" aria-live="assertive" className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">{error}</p> : null}
    <button type="button" aria-busy={busy} disabled={busy || loraBusy || !prompt.trim() || unsupported} onClick={onCreate} className="mt-4 rounded-lg bg-indigo-500 px-5 py-2 font-medium disabled:opacity-40">{busy ? "正在提交…" : "创建图像任务组"}</button>
  </section>;
}

export function ImageResultCard({ group, selected, onSelect, onOpen }: { group: ImageTaskGroup<Task>; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const task = group.tasks.find((item) => item.status === "completed");
  return <button type="button" aria-label={`${title(group)} 成果组`} aria-pressed={selected} onClick={() => { onSelect(); onOpen(); }} className={`relative min-w-0 rounded-xl border p-2 text-left ${selected ? "border-indigo-300 bg-indigo-500/20 shadow-[0_0_18px_rgba(129,140,248,.8)]" : "border-stone-700 bg-stone-900"}`}><span className="absolute right-2 top-2 z-10 rounded bg-black/70 px-1.5 text-xs">{group.completedCount} / {group.requestedCount}</span>{task?.result?.relativeDir ? <img alt={`${title(group)} 缩略图`} src={`/api/local-images/${encodeURIComponent(task.id)}/thumbnail`} className="aspect-square w-full rounded object-cover" /> : <div className="aspect-square rounded bg-stone-800" />}<p className="mt-2 truncate text-xs">{title(group)}</p></button>;
}

export function ImageResultsGallery({ groups, selected, setSelected, open }: { groups: ImageTaskGroup<Task>[]; selected: string | null; setSelected: (id: string) => void; open: (group: ImageTaskGroup<Task>) => void }) {
  return <section className="min-h-[calc(100vh-100px)] p-4" aria-label="成果图库"><header className="mb-4"><h1 className="text-2xl font-semibold">成果</h1><p className="text-sm text-stone-400">按任务组保存，点击图片查看详情。</p></header><div className="grid grid-cols-9 gap-3">{groups.map((group) => <ImageResultCard key={group.id} group={group} selected={selected === group.id} onSelect={() => setSelected(group.id)} onOpen={() => open(group)} />)}</div>{groups.length === 0 ? <p className="text-stone-500">尚无已完成成果。</p> : null}</section>;
}

export function ImageResultModal({ group, busy, onClose, onRegenerate }: { group: ImageTaskGroup<Task>; busy: boolean; onClose: () => void; onRegenerate: (count: string, prompt: string) => void }) {
  const completed = group.tasks.filter((task) => task.status === "completed");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState("1");
  const task = completed[index] ?? completed[0];
  const [promptDraft, setPromptDraft] = useState(() => task?.prompt ?? "");
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  if (!task) return null;
  const promptValid = Boolean(promptDraft.trim()) && promptDraft.length <= 4_000;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={onClose}><section role="dialog" aria-modal="true" aria-label="图像成果详情" aria-busy={busy} onMouseDown={(event) => event.stopPropagation()} className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-stone-600 bg-stone-950 p-5"><div className="flex justify-between"><h2 className="text-xl font-semibold">成果详情</h2><button type="button" onClick={onClose}>关闭</button></div><a href={`/api/local-images/${encodeURIComponent(task.id)}/output`} target="_blank" rel="noreferrer"><img src={`/api/local-images/${encodeURIComponent(task.id)}/output`} alt="原始成果图像" className="mt-4 max-h-[48vh] w-full rounded object-contain" /></a><div className="mt-3 flex gap-2">{completed.map((child, childIndex) => <button type="button" key={child.id} onClick={() => { setIndex(childIndex); setPromptDraft(child.prompt ?? ""); }} className={`rounded px-3 py-2 text-xs ${childIndex === index ? "bg-indigo-500" : "bg-stone-800"}`}>第 {childIndex + 1} 张</button>)}</div><label className="mt-5 block text-sm font-medium">重新生成提示词<textarea aria-label="重新生成提示词" maxLength={4_000} disabled={busy} value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-stone-600 bg-stone-900 p-3 disabled:opacity-60" /></label><p className="mt-1 text-right text-xs text-stone-400">{promptDraft.length} / 4000</p><div className="mt-4 border-t border-stone-700 pt-4"><label>重新生成 <input aria-label="重新生成张数" type="number" min="1" disabled={busy} value={count} onChange={(event) => setCount(event.target.value)} className="mx-2 w-24 rounded border border-stone-600 bg-stone-900 px-2 py-1 disabled:opacity-60" /> 张图片</label><button type="button" aria-busy={busy} disabled={busy || !validCount(count) || !promptValid} onClick={() => onRegenerate(count, promptDraft)} className="ml-2 rounded bg-indigo-500 px-3 py-1 disabled:opacity-40">{busy ? "正在提交…" : "确认"}</button></div></section></div>;
}

export function StudioLogModal({ logs, loading, error, notice, onClose, onCopy, onDownload }: { logs: StudioLogExport | null; loading: boolean; error: string | null; notice: string | null; onClose: () => void; onCopy: () => void; onDownload: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4" onMouseDown={onClose}><section role="dialog" aria-modal="true" aria-label="当下日志" aria-busy={loading} onMouseDown={(event) => event.stopPropagation()} className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-2xl border border-stone-600 bg-stone-950 p-5 shadow-2xl"><header className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">当下日志</h2><p className="mt-1 text-xs text-stone-400">{logs ? `${logs.lineCount} 行 · ${new Date(logs.generatedAt).toLocaleString()}${logs.truncated ? " · 内容已按安全上限截断" : ""}` : "正在读取当前会话的脱敏日志"}</p></div><div className="flex shrink-0 gap-2"><button type="button" disabled={!logs?.text || loading} onClick={onCopy} className="rounded border border-sky-300 px-3 py-1.5 text-sm text-sky-100 disabled:opacity-40">复制</button><button type="button" disabled={!logs?.text || loading} onClick={onDownload} className="rounded border border-emerald-300 px-3 py-1.5 text-sm text-emerald-100 disabled:opacity-40">下载</button><button type="button" onClick={onClose} className="rounded border border-stone-500 px-3 py-1.5 text-sm">关闭</button></div></header>{notice ? <p role="status" aria-live="polite" className="mt-2 text-sm text-emerald-300">{notice}</p> : null}{error ? <p role="alert" className="mt-3 rounded bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}<pre className="mt-4 min-h-72 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-stone-700 bg-black p-4 font-mono text-xs leading-5 text-stone-200">{loading ? "正在读取日志…" : logs?.text || "暂无可用日志。"}</pre><p className="mt-3 text-xs text-stone-500">仅包含当前本地会话的脱敏日志；凭据、签名链接、提示词和密钥不会进入复制或下载内容。</p></section></div>;
}

function GpuClassPanel({ tasks, runner, readiness, batches, price, busy, setPrice, onStart, onStop, onOpenLogs }: { tasks: Task[]; runner: Runner | null; readiness: GpuReadiness; batches: Record<"rtx4090" | "rtx5090", ExecutableBatch>; price: number; busy: boolean; setPrice: (value: number) => void; onStart: (gpu: "rtx4090" | "rtx5090") => void; onStop: () => void; onOpenLogs: () => void }) {
  const running = runner?.state === "running" || runner?.state === "cancelling";
  const safetyBlocked = runner?.error?.isBlocking === true || Boolean(runner?.blocker);
  const counts = { rtx4090: batches.rtx4090.executableCount, rtx5090: batches.rtx5090.executableCount };
  const rentedHost = running && runner?.host?.candidateRole === "rented_host" && Boolean(runner.host.orderId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!rentedHost) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [rentedHost]);
  const rentalClock = rentalClockSnapshot(runner?.rentalTiming, nowMs);
  const rentalElapsed = rentalClock?.elapsed ?? (rentedHost ? "等待账单状态" : "尚未租用");
  const releaseCountdown = rentalClock?.deadlineReached
    ? "正在退租"
    : rentalClock?.countdown ?? (rentedHost ? "保护状态待确认" : "—");
  return <aside className="h-fit border-r border-stone-700 bg-stone-900 p-4 lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto" aria-label="显卡状态"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">显卡状态</h2><span className="rounded bg-stone-800 px-2 py-1 text-xs">{runner?.stage ?? "当前未租用显卡"}</span></div><section className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-stone-700 bg-stone-950/40 p-3 text-xs"><div><span className="block text-stone-400">显卡租用时间</span><b className="mt-1 block font-mono text-sm tabular-nums">{rentalElapsed}</b></div><div><span className="block text-stone-400">退租倒计时（最晚）</span><b className="mt-1 block font-mono text-sm tabular-nums">{releaseCountdown}</b></div></section><section className="mt-3 space-y-2 rounded-lg border border-stone-700 p-3 text-sm"><div className="flex justify-between"><span>待确认任务</span><b>{tasks.filter((task) => task.status === "pending_confirmation").length}</b></div><div className="flex justify-between"><span>RTX 4090 任务</span><b>{counts.rtx4090}</b></div><div className="flex justify-between"><span>RTX 5090 任务</span><b>{counts.rtx5090}</b></div><div className="flex justify-between"><span>已完成 / 失败</span><b>{tasks.filter((task) => task.status === "completed").length} / {tasks.filter((task) => task.status === "failed").length}</b></div></section><section className="mt-3 rounded-lg border border-stone-700 p-3"><label className="block text-sm">最高时价<input aria-label="最高时价" type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(Number(event.target.value))} className="mt-1 w-full rounded border border-stone-600 bg-stone-950 px-2 py-1" /></label><div className="mt-3 grid gap-2"><button type="button" aria-busy={busy} disabled={!readiness.rtx4090.ready || !counts.rtx4090 || running || safetyBlocked || busy} onClick={() => onStart("rtx4090")} className="rounded bg-indigo-500 px-3 py-2 text-sm disabled:opacity-40">确认生成 RTX 4090 任务（{counts.rtx4090}）</button><p className={readiness.rtx4090.ready ? "text-xs text-emerald-300" : "text-xs text-amber-200"}>{readiness.rtx4090.ready ? "RTX 4090 已就绪" : readiness.rtx4090.blocker}</p><button type="button" aria-busy={busy} disabled={!readiness.rtx5090.ready || !counts.rtx5090 || running || safetyBlocked || busy} onClick={() => onStart("rtx5090")} className="rounded border border-violet-300 px-3 py-2 text-sm text-violet-100 disabled:opacity-40">确认生成 RTX 5090 任务（{counts.rtx5090}）</button><p className={readiness.rtx5090.ready ? "text-xs text-emerald-300" : "text-xs text-amber-200"}>{readiness.rtx5090.ready ? "RTX 5090 已就绪" : readiness.rtx5090.blocker}</p></div>{running ? <button type="button" aria-busy={busy} disabled={busy} onClick={onStop} className="mt-2 w-full rounded border border-rose-300 px-3 py-2 text-sm text-rose-100 disabled:opacity-40">{busy ? "正在处理…" : "停止并退租 / 取消本批次"}</button> : null}</section>{runner?.host ? <details className="mt-3 rounded-lg border border-stone-700 p-3 text-xs"><summary>{rentedHost ? "已租用主机" : "当前候选显卡"}</summary><p className="mt-2">{runner.host.gpu ?? "—"} · 主机 {runner.host.serverId ?? "—"} · ${runner.host.priceHourly ?? "—"}/小时</p><p>{runner.host.location ?? "—"} · {runner.host.deploymentState ?? runner.host.orderStatus ?? "—"}</p>{runner.host.candidateAttempts?.length ? <><p className="mt-2">候选尝试：{runner.host.candidateAttempts.map((attempt) => `${attempt.serverId ?? "—"}${attempt.hourlyUsd == null ? "" : ` $${attempt.hourlyUsd}/小时`} ${attempt.event ?? ""}`).join("；")}</p><p>市场刷新：{runner.host.marketplaceRefreshedAt ?? "—"}</p></> : null}</details> : null}{runner?.error?.displayMessage ? <p className="mt-3 rounded bg-rose-500/10 p-2 text-xs text-rose-200">{runner.error.displayMessage}</p> : null}<button type="button" aria-label="查看当下日志" onClick={onOpenLogs} className="mt-3 w-full rounded-lg border border-stone-600 bg-stone-950 p-3 text-left"><span className="flex items-center justify-between"><b>当下日志</b><span className="text-stone-400">点击查看全部</span></span><span className="mt-1 block truncate text-xs text-stone-500">{runner?.stage ?? "当前没有运行记录"}</span></button></aside>;
}

function MultiActiveTaskRail({ groups, selectedIds, toggle, action, confirmSelected, busy }: { groups: ImageTaskGroup<Task>[]; selectedIds: Set<string>; toggle: (id: string) => void; action: (id: string, action: "confirm_group" | "cancel_group" | "unconfirm_group") => void; confirmSelected: () => void; busy: boolean }) {
  const selectedPending = groups.filter((group) => selectedIds.has(group.id) && group.pendingConfirmationCount > 0).length;
  return <aside className="h-fit rounded-2xl border border-stone-700 bg-stone-900 p-4 lg:sticky lg:top-4" aria-label="活动任务"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">活动任务</h2><button type="button" disabled={!selectedPending || busy} onClick={confirmSelected} className="rounded bg-emerald-600 px-2 py-1 text-xs disabled:opacity-40">确认生成{selectedPending ? `（${selectedPending}）` : ""}</button></div><p className="mb-3 text-xs text-stone-400">点击卡片可多选；完成成果在“成果”页查看。</p><div className="space-y-2">{groups.map((group) => { const task = group.tasks[0]; const selected = selectedIds.has(group.id); const canConfirm = group.pendingConfirmationCount > 0; const protectedByExecution = group.generatingCount > 0 || group.tasks.some(hasActiveTaskClaim); const canDelete = group.pendingConfirmationCount > 0 && group.waitingForGpuCount === 0 && !protectedByExecution; const canUnconfirm = group.waitingForGpuCount > 0 && !protectedByExecution; const cancelHint = protectedByExecution ? "任务已开始生成，请使用停止并退租" : group.waitingForGpuCount === 0 ? "尚未确认生成，无需取消" : null; return <article key={group.id} role="button" tabIndex={0} aria-label={`${groupPrompt(group)} 活动任务组`} aria-pressed={selected} onClick={() => toggle(group.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(group.id); } }} className={`cursor-pointer rounded-lg border px-3 py-2 text-left text-xs ${selected ? "border-indigo-300 bg-indigo-500/30 shadow-[0_0_14px_rgba(129,140,248,.65)]" : "border-stone-700 hover:border-stone-500"}`}><p className="line-clamp-2 break-words font-semibold leading-5">{groupPrompt(group)}</p><p className="mt-1 flex justify-between text-stone-400"><span>{groupStatusLabel(group.status)}</span><span>{group.completedCount} / {group.requestedCount}</span></p><div className="mt-2 flex gap-2">{canConfirm ? <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); action(group.id, "confirm_group"); }} className="rounded bg-emerald-600 px-2 py-1 text-xs disabled:opacity-40">确认生成</button> : null}<button type="button" disabled={!canDelete || busy} onClick={(event) => { event.stopPropagation(); action(group.id, "cancel_group"); }} className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-100 disabled:opacity-40">删除</button><button type="button" disabled={!canUnconfirm || busy} onClick={(event) => { event.stopPropagation(); action(group.id, "unconfirm_group"); }} className="rounded border border-amber-300 px-2 py-1 text-xs text-amber-100 disabled:opacity-40">取消任务</button></div>{cancelHint ? <p className="mt-1 text-amber-200">{cancelHint}</p> : null}<p className="mt-1 text-stone-500">{task?.width} × {task?.height}</p></article>; })}{groups.length === 0 ? <p className="text-sm text-stone-500">没有活动任务。</p> : null}</div></aside>;
}

export function ImageCreationStudio() {
  const [tab, setTab] = useState<"prompt" | "results">(() => typeof window !== "undefined" && window.localStorage.getItem(tabKey) === "results" ? "results" : "prompt");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runner, setRunner] = useState<Runner | null>(null);
  const [, setLocalProgram] = useState<LocalProgram | null>(null);
  const [readiness, setReadiness] = useState<GpuReadiness>({ rtx4090: { ready: false, blocker: null }, rtx5090: { ready: false, blocker: null } });
  const [batches, setBatches] = useState<Record<"rtx4090" | "rtx5090", ExecutableBatch>>({ rtx4090: { plannedTaskIds: [], executableCount: 0, excludedInconsistentTaskIds: [] }, rtx5090: { plannedTaskIds: [], executableCount: 0, excludedInconsistentTaskIds: [] } });
  const [price, setPrice] = useState(.6);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [loras, setLoras] = useState<LoraSelection[]>([]);
  const [loraRegistryLoaded, setLoraRegistryLoaded] = useState(false);
  const [loraBusy, setLoraBusy] = useState(false);
  const [loraError, setLoraError] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [resolution, setResolution] = useState<Resolution>({ width: 768, height: 768 });
  const [count, setCount] = useState(() => typeof window === "undefined" ? "1" : window.localStorage.getItem(countKey) ?? "1");
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectedResult, setSelectedResult] = useState<string | null>(null);
  const [modal, setModal] = useState<ImageTaskGroup<Task> | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logNotice, setLogNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<StudioLogExport | null>(null);
  const mutationLock = useRef(false);
  const loraMutationLock = useRef(false);
  const logFetchLock = useRef(false);
  const apply = useCallback((data: Response) => { if (Array.isArray(data.tasks)) setTasks(data.tasks); if (data.runner !== undefined) setRunner(data.runner ? { ...data.runner, stage: data.runner.progress?.displayMessage ?? data.runner.stage } : null); if (data.localProgram !== undefined) setLocalProgram(data.localProgram ?? null); if (data.executionReadiness) setReadiness(data.executionReadiness); if (data.executableBatches) setBatches(data.executableBatches); if (Number.isFinite(data.maxHourlyPrice) && data.maxHourlyPrice! > 0) setPrice(data.maxHourlyPrice!); }, []);
  const applyLoraRegistry = useCallback((items: RegisteredLora[]) => {
    setLoras((current) => mergeLoraSelections(items, current));
    setLoraRegistryLoaded(true);
  }, []);
  const refresh = useCallback(async () => { const { response, data } = await fetchJsonWithTimeout<Response>("/api/local-lab/image-tasks", { cache: "no-store" }, 10_000); if (response.ok) apply(data); }, [apply]);
  const refreshLoras = useCallback(async () => {
    try {
      const { response, data } = await fetchJsonWithTimeout<LoraRegistryResponse>("/api/local-lab/image-loras", { cache: "no-store" }, 20_000);
      if (!response.ok || !Array.isArray(data.items)) throw new Error(data.error ?? "LoRA 列表读取失败");
      applyLoraRegistry(data.items);
      setLoraError(null);
    } catch {
      setLoraRegistryLoaded(false);
      setLoraError("LoRA 列表读取失败；当前不会把未验证项目写入新任务。");
    }
  }, [applyLoraRegistry]);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 5_000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [refresh]);
  useEffect(() => { const initial = window.setTimeout(() => void refreshLoras(), 0); return () => window.clearTimeout(initial); }, [refreshLoras]);
  const groups = useMemo(() => groupImageTasks(tasks), [tasks]);
  const activeGroups = groups.filter((group) => group.isActive);
  const resultGroups = groups.filter((group) => group.completedCount > 0).sort((a, b) => (b.latestCompletedAt ?? "").localeCompare(a.latestCompletedAt ?? ""));
  const effectiveBatches = useMemo(() => ({
    rtx4090: selectStudioExecutableBatch(tasks, selectedIds, "rtx4090", batches.rtx4090),
    rtx5090: selectStudioExecutableBatch(tasks, selectedIds, "rtx5090", batches.rtx5090),
  }), [batches, selectedIds, tasks]);
  const post = async (body: Record<string, unknown>) => { const { response, data } = await fetchJsonWithTimeout<Response & { error?: string }>("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 60_000); apply(data); return { ok: response.ok, data }; };
  const mutateLoraRegistry = async (body: Record<string, unknown>) => {
    if (loraMutationLock.current) return false;
    loraMutationLock.current = true;
    setLoraBusy(true);
    setLoraError(null);
    try {
      const { response, data } = await fetchJsonWithTimeout<LoraRegistryResponse>("/api/local-lab/image-loras", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 90_000);
      if (!response.ok || !Array.isArray(data.items)) {
        setLoraError(data.error ?? "LoRA 注册失败，请检查链接格式、模型访问权限或稍后重试。");
        return false;
      }
      applyLoraRegistry(data.items);
      return true;
    } catch {
      setLoraError("LoRA 注册请求超时或网络中断，请稍后重试。");
      return false;
    } finally {
      loraMutationLock.current = false;
      setLoraBusy(false);
    }
  };
  const addLora = async (request: AddLoraRequest) => await mutateLoraRegistry({ action: "add", ...request });
  const updateLora = async (id: string, name: string, defaultStrength: number) => await mutateLoraRegistry({ action: "update", id, name, defaultStrength });
  const runMutation = async (operation: () => Promise<void>) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setActionBusy(true);
    try {
      await operation();
    } catch {
      await refresh().catch(() => undefined);
      setError("请求没有完成，请查看当下日志后重试。");
    } finally {
      mutationLock.current = false;
      setActionBusy(false);
    }
  };
  const create = async () => {
    const requestedCount = validCount(count);
    if (!requestedCount) { setError("连续生成数量必须是正的安全整数。"); return; }
    if (!prompt.trim()) return;
    const submittedPrompt = prompt;
    const submittedNegativePrompt = negativePrompt;
    const submittedLoras = loras
      .filter(selectableLora)
      .map(({ id, name, filename, strength, enabled }) => ({ id, name, filename, strength, enabled }));
    await runMutation(async () => {
      const result = await post({
        action: "create_group",
        prompt: submittedPrompt,
        negativePrompt: submittedNegativePrompt,
        ...(loraRegistryLoaded ? { loras: submittedLoras } : {}),
        referenceImage,
        width: resolution.width,
        height: resolution.height,
        ...settings,
        requestedCount,
      });
      if (!result.ok) { setError(result.data.error ?? "创建任务组失败。"); return; }
      window.localStorage.setItem(countKey, String(requestedCount));
      setError(null);
      setSelectedIds(new Set(result.data.groupId ? [result.data.groupId] : []));
      setPrompt((current) => current === submittedPrompt ? "" : current);
      setNegativePrompt((current) => current === submittedNegativePrompt ? "" : current);
    });
  };
  const groupAction = async (id: string, action: "confirm_group" | "cancel_group" | "unconfirm_group") => {
    if (action !== "cancel_group") setSelectedIds(new Set([id]));
    await runMutation(async () => {
      const result = await post({ action, groupId: id });
      setError(result.data.error ?? result.data.groupAction?.blocker ?? null);
      if (action === "cancel_group" && result.ok) {
        setSelectedIds((ids) => {
          const next = new Set(ids);
          next.delete(id);
          return next;
        });
      }
    });
  };
  const confirmSelected = async () => {
    const requestedIds = [...selectedIds].filter((id) =>
      activeGroups.some((candidate) => candidate.id === id && candidate.pendingConfirmationCount > 0));
    if (!requestedIds.length) return;
    // Keep explicit-selection mode armed even when one confirmation fails, so
    // the paid button can never fall through to an unrelated old queue.
    setSelectedIds(new Set(requestedIds));
    await runMutation(async () => {
      const confirmedIds: string[] = [];
      for (const id of requestedIds) {
        const group = activeGroups.find((candidate) => candidate.id === id);
        if (!group?.pendingConfirmationCount) continue;
        const result = await post({ action: "confirm_group", groupId: id });
        if (!result.ok) { setError(result.data.error ?? "确认任务失败。"); break; }
        confirmedIds.push(id);
      }
      if (confirmedIds.length === requestedIds.length) setSelectedIds(new Set(confirmedIds));
    });
  };
  const toggle = (id: string) => setSelectedIds((ids) => { const next = new Set(ids); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const changeTab = (value: "prompt" | "results") => { setTab(value); window.localStorage.setItem(tabKey, value); };
  const regenerate = async (value: string, promptDraft: string) => {
    const requestedCount = validCount(value);
    if (!requestedCount || !modal || !promptDraft.trim()) return;
    await runMutation(async () => {
      const result = await post({ action: "regenerate_group", groupId: modal.id, requestedCount, prompt: promptDraft });
      if (!result.ok) { setError(result.data.error ?? "重新生成任务创建失败。"); return; }
      setSelectedIds((ids) => new Set([...ids, result.data.groupId ?? modal.id]));
      setModal(null);
      setError(null);
      changeTab("prompt");
    });
  };
  const start = async (gpu: "rtx4090" | "rtx5090") => {
    const ids = effectiveBatches[gpu].plannedTaskIds;
    if (!ids.length) return;
    await runMutation(async () => {
      const result = await post({ action: "start_batch", taskIds: ids, maxHourlyPrice: price });
      setError(result.ok ? null : result.data.error ?? "启动生成失败。");
    });
  };
  const stop = async () => {
    await runMutation(async () => {
      const result = await post({ action: "cancel_batch" });
      setError(result.ok ? null : result.data.error ?? "停止并退租失败。");
    });
  };
  const openLogs = async () => {
    setLogOpen(true);
    setLogNotice(null);
    if (logFetchLock.current) return;
    logFetchLock.current = true;
    setLogLoading(true);
    setLogError(null);
    try {
      const { response, data } = await fetchJsonWithTimeout<{ logs?: StudioLogExport; error?: string }>("/api/local-lab/image-tasks?view=logs", { cache: "no-store" }, 15_000);
      if (!response.ok || !data.logs) throw new Error(data.error ?? "日志读取失败");
      setLogs(data.logs);
    } catch {
      setLogError("日志读取失败，请关闭后重新打开。");
    } finally {
      logFetchLock.current = false;
      setLogLoading(false);
    }
  };
  const closeResult = useCallback(() => setModal(null), []);
  const closeLogs = useCallback(() => setLogOpen(false), []);
  const copyLogs = async () => {
    if (!logs?.text) return;
    try {
      await navigator.clipboard.writeText(logs.text);
      setLogNotice("日志已复制。");
    } catch {
      setLogNotice("浏览器没有允许复制，请使用下载。");
    }
  };
  const downloadLogs = () => {
    if (!logs?.text) return;
    const url = URL.createObjectURL(new Blob([logs.text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = logs.filename.replace(/[^A-Za-z0-9._-]/g, "_");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setLogNotice("日志下载已开始。");
  };
  return <main className="image-studio-interactions min-h-screen bg-stone-950 text-stone-100"><ImageStudioNavigation tab={tab} onChange={changeTab} activeCount={activeGroups.length} resultCount={resultGroups.length} />{actionBusy ? <div role="status" aria-live="polite" className="fixed right-4 top-4 z-40 rounded-lg border border-indigo-300/60 bg-stone-950 px-4 py-2 text-sm shadow-xl">正在处理，请勿重复点击…</div> : null}{tab === "prompt" ? <div className="mx-auto grid min-h-screen max-w-[1600px] lg:grid-cols-[320px_minmax(0,1fr)_360px]"><GpuClassPanel tasks={tasks} runner={runner} readiness={readiness} batches={effectiveBatches} price={price} busy={actionBusy} setPrice={setPrice} onStart={(gpu) => void start(gpu)} onStop={() => void stop()} onOpenLogs={() => void openLogs()} /><ImagePromptWorkspace resolution={resolution} setResolution={setResolution} prompt={prompt} setPrompt={setPrompt} negativePrompt={negativePrompt} setNegativePrompt={setNegativePrompt} referenceImage={referenceImage} setReferenceImage={setReferenceImage} settings={settings} setSettings={setSettings} loras={loras} setLoras={setLoras} loraRegistryLoaded={loraRegistryLoaded} loraBusy={loraBusy} loraError={loraError} onAddLora={addLora} onUpdateLora={updateLora} count={count} setCount={setCount} error={error} busy={actionBusy} onCreate={() => void create()} /><MultiActiveTaskRail groups={activeGroups} selectedIds={selectedIds} toggle={toggle} action={(id, action) => void groupAction(id, action)} confirmSelected={() => void confirmSelected()} busy={actionBusy} /></div> : <ImageResultsGallery groups={resultGroups} selected={selectedResult} setSelected={setSelectedResult} open={setModal} />}{modal ? <ImageResultModal group={groups.find((group) => group.id === modal.id) ?? modal} busy={actionBusy} onClose={closeResult} onRegenerate={(value, promptDraft) => void regenerate(value, promptDraft)} /> : null}{logOpen ? <StudioLogModal logs={logs} loading={logLoading} error={logError} notice={logNotice} onClose={closeLogs} onCopy={() => void copyLogs()} onDownload={downloadLogs} /> : null}</main>;
}
