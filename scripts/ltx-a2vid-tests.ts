import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockLocalVoiceBackend } from "../src/lib/audio/local-voice-runtime";
import { LtxNativeAudioRuntime, MockLtxNativeAudioBackend, validateAudioConditionedLtxRequest, validateAudioConditionedResult, type LtxAudioConditionedRequest, type LtxModelManifest } from "../src/lib/ltx-runtime";
import { LTX_AUDIO_CONDITIONED_PRESETS } from "../src/lib/ltx-runtime/presets";
import { buildAudioConditionedTaskPackage } from "../src/lib/ltx-runtime/task-package";

const manifest: LtxModelManifest = { schemaVersion: 1, modelKey: "fixture-sulphur", modelRole: "sulphur_distilled", sourceRepository: "fixture", immutableRevision: "1234567890abcdef1234567890abcdef12345678", files: [], licenseReference: "fixture", runtimeCompatibilityVersion: "fixture", expectedTotalDownloadBytes: 0, minimumFreeDiskBytes: 1, minimumSystemRamBytes: 1, recommendedSystemRamBytes: 1, minimumVramBytes: 1, supportedGpuClasses: ["rtx4090", "rtx5090"], capabilities: { t2v: true, i2vFirstFrame: true, nativeAudio: true }, workflowAdapterId: "fixture", executableStatus: "executable", blockerReason: null };
const lora: LtxModelManifest = { ...manifest, modelKey: "fixture-lora", modelRole: "auxiliary_lora" };

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltx-a2vid-"));
  try {
    const wav = path.join(root, "dialogue.wav");
    const voice = new MockLocalVoiceBackend();
    await voice.synthesize({ voiceInferenceJobId: "voice-job-1", audioRevisionId: "audio-revision-1", voiceProfileId: "voice-profile-1", dialogueText: "fixture", targetDurationMs: 1125, outputPath: wav, speed: null, language: "zh-CN" });
    const wavEvidence = voice.validateWav(wav, { voiceInferenceJobId: "voice-job-1", audioRevisionId: "audio-revision-1", voiceProfileId: "voice-profile-1", targetDurationMs: 1125, speed: null });
    const request: LtxAudioConditionedRequest = { taskId: "audio-fixture-1", modelKey: manifest.modelKey, immutableRevision: manifest.immutableRevision, modelRole: manifest.modelRole, prompt: "audio conditioned fixture", negativePrompt: null, firstFrameReference: null, width: 1280, height: 720, fps: 8, frameCount: 9, seed: 9, qualityTier: "low", gpuClass: "rtx4090", nativeAudioRequired: true, expectedOutputPath: path.join(root, "output.mp4"), cancellationToken: "a2vid-cancel", recoveryIdentity: "a2vid-recovery", durationToleranceMs: 600, executionPreset: "ltx_audible_fast_720p_4090", inputAudioPath: wav, inputAudioSha256: wavEvidence.sha256, inputAudioDurationMs: wavEvidence.durationMs, inputAudioRevisionId: wavEvidence.audioRevisionId, voiceInferenceJobId: wavEvidence.voiceInferenceJobId, voiceProfileId: wavEvidence.voiceProfileId, dialogueSnapshot: [{ visualPrompt: "audio conditioned fixture", dialogueText: "fixture", speakerName: null, voiceProfileId: wavEvidence.voiceProfileId, language: "zh-CN", targetDurationMs: 1125, sequenceIndex: 0, speed: null, emotion: null, volume: null }], audioConditioningRequired: true, preserveInputAudio: true };
    assert.equal(validateAudioConditionedLtxRequest(request).sha256, wavEvidence.sha256);
    assert.throws(() => validateAudioConditionedLtxRequest({ ...request, inputAudioSha256: "0".repeat(64) }), /input_audio_hash_mismatch/);
    const taskPackage = buildAudioConditionedTaskPackage(request, [manifest, lora]);
    assert.equal(taskPackage.executableStatus, "blocked");
    assert.deepEqual(Object.values(taskPackage.files).filter(Boolean), ["request.json", "dialogue.json", "dialogue.wav", "model-manifest-references.json"]);
    assert.ok(taskPackage.modelManifestReferences.every((item) => !Object.hasOwn(item, "files")));
    assert.equal(LTX_AUDIO_CONDITIONED_PRESETS.length, 3);
    assert.ok(LTX_AUDIO_CONDITIONED_PRESETS.every((preset) => preset.executableStatus === "blocked"));
    const runtime = new LtxNativeAudioRuntime(new MockLtxNativeAudioBackend(), manifest);
    const result = await runtime.execute(request, { allowMockWhenBlocked: true });
    assert.equal(validateAudioConditionedResult(request, result).inputAudioRevisionId, request.inputAudioRevisionId);
    assert.equal(result.audioConditioning?.preservedInputAudio, true);
    assert.throws(() => validateAudioConditionedResult(request, { ...result, audioConditioning: { ...result.audioConditioning!, inputAudioRevisionId: "other-revision" } }), /input_audio_revision_mismatch/);
    console.log(JSON.stringify({ ok: true, audioConditioned: true, inputWavPreserved: true, blockedPresets: 3, modelDownloads: 0, providerMutations: 0 }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
