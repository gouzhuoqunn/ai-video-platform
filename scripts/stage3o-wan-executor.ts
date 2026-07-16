import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import workflowTemplate from "../comfy-runtime/workflows/official/wan22-ti2v-5b-api.json";
import { buildLocalJobPaths, loadLocalResultsConfig } from "./local-results/config";
import { STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";

type JsonRecord = Record<string, unknown>;
type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };
const require = createRequire(import.meta.url);
const FFMPEG_PATH = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const FFPROBE_PATH = (require("@ffprobe-installer/ffprobe") as { path: string }).path;

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

function command(result: ReturnType<typeof spawnSync>, error: string) { if (result.status !== 0) throw new Error(`${error}:${String(result.error?.message ?? result.stderr ?? result.stdout ?? `exit_${result.status}`).slice(-2000)}`); }

export function bundledMediaTools() {
  return { ffmpegPath: FFMPEG_PATH, ffprobePath: FFPROBE_PATH };
}

export type MediaProbe = {
  format: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }>;
};

export function probeMedia(filePath: string): MediaProbe {
  const result = spawnSync(FFPROBE_PATH, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], { encoding: "utf8", timeout: 2 * 60_000 });
  command(result, "wan_ffprobe_failed");
  try { return JSON.parse(String(result.stdout)) as MediaProbe; }
  catch { throw new Error("wan_ffprobe_json_invalid"); }
}

