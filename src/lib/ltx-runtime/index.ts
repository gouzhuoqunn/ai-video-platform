import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { RequiredGpuClass } from "@/lib/generation/gpu-execution-state";
import type { VideoQualityTier } from "@/lib/generation/video-profiles";

const require = createRequire(import.meta.url);
const FFMPEG_PATH = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const FFPROBE_PATH = (require("@ffprobe-installer/ffprobe") as { path: string }).path;

export const LTX_RUNTIME_VERSION = "stage2-mock-1";
export const LTX_FAILURES = ["no_output", "invalid_container", "missing_video_stream", "missing_audio_stream", "duration_mismatch", "corrupt_or_truncated_output", "unsupported_dimensions", "canceled", "model_load_failure", "out_of_vram", "insufficient_system_ram", "insufficient_disk", "dependency_runtime_failure", "download_cache_failure", "unknown_failure"] as const;
export type LtxFailureCode = (typeof LTX_FAILURES)[number];
export type LtxModelRole = "official_ltx_compatibility_baseline" | "sulphur_full" | "sulphur_distilled" | "auxiliary_lora";
export type LtxExecutableStatus = "compatibility_baseline" | "blocked" | "executable";

export type LtxModelFile = { path: string; sizeBytes: number; sha256: string | null; required: boolean };
export type LtxModelManifest = {
  schemaVersion: 1;
  modelKey: string;
  modelRole: LtxModelRole;
  sourceRepository: string;
  immutableRevision: string;
  files: LtxModelFile[];
  licenseReference: string;
  runtimeCompatibilityVersion: string;
  expectedTotalDownloadBytes: number;
  minimumFreeDiskBytes: number;
  minimumSystemRamBytes: number;
  recommendedSystemRamBytes: number;
  minimumVramBytes: number;
  supportedGpuClasses: RequiredGpuClass[];
  capabilities: { t2v: boolean; i2vFirstFrame: boolean; nativeAudio: boolean };
  workflowAdapterId: string;
  executableStatus: LtxExecutableStatus;
  blockerReason: string | null;
  alternatives?: { fullCheckpointModelKey?: string; distillationLoraModelKey?: string };
};

export type LtxNativeAudioRequest = {
  taskId: string;
  modelKey: string;
  immutableRevision: string;
  modelRole: LtxModelRole;
  prompt: string;
  negativePrompt?: string | null;
  firstFrameReference?: string | null;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  seed: number;
  qualityTier: VideoQualityTier;
  gpuClass: RequiredGpuClass;
  nativeAudioRequired: true;
  expectedOutputPath: string;
  cancellationToken: string;
  recoveryIdentity: string;
  durationToleranceMs: number;
};

export type LtxProgress = { taskId: string; phase: "preparing" | "loading" | "running" | "validating" | "completed" | "canceled"; progress: number; at: string };
export type LtxRuntimeHeartbeat = { processAlive: boolean; modelLoaded: boolean; currentTaskId: string | null; lastHeartbeat: string; cancellationRequested: boolean; gracefulShutdownDeadline: string | null; forcedTerminationFallback: boolean; recoveryIdentity: string | null };
export type LtxResultManifest = { taskId: string; modelKey: string; immutableRevision: string; seed: number; outputPath: string; sha256: string; fileSizeBytes: number; startedAt: string; completedAt: string; runtimeVersion: string; media: NativeAudioMediaEvidence };
export type NativeAudioMediaEvidence = { durationMs: number; width: number; height: number; fps: number | null; frameCount: number | null; videoCodec: string; audioCodec: string; sampleRate: number; channels: number; seekable: boolean; formatName: string };

export type LtxRuntimeBackend = {
  prepare(request: LtxNativeAudioRequest): Promise<void>;
  loadModel(manifest: LtxModelManifest): Promise<void>;
  run(request: LtxNativeAudioRequest, onProgress: (progress: number) => void): Promise<void>;
  cancel(token: string): Promise<void>;
  unloadModel(): Promise<void>;
  health(): Promise<{ alive: boolean; detail: string }>;
  shutdown(): Promise<void>;
};

