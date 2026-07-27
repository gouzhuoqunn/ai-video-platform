import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

export type LocalUiHandle = { started: boolean; pid: number | null; stop: () => void; logs: () => string };
type ImageKind = "thumbnail" | "output";
type ImageEvidence = { status: number; mime: string | null; declaredBytes: number | null; actualBytes: number; format: string | undefined; width: number | undefined; height: number | undefined };
export type LocalUiVerificationResult = { thumbnail: ImageEvidence; output: ImageEvidence; naturalWidth: number; naturalHeight: number; screenshotPath: string | null };

export class LocalUiVerificationError extends Error {
  constructor(readonly code: string, readonly evidence: Partial<ImageEvidence>) { super(`${code}:${JSON.stringify(evidence)}`); }
}

function declaredBytes(response: Response) {
  const raw = response.headers.get("content-length");
  return raw === null ? null : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

export async function validateImageResponse(kind: ImageKind, response: Response, expectedWidth: number, expectedHeight: number): Promise<ImageEvidence> {
  const mime = response.headers.get("content-type");
  const declared = declaredBytes(response);
  const base = { status: response.status, mime, declaredBytes: declared, actualBytes: 0, format: undefined, width: undefined, height: undefined };
  if (!response.ok) throw new LocalUiVerificationError(`local_ui_${kind}_http_${response.status}`, base);
  const expectedMime = kind === "thumbnail" ? "image/webp" : "image/png";
  if (!mime?.toLowerCase().includes(expectedMime)) throw new LocalUiVerificationError(`local_ui_${kind}_mime_invalid`, base);
  const bytes = Buffer.from(await response.arrayBuffer());
  const body = { ...base, actualBytes: bytes.length };
  if (bytes.length <= 0) throw new LocalUiVerificationError(`local_ui_${kind}_empty`, body);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared !== bytes.length)) throw new LocalUiVerificationError("local_ui_content_length_mismatch", body);
  let metadata: sharp.Metadata;
  try { metadata = await sharp(bytes).metadata(); }
  catch { throw new LocalUiVerificationError(`local_ui_${kind}_decode_failed`, body); }
  const evidence = { ...body, format: metadata.format, width: metadata.width, height: metadata.height };
  if (kind === "thumbnail") {
    if (metadata.format !== "webp" || !metadata.width || !metadata.height || metadata.width > 512 || metadata.height > 512) throw new LocalUiVerificationError("local_ui_thumbnail_dimensions_invalid", evidence);
  } else if (metadata.format !== "png" || metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    throw new LocalUiVerificationError("local_ui_output_dimensions_invalid", evidence);
  }
  return evidence;
}

export async function probeLocalUi(baseUrl = "http://127.0.0.1:3000") { try { const r = await fetch(baseUrl, { signal: AbortSignal.timeout(3_000) }); return r.ok; } catch { return false; } }
export async function ensureLocalUi(input: { baseUrl?: string; spawnImpl?: typeof spawn; timeoutMs?: number; onPid?: (pid: number) => void }) : Promise<LocalUiHandle> {
  const baseUrl = input.baseUrl ?? "http://127.0.0.1:3000"; if (await probeLocalUi(baseUrl)) return { started: false, pid: null, stop: () => undefined, logs: () => "" };
  const child = (input.spawnImpl ?? spawn)(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/c", "npm", "run", "dev:local"] : ["run", "dev:local"], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout?.on("data", (v) => { logs = (logs + v).slice(-6000); }); child.stderr?.on("data", (v) => { logs = (logs + v).slice(-6000); }); if (child.pid) input.onPid?.(child.pid);
  const deadline = Date.now() + (input.timeoutMs ?? 60_000); while (Date.now() < deadline) { if (await probeLocalUi(baseUrl)) return { started: true, pid: child.pid ?? null, stop: () => { if (!child.killed) child.kill(); }, logs: () => logs }; await new Promise((r) => setTimeout(r, 1000)); }
  if (!child.killed) child.kill(); throw new Error(`local_ui_start_timeout:${logs.slice(-500)}`);
}
export async function verifyImageUi(input: { taskId: string; baseUrl?: string; screenshotPath?: string; fetchImpl?: typeof fetch }) : Promise<LocalUiVerificationResult> {
  const base = input.baseUrl ?? "http://127.0.0.1:3000";
  const fetchImpl = input.fetchImpl ?? fetch;
  const task = await fetchImpl(`${base}/api/local-lab/image-tasks`).then(async (r) => ({ ok: r.ok, body: await r.json() as { tasks?: Array<{ id: string; status: string; width?: number; height?: number }> } })); const item = task.body.tasks?.find((v) => v.id === input.taskId); if (!task.ok || !item || item.status !== "completed" || typeof item.width !== "number" || typeof item.height !== "number" || !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)) throw new Error("local_ui_exact_task_not_completed");
  const expectedWidth = item.width; const expectedHeight = item.height;
  const thumbnail = await validateImageResponse("thumbnail", await fetchImpl(`${base}/api/local-images/${input.taskId}/thumbnail`), expectedWidth, expectedHeight);
  const output = await validateImageResponse("output", await fetchImpl(`${base}/api/local-images/${input.taskId}/output`), expectedWidth, expectedHeight);
  const { chromium } = await import("playwright"); const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage(); await page.goto(base, { waitUntil: "networkidle" }); const image = page.locator(`img[src*="/api/local-images/${input.taskId}/thumbnail"]`);
    if (!await image.isVisible() || !(await image.boundingBox())?.width) throw new Error("local_ui_thumbnail_not_rendered");
    const natural = await image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight }));
    if (natural.width <= 0 || natural.height <= 0) throw new Error("local_ui_thumbnail_not_rendered");
    if (input.screenshotPath) { mkdirSync(path.dirname(input.screenshotPath), { recursive: true }); await page.screenshot({ path: input.screenshotPath, fullPage: true }); }
    return { thumbnail, output, naturalWidth: natural.width, naturalHeight: natural.height, screenshotPath: input.screenshotPath ?? null };
  } finally { await browser.close(); }
}
