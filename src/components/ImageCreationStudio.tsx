"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupImageTasks, type GroupableImageTask, type ImageTaskGroup } from "@/lib/image-generation/image-task-groups";
import { safeFixed } from "@/lib/image-generation/formatters";

type Result = { width?: number; height?: number; completedAt?: string; persistedAt?: string; pngSha256?: string; sha256?: string; relativeDir?: string };
type Task = GroupableImageTask & {
  referenceImage?: string | null; steps?: number | string | null; cfg?: number | string | null; loraStrength?: number | string | null;
  sampler?: string | null; seed?: number; gpuClass?: "rtx4090" | "rtx5090" | null; result?: Result;
};
type Runner = { state?: string; stage?: string; frozenTaskIds?: string[]; currentTaskIndex?: number | null; host?: { orderId?: string | null; serverId?: string | null; gpu?: string | null; priceHourly?: number | null; controllerUrl?: string | null } | null; error?: { message?: string } | null };
type Response = { tasks?: Task[]; runner?: Runner; executionReady?: boolean };
type Settings = { steps: number; loraStrength: number; cfg: number; sampler: "Euler" | "FlowMatch" };
type Point = [number, number];

const initialSettings: Settings = { steps: 30, loraStrength: 0.8, cfg: 4, sampler: "FlowMatch" };
const cells = Array.from({ length: 64 }, (_, index) => [index % 8, Math.floor(index / 8)] as Point);
const tabKey = "image-studio-selected-tab";
const countKey = "image-studio-generation-count";

function validCount(value: string | number) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}
function rectangle(start: Point, end: Point) {
  const left = Math.min(start[0], end[0]); const top = Math.min(start[1], end[1]);
  const widthCells = Math.max(3, Math.abs(end[0] - start[0]) + 1); const heightCells = Math.max(3, Math.abs(end[1] - start[1]) + 1);
  return { left, top, right: left + widthCells - 1, bottom: top + heightCells - 1, width: widthCells * 256, height: heightCells * 256 };
}
function display(value: string | undefined | null) { return value ? new Date(value).toLocaleString() : "—"; }
function title(group: ImageTaskGroup<Task>) { return group.title || "未命名图像组"; }

export function ImageStudioNavigation({ tab, onChange }: { tab: "prompt" | "results"; onChange: (tab: "prompt" | "results") => void }) {
  return <nav className="flex gap-2 border-b border-stone-700 px-4 pt-4" aria-label="图像工作区导航">
    <button type="button" aria-pressed={tab === "prompt"} onClick={() => onChange("prompt")} className={`rounded-t-lg px-4 py-2 text-sm ${tab === "prompt" ? "bg-indigo-500 text-white" : "bg-stone-800 text-stone-300"}`}>提示词</button>
    <button type="button" aria-pressed={tab === "results"} onClick={() => onChange("results")} className={`rounded-t-lg px-4 py-2 text-sm ${tab === "results" ? "bg-indigo-500 text-white" : "bg-stone-800 text-stone-300"}`}>成果</button>
  </nav>;
}

function ComputerPanel({ tasks, runner }: { tasks: Task[]; runner: Runner | null }) {
  return <aside className="h-fit rounded-2xl border border-stone-700 bg-stone-900 p-4 lg:sticky lg:top-4" aria-label="当前电脑情况">
    <h2 className="text-lg font-semibold">当前电脑情况</h2>
    <p className="mt-2 text-sm text-stone-300">GPU / 运行环境：{runner?.state ?? "空闲"}</p>
    <p className="mt-1 text-xs text-stone-400">阶段：{runner?.stage ?? "当前未租用显卡"}</p>
    <dl className="mt-4 grid grid-cols-2 gap-2 text-xs"><dt>待处理</dt><dd>{tasks.filter((task) => task.status !== "completed").length}</dd><dt>已完成</dt><dd>{tasks.filter((task) => task.status === "completed").length}</dd><dt>订单</dt><dd>{runner?.host?.orderId ?? "无"}</dd><dt>主机</dt><dd>{runner?.host?.serverId ?? "—"}</dd></dl>
    {runner?.error?.message ? <p className="mt-4 rounded bg-rose-500/10 p-2 text-xs text-rose-200">{runner.error.message}</p> : null}
  </aside>;
}