function failure(message: string): never { throw new Error(message); }
function sha256(filePath: string) { return createHash("sha256").update(readFileSync(filePath)).digest("hex"); }
function rate(value?: string) {
  if (!value) return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator)) return null;
  return denominator && Number.isFinite(denominator) ? numerator / denominator : numerator;
}

export function classifyLtxFailure(error: unknown): LtxFailureCode {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/cancel/.test(message)) return "canceled";
  if (/audio.*missing|missing_audio/.test(message)) return "missing_audio_stream";
  if (/video.*missing|missing_video/.test(message)) return "missing_video_stream";
  if (/duration/.test(message)) return "duration_mismatch";
  if (/dimension|divisible/.test(message)) return "unsupported_dimensions";
  if (/no_output|not_found/.test(message)) return "no_output";
  if (/ffprobe|container|json/.test(message)) return "invalid_container";
  if (/truncated|corrupt|too_small/.test(message)) return "corrupt_or_truncated_output";
  if (/vram|cuda out of memory|oom/.test(message)) return "out_of_vram";
  if (/system.*ram/.test(message)) return "insufficient_system_ram";
  if (/disk/.test(message)) return "insufficient_disk";
  if (/cache|checksum|download/.test(message)) return "download_cache_failure";
  if (/model.*load/.test(message)) return "model_load_failure";
  if (/dependency|runtime/.test(message)) return "dependency_runtime_failure";
  return "unknown_failure";
}

export function validateLtxRequest(request: LtxNativeAudioRequest) {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(request.taskId)) errors.push("task_id_invalid");
  if (!request.modelKey || !request.immutableRevision || !request.recoveryIdentity || !request.cancellationToken) errors.push("identity_missing");
  if (!request.prompt.trim() || request.prompt.length > 4_000) errors.push("prompt_invalid");
  if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 32 || request.height < 32 || request.width % 32 || request.height % 32) errors.push("dimensions_must_be_divisible_by_32");
  if (!Number.isInteger(request.frameCount) || request.frameCount < 9 || request.frameCount % 8 !== 1) errors.push("frame_count_must_be_8n_plus_1");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 120) errors.push("fps_invalid");
  if (!Number.isSafeInteger(request.seed) || request.seed < 0) errors.push("seed_invalid");
  if (request.nativeAudioRequired !== true) errors.push("native_audio_required");
  if (!Number.isFinite(request.durationToleranceMs) || request.durationToleranceMs < 0 || request.durationToleranceMs > 10_000) errors.push("duration_tolerance_invalid");
  if (!request.expectedOutputPath || !path.isAbsolute(request.expectedOutputPath)) errors.push("expected_output_path_invalid");
  if (errors.length) failure(`ltx_request_invalid:${errors.join(",")}`);
}

export function validateNativeAudioMp4(filePath: string, request: Pick<LtxNativeAudioRequest, "width" | "height" | "fps" | "frameCount" | "durationToleranceMs">): NativeAudioMediaEvidence {
  if (!existsSync(filePath)) failure("no_output");
  if (statSync(filePath).size < 1024) failure("corrupt_or_truncated_output");
  const probe = spawnSync(FFPROBE_PATH, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], { encoding: "utf8", timeout: 120_000 });
  if (probe.status !== 0) failure("invalid_container");
  let parsed: { format?: { format_name?: string; duration?: string }; streams?: Array<Record<string, string | number>> } = {};
  try { parsed = JSON.parse(String(probe.stdout)); } catch { failure("invalid_container"); }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video) failure("missing_video_stream");
  if (!audio) failure("missing_audio_stream");
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) failure("invalid_container");
  const expectedDurationMs = request.frameCount / request.fps * 1000;
  if (Math.abs(durationMs - expectedDurationMs) > request.durationToleranceMs) failure("duration_mismatch");
  if (Number(video.width) !== request.width || Number(video.height) !== request.height) failure("unsupported_dimensions");
  const header = readFileSync(filePath).subarray(0, Math.min(statSync(filePath).size, 4 * 1024 * 1024));
  const moov = header.indexOf(Buffer.from("moov")); const mdat = header.indexOf(Buffer.from("mdat"));
  if (moov < 0 || mdat < 0 || moov > mdat) failure("invalid_container");
  return { durationMs, width: Number(video.width), height: Number(video.height), fps: rate(String(video.avg_frame_rate ?? video.r_frame_rate ?? "")), frameCount: Number.isFinite(Number(video.nb_frames)) ? Number(video.nb_frames) : null, videoCodec: String(video.codec_name ?? "unknown"), audioCodec: String(audio.codec_name ?? "unknown"), sampleRate: Number(audio.sample_rate ?? 0), channels: Number(audio.channels ?? 0), seekable: true, formatName: String(parsed.format?.format_name ?? "") };
}

