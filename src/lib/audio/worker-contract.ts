import { buildAudioWorkerPaths } from "@/lib/local-data/path-registry";
import type { AudioInferenceStatus, VoiceInferenceJob } from "@/types/audio";

export const AUDIO_WORKER_PATHS = buildAudioWorkerPaths();

export type AudioWorkerResourceWaitReason = "memory" | "cpu" | "voice_already_loaded" | "voice_pack_unavailable";
export type AudioWorkerProgressEvent = { jobId: string; status: Extract<AudioInferenceStatus, "loading_voice" | "generating" | "muxing">; progress: number; at: string };
export type AudioWorkerResultEvent = { jobId: string; audioRevisionId: string; compositionVersionId: string | null; at: string };
export type AudioWorkerCancellationEvent = { jobId: string; phase: "before_start" | "during_generation" | "during_muxing"; at: string };
export type AudioWorkerRecoveryRecord = { jobId: string; idempotencyKey: string; status: AudioInferenceStatus; loadedVoiceProfileId: string | null; updatedAt: string };
export type AudioWorkerQueueState = {
  schemaVersion: 1;
  loadedVoiceProfileId: string | null;
  jobs: Array<Pick<VoiceInferenceJob, "id" | "idempotencyKey" | "voiceProfileId" | "status" | "progress" | "cancelRequestedAt">>;
  recovery: AudioWorkerRecoveryRecord[];
};
