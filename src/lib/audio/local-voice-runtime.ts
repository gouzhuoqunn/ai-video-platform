import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type LocalDialogueVoiceRequest = { voiceInferenceJobId: string; audioRevisionId: string; voiceProfileId: string; dialogueText: string; targetDurationMs: number; outputPath: string; speed: number | null; language: string };
export type LocalDialogueAudioEvidence = { audioRevisionId: string; voiceInferenceJobId: string; voiceProfileId: string; relativeFileRef: string; sha256: string; durationMs: number; targetDurationMs: number; sampleRate: number; channels: number; codecContainer: "pcm_s16le/wav"; loudnessStatus: "unmeasured"; speakingRateAdjustment: number | null; leadingPaddingMs: number; trailingPaddingMs: number; trimmed: false; createdAt: string };
export type LocalVoiceBackend = { validateVoiceProfile(id: string): Promise<void>; prepare(): Promise<void>; synthesize(request: LocalDialogueVoiceRequest): Promise<void>; cancel(token: string): Promise<void>; validateWav(path: string, request: Pick<LocalDialogueVoiceRequest, "audioRevisionId" | "voiceInferenceJobId" | "voiceProfileId" | "targetDurationMs" | "speed">): LocalDialogueAudioEvidence; unload(): Promise<void>; health(): Promise<{ alive: boolean; detail: string }>; shutdown(): Promise<void> };

function sha(file: string) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
export function validateLocalDialogueWav(file: string, request: Pick<LocalDialogueVoiceRequest, "audioRevisionId" | "voiceInferenceJobId" | "voiceProfileId" | "targetDurationMs" | "speed">): LocalDialogueAudioEvidence {
  if (!existsSync(file) || statSync(file).size < 44) throw new Error("local_audio_missing");
  const bytes = readFileSync(file); if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("unsupported_audio_format");
  const channels = bytes.readUInt16LE(22); const sampleRate = bytes.readUInt32LE(24); const bits = bytes.readUInt16LE(34); const dataSize = bytes.readUInt32LE(40);
  const durationMs = Math.round(dataSize / (sampleRate * channels * (bits / 8)) * 1000);
  if (channels < 1 || channels > 2 || sampleRate < 8_000 || sampleRate > 96_000 || bits !== 16) throw new Error("unsupported_audio_format");
  if (Math.abs(durationMs - request.targetDurationMs) > 300) throw new Error("input_audio_duration_mismatch");
  return { audioRevisionId: request.audioRevisionId, voiceInferenceJobId: request.voiceInferenceJobId, voiceProfileId: request.voiceProfileId, relativeFileRef: path.basename(file), sha256: sha(file), durationMs, targetDurationMs: request.targetDurationMs, sampleRate, channels, codecContainer: "pcm_s16le/wav", loudnessStatus: "unmeasured", speakingRateAdjustment: request.speed, leadingPaddingMs: 0, trailingPaddingMs: 0, trimmed: false, createdAt: new Date().toISOString() };
}

export class MockLocalVoiceBackend implements LocalVoiceBackend {
  private canceled = new Set<string>();
  async validateVoiceProfile(id: string) { if (!id) throw new Error("voice_profile_invalid"); }
  async prepare() {}
  async synthesize(request: LocalDialogueVoiceRequest) {
    if (this.canceled.has(request.voiceInferenceJobId)) throw new Error("canceled");
    await mkdir(path.dirname(request.outputPath), { recursive: true });
    const sampleRate = 16_000; const samples = Math.round(sampleRate * request.targetDurationMs / 1000); const data = Buffer.alloc(samples * 2);
    const header = Buffer.alloc(44); header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40); writeFileSync(request.outputPath, Buffer.concat([header, data]));
  }
  async cancel(token: string) { this.canceled.add(token); }
  validateWav(file: string, request: Pick<LocalDialogueVoiceRequest, "audioRevisionId" | "voiceInferenceJobId" | "voiceProfileId" | "targetDurationMs" | "speed">) { return validateLocalDialogueWav(file, request); }
  async unload() {}
  async health() { return { alive: true, detail: "mock_local_voice_ready" }; }
  async shutdown() {}
}

export function createLocalVoiceRequest(input: Omit<LocalDialogueVoiceRequest, "voiceInferenceJobId" | "audioRevisionId">) { return { ...input, voiceInferenceJobId: randomUUID(), audioRevisionId: randomUUID() }; }
