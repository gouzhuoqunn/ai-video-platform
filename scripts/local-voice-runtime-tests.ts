import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLocalVoiceBackend, createLocalVoiceRequest } from "../src/lib/audio/local-voice-runtime";

const root = mkdtempSync(path.join(os.tmpdir(), "local-voice-runtime-"));
void (async () => {
  try {
    const backend = new MockLocalVoiceBackend(); const output = path.join(root, "dialogue.wav");
    const request = createLocalVoiceRequest({ voiceProfileId: "voice-profile", dialogueText: "你好", targetDurationMs: 1000, outputPath: output, speed: 1, language: "zh-CN" });
    await backend.validateVoiceProfile(request.voiceProfileId); await backend.prepare(); await backend.synthesize(request);
    const evidence = backend.validateWav(output, request);
    assert.equal(evidence.durationMs, 1000); assert.equal(evidence.sampleRate, 16000); assert.equal(evidence.trimmed, false);
    await backend.cancel("cancelled"); await assert.rejects(() => backend.synthesize({ ...request, voiceInferenceJobId: "cancelled", outputPath: path.join(root, "cancel.wav") }), /canceled/);
    console.log(JSON.stringify({ ok: true, mockVoiceOnly: true, wavValidated: true, modelDownloads: 0, providerMutations: 0 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
