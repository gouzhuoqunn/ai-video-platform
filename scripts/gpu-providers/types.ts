export type GpuProviderId = "clore" | "runpod" | "manual_ssh";

export type GpuProfile = "rtx4090" | "rtx5090" | "bootstrap_image_gpu";

export type GpuTarget = {
  provider: GpuProviderId;
  host: string;
  port: number;
  username: string;
  sshKeyPath: string;
  gpuProfile: GpuProfile;
  runtimeDigest: string;
};

export type ProviderCredentialInspection = {
  provider: GpuProviderId;
  credentials_present: boolean;
  source: "environment" | "secret_file" | "external" | "none";
  safe_to_query: boolean;
};

export type GpuCandidate = {
  id: string;
  gpuType: string;
  priority: number;
  vramGb: number;
  gpuCount: 1;
  minimumRamGb: number;
  containerDiskGb: number;
  volumeGb: number;
  hourlyUsd: number | null;
  interruptible: false;
};

export type GpuSession = {
  provider: GpuProviderId;
  id: string;
  name: string;
  status: string;
  createdAt: string | null;
  lastStatusChange: string | null;
  hourlyUsd: number | null;
  target: GpuTarget | null;
};

export type CreateSessionInput = {
  sessionId: string;
  candidate: GpuCandidate;
  sshPublicKey: string;
  bootstrapImage: string;
  dryRun: boolean;
};

export type BillingSummary = {
  hourlyUsd: number | null;
  elapsedSeconds: number | null;
  estimatedSpendUsd: number | null;
};

export interface GpuProvider {
  readonly id: GpuProviderId;
  inspectCredentials(): Promise<ProviderCredentialInspection>;
  getBalance(): Promise<{ availableUsd: number | null; supported: boolean }>;
  listCandidates(): Promise<GpuCandidate[]>;
  createSession(input: CreateSessionInput): Promise<GpuSession>;
  getSession(sessionId: string): Promise<GpuSession | null>;
  waitForSsh(session: GpuSession, timeoutMs?: number): Promise<GpuTarget>;
  stopSession(session: GpuSession): Promise<void>;
  terminateSession(session: GpuSession): Promise<void>;
  getBilling(session: GpuSession): Promise<BillingSummary>;
  recoverExistingSession(sessionId?: string): Promise<GpuSession | null>;
}
