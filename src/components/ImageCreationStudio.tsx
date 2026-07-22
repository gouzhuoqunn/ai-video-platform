"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Task = {
  id: string;
  prompt: string;
  referenceImage: string | null;
  steps: number;
  loraStrength: number;
  cfg: number;
  sampler: "Euler" | "FlowMatch";
  width: number;
  height: number;
  gpuClass: "rtx4090" | "rtx5090";
  badge: "低" | "高";
  status: string;
  attempts: number;
};

type Point = [number, number];

const initialSettings: { steps: number; loraStrength: number; cfg: number; sampler: "Euler" | "FlowMatch" } = { steps: 30, loraStrength: 0.8, cfg: 4, sampler: "FlowMatch" };
const cells = Array.from({ length: 64 }, (_, index) => [index % 8, Math.floor(index / 8)] as Point);

function rectangle(start: Point, end: Point) {
  const left = Math.min(start[0], end[0]);
  const right = Math.max(start[0], end[0]);
  const top = Math.min(start[1], end[1]);
  const bottom = Math.max(start[1], end[1]);
  const widthCells = Math.max(3, right - left + 1);
  const heightCells = Math.max(3, bottom - top + 1);
  return { left, right: left + widthCells - 1, top, bottom: top + heightCells - 1, width: widthCells * 256, height: heightCells * 256 };
}