export function ActiveImageTaskRail({ groups }: { groups: ImageTaskGroup<Task>[] }) {
  return <aside className="rounded-2xl border border-stone-700 bg-stone-900 p-4" aria-label="活动任务组">
    <h2 className="font-semibold">活动任务组</h2><p className="mb-3 text-xs text-stone-400">仅显示仍在执行流程中的图像组</p>
    <div className="space-y-3">{groups.length ? groups.map((group) => {
      const generating = group.tasks.find((task) => task.status === "generating"); const representative = group.tasks[0];
      return <article key={group.id} className="rounded-xl border border-stone-700 p-3 text-xs"><b>{title(group)}</b><p className="mt-1 text-stone-400">{representative?.width} × {representative?.height}{representative?.referenceImage ? " · 有参考图" : ""}</p><p className="mt-2 text-emerald-300">已完成 {group.completedCount} / {group.requestedCount}</p><p className="text-stone-300">待处理 {group.pendingCount} · 生成中 {group.generatingCount} · 失败 {group.failedCount}</p>{generating ? <p className="mt-1 text-indigo-200">正在生成第 {generating.groupIndex ?? 1} 张</p> : null}</article>;
    }) : <p className="text-sm text-stone-500">没有活动任务组。</p>}</div>
  </aside>;
}

export function ImagePromptWorkspace({ selection, prompt, setPrompt, referenceImage, setReferenceImage, settings, setSettings, count, setCount, error, onCreate }: {
  selection: ReturnType<typeof rectangle>; prompt: string; setPrompt: (value: string) => void; referenceImage: string | null; setReferenceImage: (value: string | null) => void; settings: Settings; setSettings: (value: Settings) => void; count: string; setCount: (value: string) => void; error: string | null; onCreate: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const readFile = (file: File) => { if (!file.type.startsWith("image/")) return; const reader = new FileReader(); reader.onload = () => setReferenceImage(String(reader.result)); reader.readAsDataURL(file); };
  return <section className="rounded-2xl border border-stone-700 bg-stone-900 p-5">
    <h1 className="text-2xl font-semibold">图像工作台</h1><p className="mt-1 text-sm text-stone-400">创建本地任务组不会自动开始 GPU 执行。</p>
    <label className="mt-5 block text-sm font-medium">提示词<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-stone-600 bg-stone-950 p-3" placeholder="描述想要创建的图像" /></label>
    <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) readFile(file); }} onClick={() => input.current?.click()} className="mt-3 cursor-pointer rounded-lg border border-dashed border-stone-600 p-3 text-sm text-stone-400">参考图 / 首帧图（可选）：点击、拖入或粘贴{referenceImage ? <img src={referenceImage} alt="参考图预览" className="mt-2 max-h-40 rounded" /> : null}<input ref={input} className="hidden" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); }} /></div>
    <div className="mt-4 grid gap-3 md:grid-cols-2"><label>步数 {settings.steps}<input className="w-full" type="range" min="25" max="40" value={settings.steps} onChange={(event) => setSettings({ ...settings, steps: Number(event.target.value) })} /></label><label>LoRA 强度 {safeFixed(settings.loraStrength, 1)}<input className="w-full" type="range" min="0.6" max="1.1" step="0.1" value={settings.loraStrength} onChange={(event) => setSettings({ ...settings, loraStrength: Number(event.target.value) })} /></label><label>CFG {safeFixed(settings.cfg, 1)}<input className="w-full" type="range" min="3.5" max="5" step="0.1" value={settings.cfg} onChange={(event) => setSettings({ ...settings, cfg: Number(event.target.value) })} /></label><div><p>采样器</p>{(["Euler", "FlowMatch"] as const).map((sampler) => <button type="button" key={sampler} onClick={() => setSettings({ ...settings, sampler })} className={`mr-2 mt-2 rounded px-3 py-1 ${settings.sampler === sampler ? "bg-indigo-500" : "bg-stone-700"}`}>{sampler}</button>)}</div></div>
    <div className="mt-5"><b>分辨率：{selection.width} × {selection.height}</b><div className="mt-2 grid max-w-md grid-cols-8 gap-1">{cells.map(([x, y]) => <span key={`${x}-${y}`} className={`aspect-square rounded-sm ${x >= selection.left && x <= selection.right && y >= selection.top && y <= selection.bottom ? "bg-indigo-400" : "bg-stone-700"}`} />)}</div></div>
    <label className="mt-5 block text-sm font-medium">连续生成 <input aria-label="连续生成张数" type="number" min="1" value={count} onChange={(event) => setCount(event.target.value)} className="mx-2 w-24 rounded border border-stone-600 bg-stone-950 px-2 py-1" /> 张</label>
    {error ? <p className="mt-2 text-sm text-rose-200">{error}</p> : null}<button disabled={!prompt.trim()} onClick={onCreate} className="mt-4 rounded-lg bg-indigo-500 px-5 py-2 font-medium disabled:opacity-40">创建图像任务组</button>
  </section>;
}

