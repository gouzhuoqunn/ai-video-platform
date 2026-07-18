export type GpuProviderId = "clore" | "runpod" | "manual_ssh";

export type GpuProfile = "rtx4090" | "rtx5090" | "ampere_image_gpu" | "bootstrap_image_gpu";

export type GpuTarget = {
  provider: GpuProviderId;
  host: string;
  port: number;
  username: string;
  sshKeyPath: string;
  gpuProfile: GpuProfile;
  runtimeDigest: string;
  knownHostsPath?: string;
  sshCredentialSource?: "canonical_clore_project_key";
  sshIdentityFingerprint?: string;
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
  cloudType?: "SECURE" | "COMMUNITY";
  availability?: "High" | "Medium" | "Low" | "None" | "Unknown";
  reliability?: number | null;
  rating?: number | null;
  downloadMbps?: number | null;
  uploadMbps?: number | null;
  interruptible: false;
};

export type ProviderPriceBreakdown = {
  computeHourly: number;
  storageHourly: number;
  totalHourly: number;
  projectedSessionTotal: number;
};

export type GpuSession = {
  provider: GpuProviderId;
  id: string;
  name: string;
  status: string;
  createdAt: string | null;
  lastStatusChange: string | null;
  hourlyUsd: number | null;
  price: ProviderPriceBreakdown | null;
  costPerHr: number | null;
  adjustedCostPerHr: number | null;
  containerDiskInGb: number | null;
  volumeInGb: number | null;
  cloudType: "SECURE" | "COMMUNITY" | null;
  gpuType: string | null;
  target: GpuTarget | null;
};

export type CreateSessionInput = {
  sessionId: string;
  candidate: GpuCandidate;
  sshPublicKey: string;
  bootstrapImage: string;
  dryRun: boolean;
  beforeCreateRequest?: () => Promise<void> | void;
  afterCreateRequestAttempt?: () => Promise<void> | void;
  cloreProfile?: "clore_manual_parity" | "clore_key_only" | "clore_key_with_password_fallback";
  resolvedBatchRelease?: { batchId: string; resolutionNonce: string; gpuProfile: "rtx5090" };
};

export type BillingSummary = {
  hourlyUsd: number | null;
  computeHourly: number | null;
  storageHourly: number | null;
  totalHourly: number | null;
  projectedSessionTotal: number | null;
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