export function ImageCreationStudio() {
  const [prompt, setPrompt] = useState("");
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [corner, setCorner] = useState<Point | null>([0, 0]);
  const [hover, setHover] = useState<Point>([2, 2]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selection = rectangle(corner ?? [0, 0], hover);
  const gpuClass = selection.width <= 1280 && selection.height <= 1280 ? "rtx4090" : "rtx5090";

  const refresh = useCallback(async () => {
    const response = await fetch("/api/local-lab/image-tasks", { cache: "no-store" });
    if (response.ok) setTasks((await response.json()).tasks as Task[]);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const readFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setReferenceImage(String(reader.result));
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((candidate) => candidate.type.startsWith("image/"));
      if (file) { event.preventDefault(); readFile(file); }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);

  const mutate = async (action: "confirm" | "retry" | "delete", id: string) => {
    const response = await fetch("/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id }) });
    if (response.ok) setTasks((await response.json()).tasks as Task[]);
  };

  const create = async () => {
    if (!prompt.trim()) return;
    const response = await fetch("/api/local-lab/image-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", prompt, referenceImage, width: selection.width, height: selection.height, ...settings }),
    });
    if (response.ok) {
      const data = await response.json() as { task: Task; tasks: Task[] };
      setTasks(data.tasks); setSelected(data.task.id); setPrompt("");
    }
  };

  const clickCell = (point: Point) => {
    if (corner === null) { setCorner(point); setHover(point); return; }
    setHover(point);
    setCorner(null);
  };

  return (
    <main className="min-h-screen bg-stone-950 p-4 text-stone-100">
      <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-stone-700 bg-stone-900 p-5">
          <header className="mb-5 flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">图像工作台</h1><p className="text-sm text-stone-400">FLUX.1-dev FP8 · Fluxed Up 10.2 · AIDMA NSFW Unlock LoRA</p></div><span className="rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">仅图像</span></header>
          <label className="block text-sm font-medium">提示词<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-stone-600 bg-stone-950 p-3" placeholder="描述想要创建，或基于参考图编辑的图像…" /></label>
          <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) readFile(file); }} onClick={() => inputRef.current?.click()} className="mt-3 cursor-pointer rounded-lg border border-dashed border-stone-600 p-3 text-sm text-stone-400">参考图（可选）：点击、拖入或直接粘贴。{referenceImage && <img src={referenceImage} alt="参考图预览" className="mt-2 max-h-40 rounded" />}<input ref={inputRef} className="hidden" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); }} /></div>
          <p className="mt-2 text-xs text-stone-400">有参考图时，任务会按 FLUX Kontext 的参考感知编辑处理，优先保留主体身份和关键视觉特征，除非提示词要求改变。</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label>步数 {settings.steps}<input className="w-full" type="range" min="25" max="40" step="1" value={settings.steps} onChange={(event) => setSettings({ ...settings, steps: Number(event.target.value) })} /></label>
            <label>LoRA 强度 {settings.loraStrength.toFixed(1)}<input className="w-full" type="range" min="0.6" max="1.1" step="0.1" value={settings.loraStrength} onChange={(event) => setSettings({ ...settings, loraStrength: Number(event.target.value) })} /></label>
            <label>CFG {settings.cfg.toFixed(1)}<input className="w-full" type="range" min="3.5" max="5" step="0.1" value={settings.cfg} onChange={(event) => setSettings({ ...settings, cfg: Number(event.target.value) })} /></label>
            <div><p className="mb-1">采样器</p>{(["Euler", "FlowMatch"] as const).map((sampler) => <button key={sampler} onClick={() => setSettings({ ...settings, sampler })} className={`mr-2 rounded px-3 py-1 ${settings.sampler === sampler ? "bg-indigo-500" : "bg-stone-700"}`}>{sampler}</button>)}</div>
          </div>
          <div className="mt-5"><div className="mb-2 flex justify-between"><b>分辨率：{selection.width} × {selection.height}</b><span className={gpuClass === "rtx4090" ? "text-sky-300" : "text-violet-300"}>{gpuClass === "rtx4090" ? "低 · RTX 4090" : "高 · RTX 5090"}</span></div><div className="grid w-full max-w-md grid-cols-8 gap-1">{cells.map(([x, y]) => { const active = x >= selection.left && x <= selection.right && y >= selection.top && y <= selection.bottom; return <button aria-label={`${x + 1} by ${y + 1} grid cell`} onMouseEnter={() => corner && setHover([x, y])} onClick={() => clickCell([x, y])} key={`${x}-${y}`} className={`aspect-square rounded-sm ${active ? "bg-indigo-400" : "bg-stone-700 hover:bg-stone-500"}`} />; })}</div><p className="mt-2 text-xs text-stone-400">点击一个角，再悬停预览并点击对角完成。每格 256px；最小 3×3（768×768），最大 8×8（2048×2048）。{corner ? "正在选择第二个角。" : "点击任意格开始新的选择。"}</p></div>
          <button disabled={!prompt.trim()} onClick={() => void create()} className="mt-5 rounded-lg bg-indigo-500 px-5 py-2 font-medium disabled:opacity-40">创建图像任务</button>
        </section>
        <aside className="rounded-2xl border border-stone-700 bg-stone-900 p-4"><h2 className="font-semibold">图像任务池</h2><p className="mb-3 text-xs text-stone-400">{tasks.length} 项 · 仅图像</p><div className="space-y-2">{tasks.map((task) => <article onClick={() => setSelected(task.id)} key={task.id} className={`cursor-pointer rounded-lg border p-3 text-xs ${selected === task.id ? "border-indigo-400 bg-indigo-500/10" : "border-stone-700"}`}><div className="flex justify-between"><span className={task.badge === "低" ? "text-sky-300" : "text-violet-300"}>{task.badge} · {task.gpuClass.toUpperCase()}</span><span>{task.status}</span></div><p className="mt-1 line-clamp-2">{task.prompt}</p><p className="mt-1 text-stone-400">{task.width}×{task.height} · {task.steps}步 · {task.sampler} · LoRA {task.loraStrength.toFixed(1)} · CFG {task.cfg.toFixed(1)}{task.referenceImage ? " · 参考图" : ""}</p><div className="mt-2 flex gap-2"><button onClick={(event) => { event.stopPropagation(); void mutate("confirm", task.id); }}>确认</button><button onClick={(event) => { event.stopPropagation(); void mutate("retry", task.id); }}>重试</button><button className="text-rose-300" onClick={(event) => { event.stopPropagation(); void mutate("delete", task.id); }}>删除</button></div></article>)}</div></aside>
      </div>
    </main>
  );
}
