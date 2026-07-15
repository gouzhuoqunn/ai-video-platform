
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPrivateKeyPath } from "../clore/ssh-client";
import { FIXED_RUNTIME_DIGEST, parseEnvFile, sleep, sshCommand, tcpReachable } from "./common";
import type { CreateSessionInput, GpuCandidate, GpuProvider, GpuSession, GpuTarget, ProviderPriceBreakdown } from "./types";

export const RUNPOD_API_BASE = "https://rest.runpod.io/v1";
export const RUNPOD_GRAPHQL_BASE = "https://api.runpod.io/graphql";
export const RUNPOD_GPU_PRIORITY = [
  ["NVIDIA A40", 48],
  ["NVIDIA RTX A6000", 48],
  ["NVIDIA GeForce RTX 3090", 24],
  ["NVIDIA L4", 24],
  ["NVIDIA GeForce RTX 4090", 24],
  ["NVIDIA RTX A5000", 24],
  ["NVIDIA GeForce RTX 3090 Ti", 24],
] as const;
export const RUNPOD_CONTAINER_STORAGE_USD_PER_GB_MONTH = 0.10;
export const RUNPOD_VOLUME_STORAGE_USD_PER_GB_MONTH = 0.10;
export const RUNPOD_BILLING_HOURS_PER_MONTH = 730;
export const RUNPOD_PROJECTED_SESSION_HOURS = 3.5;
export const RUNPOD_BOOTSTRAP_IMAGE = "ghcr.io/gouzhuoqunn/ai-creative-runpod-bootstrap:v0.1.0-stage3j";
export const RUNPOD_DIRECT_TEMPLATE_NAME = "ai-video-first-image-direct-v1";
export const RUNPOD_DIRECT_LAUNCH_MODE = "runpod_direct_template" as const;
export const RUNPOD_DIRECT_SSH_COMMAND = [
  "set -euo pipefail",
  "test \"$(id -u)\" -eq 0",
  "case \"${PUBLIC_KEY:-}\" in ssh-ed25519\\ *|ssh-rsa\\ *|ecdsa-*\\ *) ;; *) echo runpod_public_key_invalid >&2; exit 64 ;; esac",
  "export DEBIAN_FRONTEND=noninteractive",
  "apt-get update",
  "apt-get install -y --no-install-recommends openssh-server",
  "rm -rf /var/lib/apt/lists/*",
  "install -d -m 0700 /root/.ssh",
  "install -d -m 0755 /run/sshd",
  "printf '%s\\n' \"${PUBLIC_KEY}\" > /root/.ssh/authorized_keys",
  "chmod 0600 /root/.ssh/authorized_keys",
  "ssh-keygen -A",
  "printf '%s\\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitEmptyPasswords no' 'PermitRootLogin prohibit-password' > /etc/ssh/sshd_config.d/99-runpod-first-image.conf",
  "unset PUBLIC_KEY",
  "exec /usr/sbin/sshd -D -e",
].join("; ");

type RunPodPod = {
  id: string;
  name?: string;
  desiredStatus?: string;
  lastStartedAt?: string | null;
  lastStatusChange?: string | null;
  adjustedCostPerHr?: number | string | null;
  costPerHr?: number | string | null;
  cloudType?: string | null;
  gpuTypeId?: string | null;
  containerDiskInGb?: number | string | null;
  volumeInGb?: number | string | null;
  publicIp?: string | null;
  portMappings?: Record<string, number> | null;
  interruptible?: boolean;
  gpu?: { displayName?: string; count?: number } | null;
  machine?: { gpuTypeId?: string | null; secureCloud?: boolean | null; supportPublicIp?: boolean | null } | null;
};

export type RunPodTemplate = {
  id: string;
  name: string;
  imageName: string;
  category?: string;
  containerDiskInGb?: number;
  dockerEntrypoint?: string[];
  dockerStartCmd?: string[];
  env?: Record<string, string>;
  isPublic?: boolean;
  isServerless?: boolean;
  ports?: string[];
  volumeInGb?: number;
  volumeMountPath?: string;
};

