import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { cleanupLtxPartFiles, planLtxCacheRestore, restoreLtxCache } from "../src/lib/ltx-runtime/cache";
import { LtxNativeAudioRuntime, MockLtxNativeAudioBackend, classifyLtxFailure, preflightLtx, validateLtxRequest, validateNativeAudioMp4, type LtxModelManifest, type LtxNativeAudioRequest } from "../src/lib/ltx-runtime";
import { createModelScopedSessionDriver } from "../src/lib/ltx-runtime/session-driver";

const require = createRequire(import.meta.url);
const ffmpeg = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const result = spawnSync;

const manifest: LtxModelManifest = {
  schemaVersion: 1, modelKey: "fixture_ltx", modelRole: "official_ltx_compatibility_baseline", sourceRepository: "fixture", immutableRevision: "1234567890abcdef1234567890abcdef12345678",
  files: [{ path: "model.bin", sizeBytes: 10, sha256: sha(Buffer.from("0123456789")), required: true }, { path: "aux.bin", sizeBytes: 3, sha256: sha(Buffer.from("aux")), required: true }],
  licenseReference: "fixture", runtimeCompatibilityVersion: "fixture", expectedTotalDownloadBytes: 13, minimumFreeDiskBytes: 1024, minimumSystemRamBytes: 32 * 1024 ** 3, recommendedSystemRamBytes: 64 * 1024 ** 3, minimumVramBytes: 24 * 1024 ** 3,
  supportedGpuClasses: ["rtx4090", "rtx5090"], capabilities: { t2v: true, i2vFirstFrame: true, nativeAudio: true }, workflowAdapterId: "fixture", executableStatus: "executable", blockerReason: null,
};