export function ImageResultCard({ group, selected, onSelect, onOpen }: { group: ImageTaskGroup<Task>; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const completed = group.tasks.filter((task) => task.status === "completed"); const task = completed[0]; const compactTitle = Array.from(title(group)); const shortened = compactTitle.length > 12 ? `${compactTitle.slice(0, 12).join("")}…` : compactTitle.join("");
  return <button type="button" aria-label={`${title(group)} 成果组`} aria-pressed={selected} onClick={onSelect} onDoubleClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onOpen(); } }} className={`group relative min-w-0 rounded-xl border p-2 text-left transition ${selected ? "border-indigo-300 bg-indigo-500/20 shadow-[0_0_18px_rgba(129,140,248,.8)]" : "border-stone-700 bg-stone-900 hover:border-stone-500"}`}>
    <span className="absolute right-2 top-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-xs">{group.completedCount < group.requestedCount ? `${group.completedCount} / ${group.requestedCount}` : group.completedCount}</span>
    {task?.result?.relativeDir ? <img alt={`${shortened} 缩略图`} src={`/api/local-images/${encodeURIComponent(task.id)}/thumbnail`} className="aspect-square w-full rounded object-cover" /> : <div className="aspect-square rounded bg-stone-800" />}
    <p className="mt-2 truncate text-xs">{shortened}</p><p className="text-xs text-stone-400">{task?.width} × {task?.height}</p>
  </button>;
}

export function ImageResultsGallery({ groups, selected, setSelected, open }: { groups: ImageTaskGroup<Task>[]; selected: string | null; setSelected: (id: string) => void; open: (group: ImageTaskGroup<Task>) => void }) {
  return <section className="min-h-[calc(100vh-100px)] p-4" aria-label="成果图库"><header className="mb-4"><h1 className="text-2xl font-semibold">成果</h1><p className="text-sm text-stone-400">按任务组保存，单击选择，双击或 Enter 查看详情。</p></header><div className="grid grid-cols-9 gap-3">{groups.map((group) => <ImageResultCard key={group.id} group={group} selected={selected === group.id} onSelect={() => setSelected(group.id)} onOpen={() => open(group)} />)}</div>{groups.length === 0 ? <p className="text-stone-500">尚无已完成成果。</p> : null}</section>;
}

export function ImageResultModal({ group, onClose, onRegenerate }: { group: ImageTaskGroup<Task>; onClose: () => void; onRegenerate: (count: string) => void }) {
  const completed = group.tasks.filter((task) => task.status === "completed"); const [index, setIndex] = useState(0); const [count, setCount] = useState("1"); const cardRef = useRef<HTMLButtonElement>(null); const task = completed[index] ?? completed[0];
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; const old = document.body.style.overflow; document.body.style.overflow = "hidden"; window.addEventListener("keydown", close); return () => { document.body.style.overflow = old; window.removeEventListener("keydown", close); }; }, [onClose]);
  if (!task) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation" onMouseDown={onClose}><section role="dialog" aria-modal="true" aria-label="图像成果详情" onMouseDown={(event) => event.stopPropagation()} className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-stone-600 bg-stone-950 p-5"><div className="flex justify-between"><h2 className="text-xl font-semibold">成果详情</h2><button type="button" onClick={onClose}>关闭</button></div><a href={`/api/local-images/${encodeURIComponent(task.id)}/output`} target="_blank" rel="noreferrer"><img src={`/api/local-images/${encodeURIComponent(task.id)}/output`} alt="原始成果图像" className="mt-4 max-h-[48vh] w-full rounded object-contain" /></a><p className="mt-2 text-sm text-stone-300">{index + 1} / {completed.length}</p><div className="mt-3 flex gap-2 overflow-x-auto">{completed.map((child, childIndex) => <button ref={childIndex === index ? cardRef : undefined} type="button" key={child.id} onClick={() => setIndex(childIndex)} className={`rounded px-3 py-2 text-xs ${childIndex === index ? "bg-indigo-500" : "bg-stone-800"}`}>第 {childIndex + 1} 张</button>)}</div><dl className="mt-5 grid gap-2 text-sm md:grid-cols-2"><dt>提示词</dt><dd className="break-words">{task.prompt}</dd><dt>分辨率</dt><dd>{task.width} × {task.height}</dd><dt>步数 / CFG</dt><dd>{task.steps} / {task.cfg}</dd><dt>LoRA / 采样器</dt><dd>{task.loraStrength} / {task.sampler}</dd><dt>种子</dt><dd>{task.seed ?? "—"}</dd><dt>创建 / 完成</dt><dd>{display(task.createdAt)} / {display(task.result?.completedAt ?? task.result?.persistedAt)}</dd><dt>本地制品</dt><dd>{task.result?.pngSha256 ?? task.result?.sha256 ?? "已验证本地输出"}</dd></dl>{task.referenceImage ? <img src={task.referenceImage} alt="参考图" className="mt-4 max-h-40 rounded" /> : null}<div className="mt-6 border-t border-stone-700 pt-4"><label>重新生成 <input aria-label="重新生成张数" type="number" min="1" value={count} onChange={(event) => setCount(event.target.value)} className="mx-2 w-24 rounded border border-stone-600 bg-stone-900 px-2 py-1" /> 张图片</label><button type="button" onClick={() => onRegenerate(count)} className="ml-2 rounded bg-indigo-500 px-3 py-1">确认</button></div></section></div>;
}