export class MockLtxNativeAudioBackend implements LtxRuntimeBackend {
  private readonly canceled = new Set<string>();
  private loaded = false;
  async prepare() {}
  async loadModel() { this.loaded = true; }
  async run(request: LtxNativeAudioRequest, onProgress: (progress: number) => void) {
    if (this.canceled.has(request.cancellationToken)) failure("canceled");
    await mkdir(path.dirname(request.expectedOutputPath), { recursive: true });
    onProgress(0.2); onProgress(0.65);
    const duration = request.frameCount / request.fps;
    const output = spawnSync(FFMPEG_PATH, ["-y", "-f", "lavfi", "-i", `testsrc2=size=${request.width}x${request.height}:rate=${request.fps}`, "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", String(duration), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", request.expectedOutputPath], { encoding: "utf8", timeout: 120_000 });
    if (output.status !== 0) failure(`dependency_runtime_failure:${String(output.stderr).slice(-500)}`);
    if (this.canceled.has(request.cancellationToken)) { await rm(request.expectedOutputPath, { force: true }); failure("canceled"); }
    onProgress(1);
  }
  async cancel(token: string) { this.canceled.add(token); }
  async unloadModel() { this.loaded = false; }
  async health() { return { alive: true, detail: this.loaded ? "mock_model_loaded" : "mock_ready" }; }
  async shutdown() { this.loaded = false; }
}

export class LtxNativeAudioRuntime {
  private heartbeat: LtxRuntimeHeartbeat = { processAlive: true, modelLoaded: false, currentTaskId: null, lastHeartbeat: new Date().toISOString(), cancellationRequested: false, gracefulShutdownDeadline: null, forcedTerminationFallback: false, recoveryIdentity: null };
  constructor(private readonly backend: LtxRuntimeBackend, private readonly manifest: LtxModelManifest) {}
  getHeartbeat() { return { ...this.heartbeat }; }
  async execute(request: LtxNativeAudioRequest, options: { allowMockWhenBlocked?: boolean; onProgress?: (event: LtxProgress) => void } = {}) {
    validateLtxRequest(request);
    if (request.modelKey !== this.manifest.modelKey || request.immutableRevision !== this.manifest.immutableRevision) failure("model_load_failure:model_manifest_binding_mismatch");
    if (!this.manifest.capabilities.nativeAudio) failure("model_load_failure:native_audio_unsupported");
    if (!this.manifest.supportedGpuClasses.includes(request.gpuClass)) failure("unsupported_dimensions:gpu_class_unsupported");
    if (this.manifest.executableStatus !== "executable" && !options.allowMockWhenBlocked) failure(`model_load_failure:${this.manifest.blockerReason ?? "runtime_not_executable"}`);
    const startedAt = new Date().toISOString();
    const report = (phase: LtxProgress["phase"], progress: number) => options.onProgress?.({ taskId: request.taskId, phase, progress, at: new Date().toISOString() });
    this.heartbeat = { ...this.heartbeat, currentTaskId: request.taskId, recoveryIdentity: request.recoveryIdentity, cancellationRequested: false, lastHeartbeat: startedAt };
    try {
      report("preparing", 0); await this.backend.prepare(request);
      report("loading", 0.1); await this.backend.loadModel(this.manifest); this.heartbeat = { ...this.heartbeat, modelLoaded: true, lastHeartbeat: new Date().toISOString() };
      report("running", 0.2); await this.backend.run(request, (progress) => report("running", progress));
      report("validating", 0.95); const media = validateNativeAudioMp4(request.expectedOutputPath, request);
      const result: LtxResultManifest = { taskId: request.taskId, modelKey: request.modelKey, immutableRevision: request.immutableRevision, seed: request.seed, outputPath: request.expectedOutputPath, sha256: sha256(request.expectedOutputPath), fileSizeBytes: statSync(request.expectedOutputPath).size, startedAt, completedAt: new Date().toISOString(), runtimeVersion: LTX_RUNTIME_VERSION, media };
      const manifestPath = `${request.expectedOutputPath}.result.json`; const part = `${manifestPath}.part-${randomUUID()}`;
      writeFileSync(part, `${JSON.stringify(result, null, 2)}\n`, "utf8"); await rename(part, manifestPath);
      report("completed", 1); return result;
    } catch (error) {
      if (classifyLtxFailure(error) === "canceled") report("canceled", 1);
      throw error;
    } finally {
      this.heartbeat = { ...this.heartbeat, currentTaskId: null, lastHeartbeat: new Date().toISOString() };
    }
  }
  async cancel(token: string) { this.heartbeat = { ...this.heartbeat, cancellationRequested: true, lastHeartbeat: new Date().toISOString() }; await this.backend.cancel(token); }
  async unloadModel() { await this.backend.unloadModel(); this.heartbeat = { ...this.heartbeat, modelLoaded: false, lastHeartbeat: new Date().toISOString() }; }
  async shutdown(graceMs = 15_000) { this.heartbeat = { ...this.heartbeat, gracefulShutdownDeadline: new Date(Date.now() + graceMs).toISOString(), lastHeartbeat: new Date().toISOString() }; await this.backend.shutdown(); this.heartbeat = { ...this.heartbeat, processAlive: false, modelLoaded: false, currentTaskId: null, lastHeartbeat: new Date().toISOString() }; }
}

export type LtxPreflightEvidence = { gpuModel: string; totalVramBytes: number; freeVramBytes: number; systemRamBytes: number; freeDiskBytes: number; cudaVersion: string | null; driverVersion: string | null; pytorchCudaAvailable: boolean; runtimeVersion: string; requiredSupportingFilesPresent: boolean };
export type LtxPreflightResult = { status: "pass" | "warning" | "hard_block"; reasons: string[] };
export function preflightLtx(manifest: LtxModelManifest | null, evidence: LtxPreflightEvidence): LtxPreflightResult {
  const hard: string[] = []; const warnings: string[] = [];
  if (!manifest) hard.push("缺少不可变模型清单");
  if (manifest?.executableStatus !== "executable") hard.push(manifest?.blockerReason ?? "模型运行条件尚未锁定");
  if (evidence.systemRamBytes < 32 * 1024 ** 3) hard.push("系统内存低于 32GB");
  if (evidence.freeDiskBytes < (manifest?.minimumFreeDiskBytes ?? 0)) hard.push("可用磁盘不足");
  if (evidence.totalVramBytes < (manifest?.minimumVramBytes ?? 24 * 1024 ** 3) || evidence.freeVramBytes < (manifest?.minimumVramBytes ?? 24 * 1024 ** 3)) hard.push("可用显存不足 24GB");
  if (!evidence.requiredSupportingFilesPresent) hard.push("缺少模型辅助文件");
  if (!evidence.pytorchCudaAvailable) hard.push("PyTorch CUDA 不可用");
  if (evidence.gpuModel.includes("RTX 4090")) warnings.push("RTX 4090 尚未完成真实兼容验证");
  if (!evidence.gpuModel.includes("RTX 5090") && !evidence.gpuModel.includes("RTX 4090")) warnings.push("GPU 型号不在当前计划范围");
  if (!evidence.cudaVersion || !evidence.driverVersion || !evidence.runtimeVersion) warnings.push("CUDA、驱动或运行时版本证据不完整");
  return hard.length ? { status: "hard_block", reasons: hard } : warnings.length ? { status: "warning", reasons: warnings } : { status: "pass", reasons: [] };
}
