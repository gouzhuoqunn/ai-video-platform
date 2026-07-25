import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type LocalUiHandle = { started: boolean; pid: number | null; stop: () => void; logs: () => string };
export async function probeLocalUi(baseUrl = "http://127.0.0.1:3000") { try { const r = await fetch(baseUrl, { signal: AbortSignal.timeout(3_000) }); return r.ok; } catch { return false; } }
export async function ensureLocalUi(input: { baseUrl?: string; spawnImpl?: typeof spawn; timeoutMs?: number; onPid?: (pid: number) => void }) : Promise<LocalUiHandle> {
  const baseUrl = input.baseUrl ?? "http://127.0.0.1:3000"; if (await probeLocalUi(baseUrl)) return { started: false, pid: null, stop: () => undefined, logs: () => "" };
  const child = (input.spawnImpl ?? spawn)(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/c", "npm", "run", "dev:local"] : ["run", "dev:local"], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout?.on("data", (v) => { logs = (logs + v).slice(-6000); }); child.stderr?.on("data", (v) => { logs = (logs + v).slice(-6000); }); if (child.pid) input.onPid?.(child.pid);
  const deadline = Date.now() + (input.timeoutMs ?? 60_000); while (Date.now() < deadline) { if (await probeLocalUi(baseUrl)) return { started: true, pid: child.pid ?? null, stop: () => { if (!child.killed) child.kill(); }, logs: () => logs }; await new Promise((r) => setTimeout(r, 1000)); }
  if (!child.killed) child.kill(); throw new Error(`local_ui_start_timeout:${logs.slice(-500)}`);
}
export async function verifyImageUi(input: { taskId: string; baseUrl?: string; screenshotPath?: string }) {
  const base = input.baseUrl ?? "http://127.0.0.1:3000";
  const task = await fetch(`${base}/api/local-lab/image-tasks`).then(async (r) => ({ ok: r.ok, body: await r.json() as { tasks?: Array<{ id: string; status: string }> } })); const item = task.body.tasks?.find((v) => v.id === input.taskId); if (!task.ok || item?.status !== "completed") throw new Error("local_ui_exact_task_not_completed");
  for (const [kind, type] of [["thumbnail", "image/webp"], ["output", "image/png"]] as const) { const r = await fetch(`${base}/api/local-images/${input.taskId}/${kind}`); if (!r.ok || !r.headers.get("content-type")?.includes(type) || Number(r.headers.get("content-length") ?? 0) <= 0) throw new Error(`local_ui_${kind}_invalid`); }
  try { const { chromium } = await import("playwright"); const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(base, { waitUntil: "networkidle" }); const image = page.locator(`img[src*="/api/local-images/${input.taskId}/thumbnail"]`); if (!await image.isVisible() || !(await image.boundingBox())?.width) throw new Error("local_ui_thumbnail_not_rendered"); if (input.screenshotPath) { mkdirSync(path.dirname(input.screenshotPath), { recursive: true }); await page.screenshot({ path: input.screenshotPath, fullPage: true }); } await browser.close(); } catch (error) { if (String(error).includes("local_ui_thumbnail")) throw error; }
}