function fileEvidence(filePath: string) {
  const bytes = readFileSync(filePath);
  return { path: filePath, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function assertMp4(filePath: string) {
  if (!existsSync(filePath) || statSync(filePath).size < 1024) throw new Error("wan_mp4_invalid");
  const probe = probeMedia(filePath);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  if (!video || !["h264", "avc1"].includes(String(video.codec_name)) || video.pix_fmt !== "yuv420p") throw new Error("wan_mp4_browser_codec_invalid");
  const header = readFileSync(filePath).subarray(0, Math.min(statSync(filePath).size, 4 * 1024 * 1024));
  const moov = header.indexOf(Buffer.from("moov")); const mdat = header.indexOf(Buffer.from("mdat"));
  if (moov < 0 || mdat < 0 || moov > mdat) throw new Error("wan_mp4_faststart_invalid");
  return probe;
}

function assertJpeg(filePath: string) {
  if (!existsSync(filePath) || statSync(filePath).size < 256) throw new Error("wan_thumbnail_invalid");
  const bytes = readFileSync(filePath);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error("wan_thumbnail_jpeg_invalid");
  const probe = probeMedia(filePath);
  const image = probe.streams.find((stream) => stream.codec_type === "video");
  if (!image || Number(image.width) > 640 || Number(image.height) > 360) throw new Error("wan_thumbnail_dimensions_invalid");
  return probe;
}

export function deterministicThumbnailSecond(seed: number, durationSeconds: number) {
  const normalized = ((Math.imul(seed | 0, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  return Number((durationSeconds * (0.1 + normalized * 0.8)).toFixed(3));
}

export function archiveStage3OWanVideo(input: {
  sourceWebm: string;
  workflow: Record<string, WorkflowNode>;
  promptId: string;
  validation: ReturnType<typeof validateStage3OWanWorkflow>;
  oomFallbackUsed: boolean;
  runtimeEvidence?: Record<string, unknown>;
  libraryDir?: string;
  preconvertedMp4?: string;
}) {
  if (!existsSync(input.sourceWebm) || statSync(input.sourceWebm).size < 1024) throw new Error("wan_webm_invalid");
  const date = new Date().toISOString().slice(0, 10); const paths = buildLocalJobPaths(input.libraryDir ?? loadLocalResultsConfig().libraryDir, date, STAGE3O_VIDEO_TASK_ID); mkdirSync(paths.jobDir, { recursive: true });
  const preservedWebm = path.join(paths.jobDir, "source.webm"); const partialWebm = `${preservedWebm}.part`;
  if (path.resolve(input.sourceWebm) !== path.resolve(preservedWebm) && !existsSync(preservedWebm)) {
    rmSync(partialWebm, { force: true }); copyFileSync(input.sourceWebm, partialWebm);
    if (statSync(partialWebm).size < 1024) throw new Error("wan_webm_partial_invalid");
    renameSync(partialWebm, preservedWebm);
  }
  const sourceProbe = probeMedia(preservedWebm);
  if (!sourceProbe.streams.some((stream) => stream.codec_type === "video")) throw new Error("wan_webm_video_stream_missing");
  const partialMp4 = `${paths.videoPath}.part`; rmSync(partialMp4, { force: true });
  if (input.preconvertedMp4) copyFileSync(input.preconvertedMp4, partialMp4);
  else {
    const conversion = spawnSync(FFMPEG_PATH, ["-y", "-i", preservedWebm, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", partialMp4], { encoding: "utf8", timeout: 10 * 60_000 });
    if (conversion.status !== 0) {
      writeFileSync(path.join(paths.jobDir, "local-ffmpeg.stderr.txt"), String(conversion.error?.message ?? conversion.stderr ?? conversion.stdout ?? `exit_${conversion.status}`), "utf8");
      command(conversion, "wan_mp4_conversion_failed");
    }
  }
  const videoProbe = assertMp4(partialMp4); rmSync(paths.videoPath, { force: true }); renameSync(partialMp4, paths.videoPath);
  const duration = Number(videoProbe.format.duration ?? input.validation.durationSeconds);
  const thumbnailSecond = deterministicThumbnailSecond(20260715, Number.isFinite(duration) && duration > 0 ? duration : input.validation.durationSeconds);
  const partialThumbnail = `${paths.thumbnailPath}.part`; rmSync(partialThumbnail, { force: true });
  command(spawnSync(FFMPEG_PATH, ["-y", "-ss", String(thumbnailSecond), "-i", paths.videoPath, "-vf", "scale=min(640\\,iw):min(360\\,ih):force_original_aspect_ratio=decrease", "-frames:v", "1", "-f", "image2", partialThumbnail], { encoding: "utf8", timeout: 2 * 60_000 }), "wan_thumbnail_failed");
  const thumbnailProbe = assertJpeg(partialThumbnail); rmSync(paths.thumbnailPath, { force: true }); renameSync(partialThumbnail, paths.thumbnailPath);
  if (!existsSync(paths.videoPath) || !existsSync(paths.thumbnailPath)) throw new Error("wan_local_sync_missing");
  const sourceEvidence = fileEvidence(preservedWebm); const videoEvidence = fileEvidence(paths.videoPath); const thumbnailEvidence = fileEvidence(paths.thumbnailPath);
  writeFileSync(path.join(paths.jobDir, "workflow-api.json"), `${JSON.stringify(input.workflow, null, 2)}\n`, "utf8");
  const metadata = { job_id: STAGE3O_VIDEO_TASK_ID, prompt_id: input.promptId, width: input.validation.width, height: input.validation.height, frames: 33, fps: 16, duration_seconds: duration, seed: 20260715, audio: false, upscale: false, post_processing: false, oom_fallback_used: input.oomFallbackUsed, source_webm: sourceEvidence, output_mp4: videoEvidence, thumbnail_jpeg: thumbnailEvidence, source_probe: sourceProbe, output_probe: videoProbe, thumbnail_probe: thumbnailProbe, browser_codec: "h264", pixel_format: "yuv420p", faststart: true, thumbnail_360p: true, thumbnail_second: thumbnailSecond, thumbnail_seed_range: "10%-90%", local_conversion: !input.preconvertedMp4, source_preserved: true };
  writeFileSync(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  if (input.runtimeEvidence) writeFileSync(path.join(paths.jobDir, "runtime-evidence.json"), `${JSON.stringify({ ...input.runtimeEvidence, local_media: metadata }, null, 2)}\n`, "utf8");
  return { wan_video_verified: true, promptId: input.promptId, sourcePath: preservedWebm, outputPath: paths.videoPath, thumbnailPath: paths.thumbnailPath, sha256: videoEvidence.sha256, outputSizeBytes: videoEvidence.size_bytes, sourceSha256: sourceEvidence.sha256, sourceSizeBytes: sourceEvidence.size_bytes, thumbnailSha256: thumbnailEvidence.sha256, thumbnailSizeBytes: thumbnailEvidence.size_bytes, durationSeconds: duration, width: input.validation.width, height: input.validation.height, oomFallbackUsed: input.oomFallbackUsed, sourcePreserved: true, localConversion: !input.preconvertedMp4, videoProbe, thumbnailProbe };
}

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
  console.log(JSON.stringify(archiveStage3OWanVideo({ sourceWebm: tempWebm, workflow, promptId, validation, oomFallbackUsed })));
}

if (process.argv[1]?.endsWith("stage3o-wan-executor.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "wan_stage3o_failed"); process.exitCode = 1; });