export type RunPodConfig = {
  apiKey: string;
  keySource: "environment" | "secret_file" | "none";
  maxGpuHourlyUsd: number;
  maxTotalHourlyUsd: number;
  maxSessionUsd: number;
  sshPublicKeyPath: string;
  sshPrivateKeyPath: string;
  bootstrapImage: string;
  launchMode: typeof RUNPOD_DIRECT_LAUNCH_MODE | "bootstrap_image_fallback";
  directTemplateName: string;
};

const ENV_PATH = path.join(process.cwd(), ".secrets", "runpod.env");
const LOCK_PATH = path.join(process.cwd(), ".secrets", "runpod-create.lock");
let createInFlight: Promise<GpuSession> | null = null;

function numberValue(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadRunPodConfig(): RunPodConfig {
  const values = parseEnvFile(ENV_PATH);
  const envKey = process.env.RUNPOD_API_KEY?.trim() ?? "";
  const fileKey = values.get("RUNPOD_API_KEY")?.trim() ?? "";
  const read = (name: string) => process.env[name]?.trim() || values.get(name)?.trim();
  const legacyComputeCap = read("RUNPOD_MAX_HOURLY_USD");
  return {
    apiKey: envKey || fileKey,
    keySource: envKey ? "environment" : fileKey ? "secret_file" : "none",
    maxGpuHourlyUsd: numberValue(read("RUNPOD_MAX_GPU_HOURLY_USD") ?? legacyComputeCap, 0.7),
    maxTotalHourlyUsd: numberValue(read("RUNPOD_MAX_TOTAL_HOURLY_USD"), 0.75),
    maxSessionUsd: numberValue(read("RUNPOD_MAX_SESSION_USD"), 2.5),
    sshPublicKeyPath: read("RUNPOD_SSH_PUBLIC_KEY_PATH") || `${getPrivateKeyPath()}.pub`,
    sshPrivateKeyPath: read("RUNPOD_SSH_PRIVATE_KEY_PATH") || getPrivateKeyPath(),
    bootstrapImage: read("RUNPOD_BOOTSTRAP_IMAGE") || RUNPOD_BOOTSTRAP_IMAGE,
    launchMode: read("RUNPOD_LAUNCH_MODE") === "bootstrap_image_fallback" ? "bootstrap_image_fallback" : RUNPOD_DIRECT_LAUNCH_MODE,
    directTemplateName: read("RUNPOD_DIRECT_TEMPLATE_NAME") || RUNPOD_DIRECT_TEMPLATE_NAME,
  };
}

function finiteNonNegative(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function runPodStorageHourly(containerDiskInGb: number, volumeInGb: number) {
  if (!Number.isFinite(containerDiskInGb) || containerDiskInGb < 0 || !Number.isFinite(volumeInGb) || volumeInGb < 0) throw new Error("runpod_storage_price_input_invalid");
  return (containerDiskInGb * RUNPOD_CONTAINER_STORAGE_USD_PER_GB_MONTH + volumeInGb * RUNPOD_VOLUME_STORAGE_USD_PER_GB_MONTH) / RUNPOD_BILLING_HOURS_PER_MONTH;
}

export function buildRunPodPriceBreakdown(input: { costPerHr?: unknown; adjustedCostPerHr?: unknown; containerDiskInGb?: unknown; volumeInGb?: unknown; projectedSessionHours?: number }): ProviderPriceBreakdown {
  const adjustedPresent = input.adjustedCostPerHr !== null && input.adjustedCostPerHr !== undefined;
  const computeHourly = finiteNonNegative(adjustedPresent ? input.adjustedCostPerHr : input.costPerHr);
  const containerDiskInGb = finiteNonNegative(input.containerDiskInGb);
  const volumeInGb = finiteNonNegative(input.volumeInGb);
  const projectedSessionHours = input.projectedSessionHours ?? RUNPOD_PROJECTED_SESSION_HOURS;
  if (computeHourly === null) throw new Error("runpod_compute_price_invalid");
  if (containerDiskInGb === null || volumeInGb === null) throw new Error("runpod_storage_fields_invalid");
  if (!Number.isFinite(projectedSessionHours) || projectedSessionHours <= 0) throw new Error("runpod_session_hours_invalid");
  const storageHourly = runPodStorageHourly(containerDiskInGb, volumeInGb);
  const totalHourly = computeHourly + storageHourly;
  return { computeHourly, storageHourly, totalHourly, projectedSessionTotal: totalHourly * projectedSessionHours };
}

export function evaluateRunPodBudget(price: ProviderPriceBreakdown, config: Pick<RunPodConfig, "maxGpuHourlyUsd" | "maxTotalHourlyUsd" | "maxSessionUsd">) {
  for (const [field, value] of Object.entries(price)) if (!Number.isFinite(value) || value < 0) return { accepted: false, reason: `invalid_${field}` } as const;
  if (price.computeHourly > config.maxGpuHourlyUsd) return { accepted: false, reason: "computeHourly" } as const;
  if (price.totalHourly > config.maxTotalHourlyUsd) return { accepted: false, reason: "totalHourly" } as const;
  if (price.projectedSessionTotal > config.maxSessionUsd) return { accepted: false, reason: "projectedSessionTotal" } as const;
  return { accepted: true, reason: null } as const;
}

function redactedLog(endpoint: string, status: number | string, retry: number) {
  console.log(JSON.stringify({ provider: "runpod", endpoint, at: new Date().toISOString(), status, retry }));
}

export class RunPodRestClient {
  constructor(private readonly config: RunPodConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async request<T>(method: string, endpoint: string, body?: unknown, maxRetries = 3): Promise<T> {
    if (!this.config.apiKey) throw new Error("RUNPOD_API_KEY is missing.");
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await this.fetchImpl(`${RUNPOD_API_BASE}${endpoint}`, {
          method,
          signal: controller.signal,
          headers: { Authorization: `Bearer ${this.config.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        redactedLog(endpoint, response.status, retry);
        if (response.ok) return response.status === 204 ? (undefined as T) : (await response.json()) as T;
        if (response.status !== 429 && response.status < 500) throw new Error(`runpod_deterministic_http_${response.status}`);
        if (retry === maxRetries) throw new Error(`runpod_retry_exhausted_http_${response.status}`);
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** retry));
      } catch (error) {
        const timeout = error instanceof Error && error.name === "AbortError";
        if (!timeout || retry === maxRetries) throw error;
        redactedLog(endpoint, "timeout", retry);
        await sleep(1000 * (2 ** retry));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("runpod_request_failed");
  }

  listPods() { return this.request<RunPodPod[]>("GET", "/pods?computeType=GPU&includeMachine=true"); }
  listTemplates() { return this.request<RunPodTemplate[]>("GET", "/templates"); }
  createTemplate(payload: Record<string, unknown>) { return this.request<RunPodTemplate>("POST", "/templates", payload, 0); }
  getPod(id: string) { return this.request<RunPodPod>("GET", `/pods/${encodeURIComponent(id)}?includeMachine=true`); }
  createPod(payload: Record<string, unknown>) { return this.request<RunPodPod>("POST", "/pods", payload, 0); }
  stopPod(id: string) { return this.request<void>("POST", `/pods/${encodeURIComponent(id)}/stop`); }
  deletePod(id: string) { return this.request<void>("DELETE", `/pods/${encodeURIComponent(id)}`); }
}

type RunPodAvailabilityPrice = {
  stockStatus?: "High" | "Medium" | "Low" | "None" | null;
  uninterruptablePrice?: number | null;
  availableGpuCounts?: number[] | null;
};

export type RunPodGpuAvailability = {
  id: string;
  memoryInGb: number;
  secureCloud: boolean;
  communityCloud: boolean;
  secure: RunPodAvailabilityPrice | null;
  community: RunPodAvailabilityPrice | null;
};

export class RunPodAvailabilityClient {
  constructor(private readonly config: RunPodConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async inspect(gpuTypeId: string): Promise<RunPodGpuAvailability> {
    if (!this.config.apiKey) throw new Error("RUNPOD_API_KEY is missing.");
    const query = `query { gpuTypes(input: { id: ${JSON.stringify(gpuTypeId)} }) { id memoryInGb secureCloud communityCloud secure: lowestPrice(input: { gpuCount: 1, secureCloud: true }) { stockStatus uninterruptablePrice availableGpuCounts } community: lowestPrice(input: { gpuCount: 1, secureCloud: false }) { stockStatus uninterruptablePrice availableGpuCounts } } }`;
    const response = await this.fetchImpl(`${RUNPOD_GRAPHQL_BASE}?api_key=${encodeURIComponent(this.config.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) throw new Error(`runpod_availability_http_${response.status}`);
    const payload = await response.json() as { data?: { gpuTypes?: RunPodGpuAvailability[] }; errors?: unknown[] };
    if (payload.errors?.length) throw new Error("runpod_availability_graphql_error");
    const result = payload.data?.gpuTypes?.find((item) => item.id === gpuTypeId);
    if (!result) throw new Error("runpod_gpu_type_not_found");
    return result;
  }
}

function priceIsAvailable(price: RunPodAvailabilityPrice | null | undefined) {
  const gpuCountAvailable = !Array.isArray(price?.availableGpuCounts) || price.availableGpuCounts.includes(1);
  return Boolean(price && price.stockStatus && price.stockStatus !== "None" && gpuCountAvailable && finiteNonNegative(price.uninterruptablePrice) !== null);
}

export function candidatesFromAvailability(checks: RunPodGpuAvailability[], maxGpuHourlyUsd = 0.7): GpuCandidate[] {
  const byId = new Map(checks.map((item) => [item.id, item]));
  const secure: GpuCandidate[] = [];
  const community: GpuCandidate[] = [];
  for (const [gpuType, configuredVram, priorityIndex] of RUNPOD_GPU_PRIORITY.map((entry, index) => [entry[0], entry[1], index] as const)) {
    const check = byId.get(gpuType);
    if (!check || check.memoryInGb < 16) continue;
    const base = { id: gpuType, gpuType, priority: priorityIndex + 1, vramGb: check.memoryInGb || configuredVram, gpuCount: 1 as const, minimumRamGb: 32, containerDiskGb: 50, volumeGb: 30, interruptible: false as const };
    if (check.secureCloud && priceIsAvailable(check.secure)) {
      const hourlyUsd = finiteNonNegative(check.secure?.uninterruptablePrice);
      if (hourlyUsd !== null && hourlyUsd <= maxGpuHourlyUsd) secure.push({ ...base, hourlyUsd, cloudType: "SECURE", availability: check.secure?.stockStatus ?? "Unknown" });
    }
    if (check.communityCloud && priceIsAvailable(check.community)) {
      const hourlyUsd = finiteNonNegative(check.community?.uninterruptablePrice);
      if (hourlyUsd !== null && hourlyUsd <= maxGpuHourlyUsd) community.push({ ...base, hourlyUsd, cloudType: "COMMUNITY", availability: check.community?.stockStatus ?? "Unknown" });
    }
  }
  return [...secure, ...community];
}

export function runPodCandidates(maxHourlyUsd = 0.7): GpuCandidate[] {
  return RUNPOD_GPU_PRIORITY.map(([gpuType, vramGb], priority) => ({ id: gpuType, gpuType, priority: priority + 1, vramGb, gpuCount: 1, minimumRamGb: 32, containerDiskGb: 50, volumeGb: 30, hourlyUsd: maxHourlyUsd, cloudType: "SECURE", availability: "Unknown", interruptible: false }));
}

export function buildRunPodCreatePayload(input: CreateSessionInput) {
  if (input.candidate.gpuCount !== 1 || input.candidate.vramGb < 16 || input.candidate.minimumRamGb < 32) throw new Error("runpod_hardware_gate_failed");
  if (input.candidate.containerDiskGb < 50 || input.candidate.volumeGb < 30) throw new Error("runpod_disk_gate_failed");
  if (input.candidate.interruptible) throw new Error("runpod_spot_forbidden");
  if (!/^ssh-(ed25519|rsa|ecdsa-[^ ]+) [A-Za-z0-9+/=]+(?: .*)?$/.test(input.sshPublicKey) || /PRIVATE KEY/.test(input.sshPublicKey)) throw new Error("runpod_ssh_public_key_invalid");
  return buildRunPodDirectPodPayload(input, "dry-run-template");
}

function assertSshPublicKey(value: string) {
  if (!/^ssh-(ed25519|rsa|ecdsa-[^ ]+) [A-Za-z0-9+/=]+(?: .*)?$/.test(value) || /PRIVATE KEY/.test(value)) throw new Error("runpod_ssh_public_key_invalid");
}

export function buildRunPodDirectTemplatePayload(input: { name?: string; runtimeImage?: string; sshPublicKey: string }) {
  const imageName = input.runtimeImage ?? FIXED_RUNTIME_DIGEST;
  if (imageName !== FIXED_RUNTIME_DIGEST || !imageName.includes("@sha256:")) throw new Error("runpod_direct_runtime_digest_invalid");
  assertSshPublicKey(input.sshPublicKey);
  return {
    name: input.name ?? RUNPOD_DIRECT_TEMPLATE_NAME,
    imageName,
    category: "NVIDIA",
    containerDiskInGb: 50,
    dockerEntrypoint: ["/bin/bash", "-lc"],
    dockerStartCmd: [RUNPOD_DIRECT_SSH_COMMAND],
    env: { PUBLIC_KEY: input.sshPublicKey },
    isPublic: false,
    isServerless: false,
    ports: ["22/tcp", "8080/http"],
    readme: "Private direct SSH bootstrap for one first-image session.",
    volumeInGb: 30,
    volumeMountPath: "/workspace",
  };
}

export function buildRunPodDirectPodPayload(input: CreateSessionInput, templateId: string) {
  if (!templateId) throw new Error("runpod_direct_template_id_missing");
  if (input.candidate.gpuCount !== 1 || input.candidate.vramGb < 16 || input.candidate.minimumRamGb < 32) throw new Error("runpod_hardware_gate_failed");
  if (input.candidate.containerDiskGb < 50 || input.candidate.volumeGb < 30) throw new Error("runpod_disk_gate_failed");
  if (input.candidate.interruptible) throw new Error("runpod_spot_forbidden");
  return {
    name: `ai-video-first-image-${input.sessionId}`.slice(0, 191),
    templateId,
    cloudType: input.candidate.cloudType ?? "SECURE",
    computeType: "GPU",
    gpuTypeIds: [input.candidate.id],
    gpuTypePriority: "custom",
    gpuCount: 1,
    minRAMPerGPU: 32,
    containerDiskInGb: 50,
    volumeInGb: 30,
    volumeMountPath: "/workspace",
    supportPublicIp: true,
    interruptible: false,
    locked: false,
    ports: ["22/tcp", "8080/http"],
  };
}

export function validateRunPodDirectTemplate(template: RunPodTemplate, expected: ReturnType<typeof buildRunPodDirectTemplatePayload>) {
  const errors: string[] = [];
  if (template.imageName !== expected.imageName) errors.push("imageName");
  // RunPod omits false boolean fields from GET /templates responses.
  if (template.isPublic === true) errors.push("isPublic");
  if (template.isServerless === true) errors.push("isServerless");
  if (template.containerDiskInGb !== expected.containerDiskInGb) errors.push("containerDiskInGb");
  if (template.volumeInGb !== expected.volumeInGb || template.volumeMountPath !== expected.volumeMountPath) errors.push("volume");
  if (JSON.stringify(template.dockerEntrypoint) !== JSON.stringify(expected.dockerEntrypoint)) errors.push("dockerEntrypoint");
  if (JSON.stringify(template.dockerStartCmd) !== JSON.stringify(expected.dockerStartCmd)) errors.push("dockerStartCmd");
  if (JSON.stringify(template.ports) !== JSON.stringify(expected.ports)) errors.push("ports");
  if (template.env?.PUBLIC_KEY !== expected.env.PUBLIC_KEY || Object.keys(template.env ?? {}).some((key) => key !== "PUBLIC_KEY")) errors.push("env");
  return errors;
}

function profileForGpu(gpu: string) {
  if (gpu === "NVIDIA GeForce RTX 4090") return "rtx4090" as const;
  if (gpu === "NVIDIA GeForce RTX 5090") return "rtx5090" as const;
  return "bootstrap_image_gpu" as const;
}

function podPrice(pod: RunPodPod) {
  try {
    return buildRunPodPriceBreakdown(pod);
  } catch {
    return null;
  }
}

function toSession(pod: RunPodPod, config: RunPodConfig): GpuSession {
  const price = podPrice(pod);
  const costPerHr = finiteNonNegative(pod.costPerHr);
  const adjustedCostPerHr = finiteNonNegative(pod.adjustedCostPerHr);
  const containerDiskInGb = finiteNonNegative(pod.containerDiskInGb);
  const volumeInGb = finiteNonNegative(pod.volumeInGb);
  const host = pod.publicIp ?? "";
  const port = Number(pod.portMappings?.["22"] ?? 0);
  const gpu = pod.machine?.gpuTypeId ?? pod.gpu?.displayName ?? "";
  const target: GpuTarget | null = host && port ? { provider: "runpod", host, port, username: "root", sshKeyPath: config.sshPrivateKeyPath, gpuProfile: profileForGpu(gpu), runtimeDigest: FIXED_RUNTIME_DIGEST } : null;
  return {
    provider: "runpod",
    id: pod.id,
    name: pod.name ?? pod.id,
    status: pod.desiredStatus ?? "UNKNOWN",
    createdAt: pod.lastStartedAt ?? null,
    lastStatusChange: pod.lastStatusChange ?? null,
    hourlyUsd: price?.totalHourly ?? null,
    price,
    costPerHr,
    adjustedCostPerHr,
    containerDiskInGb,
    volumeInGb,
    cloudType: pod.cloudType === "COMMUNITY" || pod.machine?.secureCloud === false ? "COMMUNITY" : pod.cloudType === "SECURE" || pod.machine?.secureCloud === true ? "SECURE" : null,
    gpuType: pod.gpuTypeId ?? pod.machine?.gpuTypeId ?? pod.gpu?.displayName ?? null,
    target,
  };
}

function isActive(pod: RunPodPod) { return pod.desiredStatus !== "TERMINATED"; }

export class RunPodProvider implements GpuProvider {
  readonly id = "runpod" as const;
  readonly config: RunPodConfig;
  readonly client: RunPodRestClient;
  readonly availabilityClient: RunPodAvailabilityClient;

  constructor(options: { config?: RunPodConfig; fetchImpl?: typeof fetch } = {}) {
    this.config = options.config ?? loadRunPodConfig();
    this.client = new RunPodRestClient(this.config, options.fetchImpl);
    this.availabilityClient = new RunPodAvailabilityClient(this.config, options.fetchImpl);
  }

  async inspectCredentials() { return { provider: this.id, credentials_present: Boolean(this.config.apiKey), source: this.config.keySource, safe_to_query: Boolean(this.config.apiKey) }; }
  async getBalance() { return { availableUsd: null, supported: false }; }
  async listCandidates() {
    if (!this.config.apiKey) return runPodCandidates(this.config.maxGpuHourlyUsd);
    const checks = await Promise.all(RUNPOD_GPU_PRIORITY.map(([gpuType]) => this.availabilityClient.inspect(gpuType)));
    for (const check of checks) {
      console.log(JSON.stringify({
        provider: "runpod",
        event: "availability_check",
        gpuTypeId: check.id,
        secure: { supported: check.secureCloud, stockStatus: check.secure?.stockStatus ?? "Unknown", computeHourly: finiteNonNegative(check.secure?.uninterruptablePrice) },
        community: { supported: check.communityCloud, stockStatus: check.community?.stockStatus ?? "Unknown", computeHourly: finiteNonNegative(check.community?.uninterruptablePrice), supportPublicIpRequired: true },
      }));
    }
    return candidatesFromAvailability(checks, this.config.maxGpuHourlyUsd);
  }
  async getSession(id: string) { try { return toSession(await this.client.getPod(id), this.config); } catch (error) { if (String(error).includes("404")) return null; throw error; } }
  async recoverExistingSession(sessionId?: string) {
    if (!this.config.apiKey) return null;
    const name = sessionId ? `ai-video-first-image-${sessionId}` : "ai-video-first-image-";
    const found = (await this.client.listPods()).filter(isActive).find((pod) => (pod.name ?? "").startsWith(name));
    return found ? toSession(found, this.config) : null;
  }

  async createSession(input: CreateSessionInput): Promise<GpuSession> {
    if (input.dryRun) {
      const price = input.candidate.hourlyUsd === null ? null : buildRunPodPriceBreakdown({ costPerHr: input.candidate.hourlyUsd, containerDiskInGb: input.candidate.containerDiskGb, volumeInGb: input.candidate.volumeGb });
      return { provider: this.id, id: "dry-run", name: `ai-video-first-image-${input.sessionId}`, status: "DRY_RUN", createdAt: null, lastStatusChange: null, hourlyUsd: price?.totalHourly ?? null, price, costPerHr: input.candidate.hourlyUsd, adjustedCostPerHr: null, containerDiskInGb: input.candidate.containerDiskGb, volumeInGb: input.candidate.volumeGb, cloudType: input.candidate.cloudType ?? "SECURE", gpuType: input.candidate.gpuType, target: null };
    }
    if (createInFlight) return createInFlight;
    createInFlight = this.createSessionLocked(input).finally(() => { createInFlight = null; });
    return createInFlight;
  }

  private async createSessionLocked(input: CreateSessionInput) {
    if (!this.config.apiKey) throw new Error("RUNPOD_API_KEY is missing.");
    if (this.config.launchMode !== RUNPOD_DIRECT_LAUNCH_MODE) throw new Error("runpod_bootstrap_fallback_not_enabled_for_stage3k");
    const estimatedPrice = buildRunPodPriceBreakdown({ costPerHr: input.candidate.hourlyUsd, containerDiskInGb: input.candidate.containerDiskGb, volumeInGb: input.candidate.volumeGb });
    const estimatedGate = evaluateRunPodBudget(estimatedPrice, this.config);
    if (!estimatedGate.accepted) throw new Error(`runpod_estimated_budget_exceeded:${estimatedGate.reason}`);
    mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    let fd: number;
    try { fd = openSync(LOCK_PATH, "wx"); } catch { throw new Error("runpod_create_lock_exists"); }
    try {
      writeFileSync(fd, `${JSON.stringify({ session_id: input.sessionId, created_at: new Date().toISOString() })}\n`);
      closeSync(fd);
      const existing = await this.recoverExistingSession(input.sessionId);
      if (existing) return existing;
      const active = (await this.client.listPods()).filter(isActive);
      if (active.length > 0) throw new Error("runpod_active_pod_exists");
      const expectedTemplate = buildRunPodDirectTemplatePayload({ name: this.config.directTemplateName, runtimeImage: FIXED_RUNTIME_DIGEST, sshPublicKey: input.sshPublicKey });
      const existingTemplates = await this.client.listTemplates();
      const matches = existingTemplates.filter((template) => template.name === this.config.directTemplateName);
      if (matches.length > 1) throw new Error("runpod_direct_template_duplicate");
      let template = matches[0];
      if (template) {
        const drift = validateRunPodDirectTemplate(template, expectedTemplate);
        if (drift.length) throw new Error(`runpod_direct_template_drift:${drift.join(",")}`);
      } else {
        template = await this.client.createTemplate(expectedTemplate);
      }
      if (!template.id) throw new Error("runpod_direct_template_id_missing");
      const created = await this.client.createPod(buildRunPodDirectPodPayload(input, template.id));
      let session = toSession(created, this.config);
      const priceDeadline = Date.now() + 10_000;
      while (session.price === null && Date.now() < priceDeadline) {
        const current = await this.getSession(session.id);
        if (current) session = current;
        if (session.price === null) await sleep(1_000);
      }
      if (session.price === null) {
        console.log(JSON.stringify({ provider: "runpod", event: "post_create_price_gate", pod_id: session.id, costPerHr: session.costPerHr, adjustedCostPerHr: session.adjustedCostPerHr, containerDiskInGb: session.containerDiskInGb, volumeInGb: session.volumeInGb, computeHourly: null, storageHourly: null, totalHourly: null, projectedSessionTotal: null, rejectedField: "price_components", action: "delete" }));
        await this.client.deletePod(session.id);
        throw new Error("runpod_created_price_unavailable");
      }
      const gate = evaluateRunPodBudget(session.price, this.config);
      console.log(JSON.stringify({ provider: "runpod", event: "post_create_price_gate", pod_id: session.id, gpuTypeId: session.gpuType, cloudType: session.cloudType, costPerHr: session.costPerHr, adjustedCostPerHr: session.adjustedCostPerHr, containerDiskInGb: session.containerDiskInGb, volumeInGb: session.volumeInGb, ...session.price, maxGpuHourly: this.config.maxGpuHourlyUsd, maxTotalHourly: this.config.maxTotalHourlyUsd, maxSession: this.config.maxSessionUsd, accepted: gate.accepted, rejectedField: gate.reason, action: gate.accepted ? "continue" : "delete" }));
      if (!gate.accepted) {
        await this.client.deletePod(session.id);
        throw new Error(`runpod_created_price_exceeded:${gate.reason}`);
      }
      return session;
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message))) {
        const recovered = await this.recoverExistingSession(input.sessionId);
        if (recovered) return recovered;
      }
      throw error;
    } finally {
      rmSync(LOCK_PATH, { force: true });
    }
  }

  async waitForSsh(session: GpuSession, timeoutMs = 10 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.getSession(session.id);
      if (!current) throw new Error("runpod_session_disappeared");
      if (current.status === "RUNNING" && current.target && await tcpReachable(current.target.host, current.target.port)) {
        if (sshCommand(current.target, "true").status === 0) return current.target;
      }
      await sleep(10_000);
    }
    throw new Error("runpod_ssh_timeout");
  }

  async stopSession(session: GpuSession) { if (session.id !== "dry-run") await this.client.stopPod(session.id); }
  async terminateSession(session: GpuSession) {
    if (session.id === "dry-run") return;
    await this.client.deletePod(session.id);
    const deadline = Date.now() + 2 * 60_000;
    while (Date.now() < deadline) {
      const current = await this.getSession(session.id);
      if (!current || current.status === "TERMINATED") return;
      await sleep(5_000);
    }
    throw new Error("runpod_termination_not_confirmed");
  }
  async getBilling(session: GpuSession) {
    const elapsedSeconds = session.createdAt ? Math.max(0, (Date.now() - Date.parse(session.createdAt)) / 1000) : null;
    return { hourlyUsd: session.price?.totalHourly ?? null, computeHourly: session.price?.computeHourly ?? null, storageHourly: session.price?.storageHourly ?? null, totalHourly: session.price?.totalHourly ?? null, projectedSessionTotal: session.price?.projectedSessionTotal ?? null, elapsedSeconds, estimatedSpendUsd: elapsedSeconds !== null && session.price !== null ? session.price.totalHourly * elapsedSeconds / 3600 : null };
  }
}

export function runPodWatchdogPlan(sessionId: string, deadlineMinutes = 15) {
  return { provider: "runpod", session_id: sessionId, action: "terminate", deadline_minutes: deadlineMinutes, terminate_priority: true };
}