export function ImageCreationStudio() {
  const [tab, setTab] = useState<"prompt" | "results">(() => typeof window !== "undefined" && window.localStorage.getItem(tabKey) === "results" ? "results" : "prompt"); const [tasks, setTasks] = useState<Task[]>([]); const [runner, setRunner] = useState<Runner | null>(null); const [prompt, setPrompt] = useState(""); const [referenceImage, setReferenceImage] = useState<string | null>(null); const [settings, setSettings] = useState<Settings>(initialSettings); const [count, setCount] = useState(() => { const saved = typeof window === "undefined" ? null : window.localStorage.getItem(countKey); return validCount(saved ?? "") === null ? "1" : saved!; }); const [countError, setCountError] = useState<string | null>(null); const [corner] = useState<Point>([0, 0]); const [hover] = useState<Point>([2, 2]); const [selected, setSelected] = useState<string | null>(null); const [modal, setModal] = useState<ImageTaskGroup<Task> | null>(null); const lastCard = useRef<HTMLElement | null>(null);
  const selection = rectangle(corner, hover);
  const applyResponse = useCallback((data: Response) => { if (Array.isArray(data.tasks)) setTasks(data.tasks); if (data.runner !== undefined) setRunner(data.runner ?? null); }, []);
  const refresh = useCallback(async () => { const response = await fetch("/api/local-lab/image-tasks", { cache: "no-store" }); if (response.ok) applyResponse(await response.json() as Response); }, [applyResponse]);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 5000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [refresh]);
  const changeTab = (next: "prompt" | "results") => { setTab(next); window.localStorage.setItem(tabKey, next); };
  const groups = useMemo(() => groupImageTasks(tasks), [tasks]); const activeGroups = groups.filter((group) => group.isActive); const resultGroups = groups.filter((group) => group.completedCount > 0).sort((a, b) => (b.latestCompletedAt ?? "").localeCompare(a.latestCompletedAt ?? ""));
  const create = async () => { const requestedCount = validCount(count); if (!requestedCount) { setCountError("连续生成数量必须是正的安全整数。"); return; } if (!prompt.trim()) return; const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create_group", prompt, referenceImage, width: selection.width, height: selection.height, ...settings, requestedCount }) }); if (!response.ok) { setCountError("创建任务组失败。"); return; } const data = await response.json() as Response & { groupId?: string }; applyResponse(data); window.localStorage.setItem(countKey, String(requestedCount)); setCountError(null); setSelected(data.groupId ?? null); setPrompt(""); };
  const regenerate = async (value: string) => { const requestedCount = validCount(value); if (!requestedCount || !modal) return; const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "regenerate_group", groupId: modal.id, requestedCount }) }); if (!response.ok) return; applyResponse(await response.json() as Response); setModal(null); changeTab("prompt"); };
  return <main className="min-h-screen bg-stone-950 text-stone-100"><ImageStudioNavigation tab={tab} onChange={changeTab} />{tab === "prompt" ? <div className="mx-auto grid max-w-[1600px] gap-4 p-4 lg:grid-cols-[280px_minmax(0,1fr)_340px]"><ComputerPanel tasks={tasks} runner={runner} /><ImagePromptWorkspace selection={selection} prompt={prompt} setPrompt={setPrompt} referenceImage={referenceImage} setReferenceImage={setReferenceImage} settings={settings} setSettings={setSettings} count={count} setCount={setCount} error={countError} onCreate={() => void create()} /><ActiveImageTaskRail groups={activeGroups} /></div> : <ImageResultsGallery groups={resultGroups} selected={selected} setSelected={(id) => { lastCard.current = document.activeElement as HTMLElement; setSelected(id); }} open={(group) => { lastCard.current = document.activeElement as HTMLElement; setModal(group); }} />}{modal ? <ImageResultModal group={groups.find((group) => group.id === modal.id) ?? modal} onClose={() => { setModal(null); lastCard.current?.focus(); }} onRegenerate={(value) => void regenerate(value)} /> : null}</main>;
}