function request(output: string): LtxNativeAudioRequest {
  return { taskId: "ltx-fixture-task", modelKey: manifest.modelKey, immutableRevision: manifest.immutableRevision, modelRole: manifest.modelRole, prompt: "一只小狗在阳光下奔跑，伴随轻快脚步声", negativePrompt: null, firstFrameReference: null, width: 64, height: 64, fps: 8, frameCount: 9, seed: 7, qualityTier: "low", gpuClass: "rtx5090", nativeAudioRequired: true, expectedOutputPath: output, cancellationToken: "cancel-fixture", recoveryIdentity: "recovery-fixture", durationToleranceMs: 600 };
}
function ffmpegOk(args: string[]) { const child = result(ffmpeg, args, { encoding: "utf8", timeout: 120_000 }); assert.equal(child.status, 0, String(child.stderr)); }

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltx-runtime-"));
  try {
    const output = path.join(root, "output.mp4"); const progress: string[] = [];
    const runtime = new LtxNativeAudioRuntime(new MockLtxNativeAudioBackend(), manifest);
    const completed = await runtime.execute(request(output), { onProgress: (event) => progress.push(event.phase) });
    assert.equal(completed.taskId, "ltx-fixture-task"); assert.ok(existsSync(`${output}.result.json`)); assert.ok(progress.includes("completed"));
    assert.equal(validateNativeAudioMp4(output, request(output)).audioCodec, "aac");
    await runtime.unloadModel(); assert.equal(runtime.getHeartbeat().modelLoaded, false);
    await runtime.cancel("pre-canceled");
    await assert.rejects(() => runtime.execute({ ...request(path.join(root, "canceled.mp4")), cancellationToken: "pre-canceled" }), /canceled/);

    const videoOnly = path.join(root, "video-only.mp4"); ffmpegOk(["-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=8", "-t", "1.125", "-an", "-c:v", "libx264", "-movflags", "+faststart", videoOnly]);
    assert.throws(() => validateNativeAudioMp4(videoOnly, request(videoOnly)), /missing_audio_stream/);
    const invalid = path.join(root, "invalid.mp4"); writeFileSync(invalid, "not an mp4"); assert.throws(() => validateNativeAudioMp4(invalid, request(invalid)), /corrupt_or_truncated_output/);
    assert.throws(() => validateLtxRequest({ ...request(output), frameCount: 8 }), /8n_plus_1/);
    assert.equal(classifyLtxFailure(new Error("missing_audio_stream")), "missing_audio_stream");

    const source = path.join(root, "source"); const cache = path.join(root, "cache"); mkdirSync(source, { recursive: true }); writeFileSync(path.join(source, "model.bin"), "0123456789"); writeFileSync(path.join(source, "aux.bin"), "aux");
    const plan = planLtxCacheRestore(manifest, cache, { local_cache: true }); assert.equal(plan.source, "local_cache");
    mkdirSync(cache, { recursive: true }); writeFileSync(path.join(cache, "model.bin.part"), "0123");
    const one = restoreLtxCache({ manifest, cacheRoot: cache, sourceRoot: source, source: "local_cache" }); const two = restoreLtxCache({ manifest, cacheRoot: cache, sourceRoot: source, source: "local_cache" }); assert.strictEqual(one, two);
    const cached = await one; assert.deepEqual(cached.resumed, ["model.bin"]); assert.equal(readFileSync(path.join(cache, "model.bin"), "utf8"), "0123456789");
    writeFileSync(path.join(cache, "stale.part"), "stale"); cleanupLtxPartFiles(cache, 1, Date.now() + 2_000); assert.equal(existsSync(path.join(cache, "stale.part")), false);
    const missingManifest = { ...manifest, files: [...manifest.files, { path: "missing.bin", sizeBytes: 1, sha256: null, required: true }] };
    await assert.rejects(() => restoreLtxCache({ manifest: missingManifest, cacheRoot: path.join(root, "missing"), sourceRoot: source, source: "upstream" }), /cache_required_file_missing/);
    const mismatchManifest = { ...manifest, immutableRevision: "abcdef1234567890abcdef1234567890abcdef12", files: [{ ...manifest.files[0], sha256: "0".repeat(64) }] };
    await assert.rejects(() => restoreLtxCache({ manifest: mismatchManifest, cacheRoot: path.join(root, "mismatch"), sourceRoot: source, source: "upstream" }), /cache_checksum_mismatch/);
    await assert.rejects(() => restoreLtxCache({ manifest, cacheRoot: path.join(root, "canceled-cache"), sourceRoot: source, source: "upstream", cancel: () => true }), /cache_restore_canceled/);

    const hardware = { gpuModel: "NVIDIA RTX 5090", totalVramBytes: 32 * 1024 ** 3, freeVramBytes: 28 * 1024 ** 3, systemRamBytes: 64 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3, cudaVersion: "12.8", driverVersion: "570", pytorchCudaAvailable: true, runtimeVersion: "fixture", requiredSupportingFilesPresent: true };
    assert.equal(preflightLtx(manifest, hardware).status, "pass"); assert.equal(preflightLtx(manifest, { ...hardware, gpuModel: "NVIDIA RTX 4090" }).status, "warning"); assert.equal(preflightLtx(manifest, { ...hardware, systemRamBytes: 16 * 1024 ** 3 }).status, "hard_block");
    const lifecycleCalls: string[] = [];
    const lifecycle = (name: "wan" | "ltx") => ({ async prepare() { lifecycleCalls.push(`${name}:prepare`); }, async cancelActiveTask() { lifecycleCalls.push(`${name}:cancel`); }, async unload() { lifecycleCalls.push(`${name}:unload`); } });
    const session = createModelScopedSessionDriver({ wan: lifecycle("wan"), ltx: lifecycle("ltx"), provider: { async safeCancelSession() { lifecycleCalls.push("provider:cancel"); } } });
    await session.ensureModelFamilyReady({ family: "video", modelKey: "video_ltx_native_audio", gpuClass: "rtx5090", providerOrderId: "fixture-order" });
    await session.stopClaiming("video"); await session.interruptGeneration({ family: "video", taskIds: ["ltx-fixture-task"] }); await session.unloadModelFamily("video");
    await session.ensureModelFamilyReady({ family: "video", modelKey: "video_wan_silent", gpuClass: "rtx5090", providerOrderId: "fixture-order" }); await session.safeCancelSession({ providerOrderId: "fixture-order", hadActiveGeneration: false });
    assert.deepEqual(lifecycleCalls, ["ltx:prepare", "ltx:cancel", "ltx:unload", "wan:prepare", "wan:unload", "provider:cancel"]);
    const dockerfile = readFileSync("ltx-runtime/Dockerfile", "utf8"); assert.match(dockerfile, /ffmpeg/); assert.match(dockerfile, /USER runtime/); assert.doesNotMatch(dockerfile, /^EXPOSE\s/im); assert.doesNotMatch(dockerfile, /COPY models|CLORE_API_KEY|SUPABASE_SECRET_KEY/);
    console.log(JSON.stringify({ ok: true, nativeAudioValidated: true, cacheRestore: true, duplicateRestoreSuppressed: true, preflight: true, providerMutations: 0, modelDownloads: 0 }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
