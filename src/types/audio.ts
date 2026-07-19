export const audioInferenceStatuses = ["queued", "waiting_for_resources", "loading_voice", "generating", "muxing", "succeeded", "failed", "canceled"] as const;
export type AudioInferenceStatus = (typeof audioInferenceStatuses)[number];
export type AudioParentReference = { videoJobId: string; longVideoProjectId?: never; longVideoSegmentId?: never } | { videoJobId?: never; longVideoProjectId: string; longVideoSegmentId?: never } | { videoJobId?: never; longVideoProjectId?: never; longVideoSegmentId: string };

export type VoiceProfile = {
  id: string;
  userId: string;
  displayName: string;
  languageSupport: string[];
  manifestRef: string | null;
  localPackRef: string | null;
  status: "draft" | "ready" | "archived" | "failed";
  sourceTrainingJobId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DialogueCue = AudioParentReference & {
  id: string;
  voiceProfileId: string | null;
  speakerName: string | null;
  cueText: string;
  languageCode: string;
  startMs: number;
  speed: number;
  emotion: string | null;
  volume: number;
  cueIndex: number;
};

export type VoiceInferenceJob = AudioParentReference & {
  id: string;
  idempotencyKey: string;
  voiceProfileId: string;
  dialogueSnapshot: DialogueCue[];
  sourceVideoReference: string;
  status: AudioInferenceStatus;
  progress: number;
  attemptCount: number;
  maxAttempts: number;
  errorDetail: string | null;
  resourceWaitReason: string | null;
  cancelRequestedAt: string | null;
  cancelledAt: string | null;
};

export type AudioRevision = AudioParentReference & {
  id: string;
  voiceInferenceJobId: string;
  localRelativeFileRef: string;
  durationMs: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  sha256: string;
  createdAt: string;
};

export type CompositionVersion = AudioParentReference & {
  id: string;
  sourceVideoReference: string;
  audioRevisionId: string | null;
  muxedLocalRelativeFileRef: string;
  sha256: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
};
