import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import workflowTemplate from "../comfy-runtime/workflows/official/wan22-ti2v-5b-api.json";
import { buildLocalJobPaths, loadLocalResultsConfig } from "./local-results/config";
import { STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";

type JsonRecord = Record<string, unknown>;
type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init); const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`wan_runtime_http_${response.status}`); return body;
}
async function websocket(url: string) {
  await new Promise<void>((resolve, reject) => { const socket = new WebSocket(url); const timeout = setTimeout(() => { socket.close(); reject(new Error("wan_websocket_timeout")); }, 15_000); socket.addEventListener("open", () => { clearTimeout(timeout); socket.close(); resolve(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("wan_websocket_failed")); }, { once: true }); });
}

export function buildStage3OWanWorkflow(input: { width?: number; height?: number } = {}) {
  const workflow = structuredClone(workflowTemplate) as Record<string, WorkflowNode>;
  workflow["3"].inputs.seed = 20260715;
  workflow["6"].inputs.text = "A futuristic white research station beside a blue ocean at sunset, gentle waves moving, clouds drifting slowly, cinematic camera, realistic lighting";
  workflow["55"].inputs.width = input.width ?? 832; workflow["55"].inputs.height = input.height ?? 480; workflow["55"].inputs.length = 33; workflow["55"].inputs.batch_size = 1;
  workflow["47"].inputs.fps = 16;
  delete workflow["28"];
  return workflow;
}

export function validateStage3OWanWorkflow(workflow = buildStage3OWanWorkflow()) {
  const classes = new Set(Object.values(workflow).map((node) => node.class_type));
  const required = ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ModelSamplingSD3", "Wan22ImageToVideoLatent", "KSampler", "VAEDecode", "SaveWEBM"];
  const missing = required.filter((name) => !classes.has(name));
  if (missing.length) throw new Error(`wan_workflow_nodes_missing:${missing.join(",")}`);
  const width = Number(workflow["55"].inputs.width); const height = Number(workflow["55"].inputs.height);
  if (!((width === 832 && height === 480) || (width === 640 && height === 368)) || workflow["55"].inputs.length !== 33 || workflow["47"].inputs.fps !== 16) throw new Error("wan_stage3o_shape_invalid");
  return { valid: true, requiredNodes: required, durationSeconds: 33 / 16, width, height };
}

function savedVideo(history: unknown) {
  for (const value of Object.values(record(record(history).outputs))) {
    const output = record(value);
    for (const key of ["gifs", "videos", "images"]) {
      const items = output[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) { const file = record(item); if (typeof file.filename === "string" && /\.webm$/i.test(file.filename)) return { filename: file.filename, subfolder: String(file.subfolder ?? ""), type: String(file.type ?? "output") }; }
    }
  }
  return null;
}

function command(result: ReturnType<typeof spawnSync>, error: string) { if (result.status !== 0) throw new Error(`${error}:${String(result.stderr ?? result.stdout ?? "").slice(-500)}`); }

async function generateVideo(baseUrl: string, workflow: Record<string, WorkflowNode>, clientId: string) {
  const submitted = record(await json(`${baseUrl}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) }));
  const promptId = String(submitted.prompt_id ?? ""); if (!promptId) throw new Error("wan_prompt_id_missing");
  let completed: unknown = null; const deadline = Date.now() + 90 * 60_000;
  while (Date.now() < deadline) { const history = record(await json(`${baseUrl}/history/${encodeURIComponent(promptId)}`)); completed = history[promptId]; if (completed) break; await new Promise((resolve) => setTimeout(resolve, 3_000)); }
  if (!completed) throw new Error("wan_inference_timeout");
  const video = savedVideo(completed);
  if (!video) {
    const detail = JSON.stringify(completed);
    if (/out of memory|cuda.*memory|\boom\b/i.test(detail)) throw new Error("wan_cuda_oom");
    throw new Error("wan_history_video_missing");
  }
  return { promptId, video };
}

async function main() {
  const baseUrl = (argument("base-url") ?? "").replace(/\/$/, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error("wan_requires_loopback_tunnel");
  let workflow = buildStage3OWanWorkflow(); let validation = validateStage3OWanWorkflow(workflow);
  const objectInfo = record(await json(`${baseUrl}/object_info`));
  for (const node of validation.requiredNodes) if (!(node in objectInfo)) throw new Error(`wan_required_node_unavailable:${node}`);
  await websocket(baseUrl.replace("http://", "ws://") + "/ws");
  let generated: Awaited<ReturnType<typeof generateVideo>>; let oomFallbackUsed = false;
  try { generated = await generateVideo(baseUrl, workflow, STAGE3O_VIDEO_TASK_ID); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "wan_cuda_oom") throw error;
    await json(`${baseUrl}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: false, free_memory: true }) });
    workflow = buildStage3OWanWorkflow({ width: 640, height: 368 }); validation = validateStage3OWanWorkflow(workflow); oomFallbackUsed = true;
    generated = await generateVideo(baseUrl, workflow, `${STAGE3O_VIDEO_TASK_ID}-low`);
  }
  const { promptId, video } = generated;
  const response = await fetch(`${baseUrl}/view?${new URLSearchParams(video)}`); const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || bytes.length < 1024) throw new Error("wan_webm_invalid");
  const tempWebm = path.join(os.tmpdir(), `${STAGE3O_VIDEO_TASK_ID}.webm`); writeFileSync(tempWebm, bytes);
  const date = new Date().toISOString().slice(0, 10); const paths = buildLocalJobPaths(loadLocalResultsConfig().libraryDir, date, STAGE3O_VIDEO_TASK_ID); mkdirSync(paths.jobDir, { recursive: true });
  const partialMp4 = `${paths.videoPath}.part`; command(spawnSync("ffmpeg", ["-y", "-i", tempWebm, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", partialMp4], { encoding: "utf8", timeout: 10 * 60_000 }), "wan_mp4_conversion_failed"); renameSync(partialMp4, paths.videoPath);
  const thumbnailSecond = Number((Math.random() * validation.durationSeconds).toFixed(3));
  command(spawnSync("ffmpeg", ["-y", "-ss", String(thumbnailSecond), "-i", paths.videoPath, "-vf", "scale=-2:360", "-frames:v", "1", paths.thumbnailPath], { encoding: "utf8", timeout: 2 * 60_000 }), "wan_thumbnail_failed");
  if (!existsSync(paths.videoPath) || !existsSync(paths.thumbnailPath)) throw new Error("wan_local_sync_missing");
  const sha256 = createHash("sha256").update(readFileSync(paths.videoPath)).digest("hex");
  writeFileSync(paths.metadataPath, `${JSON.stringify({ job_id: STAGE3O_VIDEO_TASK_ID, prompt_id: promptId, width: validation.width, height: validation.height, frames: 33, fps: 16, duration_seconds: validation.durationSeconds, seed: 20260715, audio: false, upscale: false, post_processing: false, oom_fallback_used: oomFallbackUsed, output_sha256: sha256, output_size_bytes: readFileSync(paths.videoPath).length, thumbnail_360p: true, thumbnail_second: thumbnailSecond }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(paths.jobDir, "workflow-api.json"), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ wan_video_verified: true, promptId, outputPath: paths.videoPath, thumbnailPath: paths.thumbnailPath, sha256, durationSeconds: validation.durationSeconds, width: validation.width, height: validation.height, oomFallbackUsed }));
}

if (process.argv[1]?.endsWith("stage3o-wan-executor.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "wan_stage3o_failed"); process.exitCode = 1; });
