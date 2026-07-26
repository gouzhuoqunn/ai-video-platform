import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloreConfig, COMFY_RUNTIME_IMAGE, PROJECT_TAG } from "./clore/config";
import { classifyImageGpu, type ImageGpuClass } from "../src/lib/image-generation/flux-stack";
import { loadCloreExecutionConfig } from "./clore/execution-config";
import { readLiveMarketplace, readLiveOrdersSummary } from "./clore/live";
import { evaluateMarketplace } from "./clore/marketplace";
import { buildHttpRuntimeCreateOrderBody, createCloreOrder } from "./clore/order-execution";
import { cancelCloreOrder } from "./clore/cancel-execution";
import { buildCloreUrl, CloreApiError, CloreCreateRetryReconciledError, CloreRateLimitError, cloreRequest, sleep } from "./clore/client";
import { writeActiveOrder } from "./clore/order-state";
import { orderRecords, parseCloreOrder } from "./clore/order-readiness-parser";
import { recordDeploymentFailure, recordTemporaryDeploymentDeny } from "./clore/deployment-host-blacklist";
import { persistImageResult } from "./image-executor/result-persistence";
import { readSourceAcquisitionManifest, readValidatedRestoreManifest, validateValidatedRestoreManifest, type SourceAcquisitionManifest, type ValidatedRestoreManifest } from "./image-executor/manifests";
import { assertImageExecutorReady, IMAGE_RUNNER_PRECHECK_STAGE, RESTORE_OR_BOOTSTRAP_BLOCKER } from "./image-executor/readiness";
import { assertRtx4090GoldenDeploymentProfile } from "./image-executor/rtx4090-golden-deployment-profile";
import { runLiveImageSession, type SessionReceipt } from "./clore/image-session-live";
import { FrozenImageSessionMembershipChangedError, hydrateFrozenImageSessionPlan } from "./clore/image-session";

export type ImageTask = {
  id: string;
  prompt: string;
  referenceImage: string | null;
  mode: string;
  gpuClass: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  loraStrength: number;
  sampler: "Euler" | "FlowMatch";
  seed: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  result?: {
    imagePath: string;
    thumbnailPath: string;
    sha256: string;
    width: number;
    height: number;
    metadataPath: string;
    persistedAt: string;
  };
};

export type ImageRunnerSession = {
  state: "idle" | "running" | "failed" | "completed" | "cancelling";
  stage: string;
  frozenTaskIds: string[];
  gpuClass: "rtx4090" | "rtx5090" | null;
  maxHourlyPrice: number;
  currentTaskIndex: number | null;
  currentModel: string | null;
  promptSummary: string | null;
  startedAt: string | null;
  updatedAt: string;
  host: Record<string, unknown> | null;
  error: {
    stage: string;
    message: string;
    at: string;
    cancellationError?: string;
    billingRisk?: string;
    operation?: string;
    method?: string;
    targetHost?: string;
    targetPath?: string;
    classification?: string;
    technicalCause?: string;
  } | null;
  blocker: string | null;
  pid?: number | null;
  logPath?: string | null;
  createAttempt?: {
    id: string;
    startedAt: string;
    phase: "creating_order" | "create_order_rate_limited" | "reconciling_create_order" | "waiting_create_retry" | "order_created_waiting_deployment" | "create_order_failed" | "ambiguous_active_orders";
    requestAttempts: number;
  } | null;
};

type CloreConfig = ReturnType<typeof loadCloreConfig>;
type CloreExecution = ReturnType<typeof loadCloreExecutionConfig>;
type OrderSummary = Awaited<ReturnType<typeof readLiveOrdersSummary>>[number];
type MarketplacePayload = Awaited<ReturnType<typeof readLiveMarketplace>>;
type RuntimeCandidate = ReturnType<typeof evaluateMarketplace>["matches"][number];

export function targetGpuForImageClass(gpuClass: ImageGpuClass) {
  return gpuClass === "rtx5090" ? "NVIDIA GeForce RTX 5090" as const : "NVIDIA GeForce RTX 4090" as const;
}

export function chooseCheapestImageCandidate<T extends { gpuNormalizedName: string; orderType: string; hostOnline: boolean | null; priceUsdPerHour: number | null }>(candidates: readonly T[], gpuClass: ImageGpuClass, maxHourlyPrice: number): T | null {
  const targetGpu = targetGpuForImageClass(gpuClass);
  return [...candidates]
    .filter((candidate) => candidate.gpuNormalizedName === targetGpu && candidate.orderType === "on-demand" && candidate.hostOnline !== false && candidate.priceUsdPerHour !== null && candidate.priceUsdPerHour <= maxHourlyPrice)
    .sort((left, right) => (left.priceUsdPerHour ?? Infinity) - (right.priceUsdPerHour ?? Infinity))[0] ?? null;
}

const CREATE_ORDER_HARD_TIMEOUT_MS = 60_000;
const HTTP_READINESS_TIMEOUT_MS = 12 * 60 * 1000;
const DEPLOYING_PROXY_502_TIMEOUT_MS = 6 * 60 * 1000;
const HTTP_READINESS_POLL_MS = 10_000;

class CreateOrderHardTimeoutError extends Error {
  readonly detail: SanitizedFetchFailure;
  constructor(detail?: SanitizedFetchFailure) {
    super(`create_order timed out after ${CREATE_ORDER_HARD_TIMEOUT_MS}ms; reconciling /my_orders before failure.`);
    this.name = "CreateOrderHardTimeoutError";
    this.detail = detail ?? createOrderFailureDetail(new Error("create_order_hard_timeout"), defaultCreateOrderContext());
  }
}

class CreateOrderRequestError extends Error {
  readonly detail: SanitizedFetchFailure;
  constructor(detail: SanitizedFetchFailure) {
    super(detail.readableMessage);
    this.name = "CreateOrderRequestError";
    this.detail = detail;
  }
}

class CreateOrderNoOrderFailure extends Error {
  readonly detail: SanitizedFetchFailure;
  constructor(detail: SanitizedFetchFailure) {
    super(detail.readableMessage);
    this.name = "CreateOrderNoOrderFailure";
    this.detail = detail;
  }
}

class HttpReadinessTimeoutError extends Error {
  readonly orderId: string;
  constructor(orderId: string) {
    super("订单已创建，但图片运行环境在 12 分钟内未就绪，系统已自动退租。");
    this.name = "HttpReadinessTimeoutError";
    this.orderId = orderId;
  }
}

class DeployingProxy502TimeoutError extends Error {
  readonly orderId: string;
  readonly serverId: string | null;
  constructor(orderId: string, serverId: string | null) {
    super("订单已创建，但 Clore 部署状态持续 deploying 且 /healthz 代理层 502 超过 6 分钟，系统已自动退租。");
    this.name = "DeployingProxy502TimeoutError";
    this.orderId = orderId;
    this.serverId = serverId;
  }
}

export type RunnerDeps = {
  loadConfig: () => CloreConfig;
  loadExecution: () => CloreExecution;
  readMarketplace: (config: CloreConfig) => Promise<MarketplacePayload>;
  readOrders: (config: CloreConfig) => Promise<OrderSummary[]>;
  createOrder: typeof createCloreOrder;
  cancelOrder: typeof cancelCloreOrder;
  fetchJson: (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;
  fetchBinary: (url: string, init?: RequestInit) => Promise<Buffer>;
  fetchHealth?: (url: string) => Promise<{ ok: boolean; status: number | null; error: string | null }>;
  cloreRequest: typeof cloreRequest;
  sleep: (ms: number) => Promise<void>;
  runLiveSession: (input: Parameters<typeof runLiveImageSession>[0]) => Promise<SessionReceipt>;
};

function runnerPaths() {
  const dataDir = path.join(process.cwd(), ".secrets", "image-studio");
  return {
    dataDir,
    taskPath: path.join(dataDir, "tasks.json"),
    runnerPath: path.join(dataDir, "runner-session.json"),
    restorePath: path.join(dataDir, "fluxed-up-10.2-rtx4090-text.restore.json"),
    sourceManifestPath: path.join(process.cwd(), "comfy-runtime", "image-source-artifacts.json"),
    resultsDir: path.join(process.cwd(), "local-data", "image-results"),
  };
}

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readRunner() {
  const { runnerPath } = runnerPaths();
  return readJson<ImageRunnerSession>(runnerPath, {
    state: "idle",
    stage: "当前未租用显卡",
    frozenTaskIds: [],
    gpuClass: null,
    maxHourlyPrice: 0.6,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    host: null,
    error: null,
    blocker: null,
    pid: null,
    logPath: null,
  });
}

function updateRunner(patch: Partial<ImageRunnerSession>) {
  const { runnerPath } = runnerPaths();
  writeJson(runnerPath, { ...readRunner(), ...patch, updatedAt: new Date().toISOString() });
}

function readableError(error: unknown) {
  if (error instanceof FrozenImageSessionMembershipChangedError) {
    return `任务 ${error.taskId} 在启动前发生变化，已取消本次启动，请刷新后重试。`;
  }
  const membership = /^image_session_planned_task_changed:([^\s]+)$/.exec(String(error instanceof Error ? error.message : error));
  if (membership) {
    return `任务 ${membership[1]} 在启动前发生变化，已取消本次启动，请刷新后重试。`;
  }
  const detail = createOrderFailureDetailFromError(error);
  if (detail) return detail.readableMessage;
  const message = error instanceof Error ? error.message : String(error);
  if (message === "validated_restore_manifest_missing_and_bootstrap_not_configured" || message === RESTORE_OR_BOOTSTRAP_BLOCKER) {
    return "未找到已验证的 FLUX 模型恢复清单，且首次模型下载配置尚未完成。";
  }
  return message;
}

type SanitizedFetchFailure = {
  operation: string;
  stage: string;
  method: string;
  targetHost: string;
  targetPath: string;
  timeoutMs: number | null;
  httpStatus: number | null;
  responseBody: string | null;
  causeCode: string | null;
  errno: string | number | null;
  syscall: string | null;
  address: string | null;
  port: number | string | null;
  classification: "dns" | "tls" | "timeout" | "reset" | "rate_limited" | "server_error" | "connection_refused" | "network_error" | "http_error";
  readableMessage: string;
  rawMessage: string;
};

type CreateOrderFailureContext = {
  operation: string;
  stage: string;
  method: string;
  url: string;
  timeoutMs: number | null;
  httpStatus?: number | null;
  responseBody?: unknown;
};

function defaultCreateOrderContext(): CreateOrderFailureContext {
  return {
    operation: "clore.create_order",
    stage: "creating_order",
    method: "POST",
    url: "https://api.clore.ai/v1/create_order",
    timeoutMs: CREATE_ORDER_HARD_TIMEOUT_MS,
  };
}

function createOrderContext(config: CloreConfig): CreateOrderFailureContext {
  return {
    ...defaultCreateOrderContext(),
    url: buildCloreUrl(config, "/create_order"),
  };
}

function truncateForUi(value: unknown, max = 1200) {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const sanitized = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
    .replace(/api[_-]?key["'\s:=]+[A-Za-z0-9._~+/-]+=*/gi, "api_key=<redacted>")
    .replace(/ssh-(?:ed25519|rsa)\s+[A-Za-z0-9+/=]+(?:\s+\S+)?/g, "<redacted-ssh-key>");
  return sanitized.length > max ? `${sanitized.slice(0, max)}…` : sanitized;
}

function sanitizedUrlParts(urlString: string) {
  try {
    const url = new URL(urlString);
    return {
      host: url.host,
      path: url.pathname || "/",
    };
  } catch {
    return { host: "unknown", path: "/" };
  }
}

function pickCause(error: unknown) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const cause = record.cause && typeof record.cause === "object" ? (record.cause as Record<string, unknown>) : record;
  return { record, cause };
}

function classifyFetchFailure(input: { status?: number | null; code?: string | null; message: string }) {
  const code = String(input.code ?? "").toUpperCase();
  const message = input.message.toLowerCase();
  if (input.status === 429) return "rate_limited" as const;
  if (typeof input.status === "number" && input.status >= 500) return "server_error" as const;
  if (typeof input.status === "number") return "http_error" as const;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("getaddrinfo")) return "dns" as const;
  if (code.includes("CERT") || code.includes("TLS") || code.includes("SSL") || message.includes("tls") || message.includes("certificate")) return "tls" as const;
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "ABORT_ERR" || message.includes("timeout") || message.includes("timed out")) return "timeout" as const;
  if (code === "ECONNRESET" || message.includes("reset")) return "reset" as const;
  if (code === "ECONNREFUSED") return "connection_refused" as const;
  return "network_error" as const;
}

function readableCreateOrderMessage(classification: SanitizedFetchFailure["classification"], status: number | null) {
  if (classification === "timeout") return "调用 Clore 创建订单接口失败：连接超时。";
  if (classification === "dns") return "调用 Clore 创建订单接口失败：DNS 解析失败。";
  if (classification === "tls") return "调用 Clore 创建订单接口失败：TLS 握手失败。";
  if (classification === "reset") return "调用 Clore 创建订单接口失败：连接被重置。";
  if (classification === "connection_refused") return "调用 Clore 创建订单接口失败：连接被拒绝。";
  if (classification === "rate_limited") return "调用 Clore 创建订单接口失败：Clore 接口限流。";
  if (classification === "server_error") return `调用 Clore 创建订单接口失败：Clore 服务端错误${status ? ` ${status}` : ""}。`;
  if (classification === "http_error") return `调用 Clore 创建订单接口失败：Clore 返回 HTTP ${status ?? "错误"}。`;
  return "调用 Clore 创建订单接口失败：网络请求失败。";
}

function createOrderFailureDetail(error: unknown, context: CreateOrderFailureContext): SanitizedFetchFailure {
  const { record, cause } = pickCause(error);
  const rateLimit = error instanceof CloreRateLimitError ? error.failure : null;
  const providerFailure = error instanceof CloreApiError ? error.failure : null;
  const status = typeof context.httpStatus === "number" ? context.httpStatus : rateLimit?.httpStatus ?? providerFailure?.httpStatus ?? null;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const causeMessage = typeof cause.message === "string" ? cause.message : rawMessage;
  const code = typeof cause.code === "string" ? cause.code : typeof record.code === "string" ? record.code : rateLimit ? `clore_code_${rateLimit.code}` : providerFailure ? `clore_code_${providerFailure.code}` : null;
  const classification = classifyFetchFailure({ status, code, message: `${rawMessage} ${causeMessage}` });
  const url = sanitizedUrlParts(context.url);
  return {
    operation: context.operation,
    stage: context.stage,
    method: context.method,
    targetHost: url.host,
    targetPath: url.path,
    timeoutMs: context.timeoutMs,
    httpStatus: status,
    responseBody: truncateForUi(context.responseBody),
    causeCode: code,
    errno: typeof cause.errno === "string" || typeof cause.errno === "number" ? cause.errno : null,
    syscall: typeof cause.syscall === "string" ? cause.syscall : null,
    address: typeof cause.address === "string" ? cause.address : null,
    port: typeof cause.port === "string" || typeof cause.port === "number" ? cause.port : null,
    classification,
    readableMessage: readableCreateOrderMessage(classification, status),
    rawMessage: truncateForUi(causeMessage || rawMessage, 400) ?? rawMessage,
  };
}

function createOrderFailureDetailFromError(error: unknown): SanitizedFetchFailure | null {
  if (error instanceof CreateOrderHardTimeoutError || error instanceof CreateOrderRequestError || error instanceof CreateOrderNoOrderFailure) return error.detail;
  const maybe = error && typeof error === "object" ? (error as { detail?: unknown }) : {};
  return maybe.detail && typeof maybe.detail === "object" ? (maybe.detail as SanitizedFetchFailure) : null;
}

function technicalCauseText(detail: SanitizedFetchFailure, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ...detail, ...extra }, null, 2);
}

function failRunner(stage: string, error: unknown, cancellationError?: unknown, blocker?: string) {
  const machine = error instanceof Error ? error.message : String(error);
  const detail = createOrderFailureDetailFromError(error);
  const membershipChanged = error instanceof FrozenImageSessionMembershipChangedError || machine.startsWith("image_session_planned_task_changed:");
  updateRunner({
    state: "failed",
    stage,
    blocker: blocker ?? (membershipChanged ? readableError(error) : machine),
    error: {
      stage,
      message: readableError(error),
      at: new Date().toISOString(),
      cancellationError: cancellationError ? (cancellationError instanceof Error ? cancellationError.message : String(cancellationError)) : undefined,
      billingRisk: cancellationError ? "订单可能仍在计费" : undefined,
      operation: detail?.operation,
      method: detail?.method,
      targetHost: detail?.targetHost,
      targetPath: detail?.targetPath,
      classification: detail?.classification,
      technicalCause: detail ? technicalCauseText(detail) : undefined,
    },
  });
}

function isValidFrozenTask(task: ImageTask, gpuClass: ImageGpuClass) {
  return (
    task.mode === "text_generation" &&
    !task.referenceImage &&
    task.gpuClass === gpuClass &&
    classifyImageGpu(task.width, task.height) === gpuClass &&
    task.steps >= 25 &&
    task.steps <= 40 &&
    task.cfg >= 3.5 &&
    task.cfg <= 5 &&
    task.loraStrength >= 0.6 &&
    task.loraStrength <= 1.1 &&
    task.prompt.trim().length > 0
  );
}

function secretFromFile(fileName: string, key: string) {
  const env = process.env[key]?.trim();
  if (env) return env;
  const filePath = path.join(process.cwd(), ".secrets", fileName);
  if (!existsSync(filePath)) return "";
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] === key) return match[2].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

function huggingFaceUrl(artifact: SourceAcquisitionManifest["artifacts"][number]) {
  if (!artifact.repository || !artifact.revision) throw new Error(`bootstrap_hf_source_incomplete:${artifact.id}`);
  return `https://huggingface.co/${artifact.repository}/resolve/${artifact.revision}/${artifact.filename}`;
}

function civitaiUrl(artifact: SourceAcquisitionManifest["artifacts"][number]) {
  if (!artifact.version_id) throw new Error(`bootstrap_civitai_source_incomplete:${artifact.id}`);
  const token = secretFromFile("civitai.env", "CIVITAI_API_TOKEN");
  if (!token) throw new Error("missing_bootstrap_secret:CIVITAI_API_TOKEN");
  return `https://civitai.com/api/download/models/${artifact.version_id}?token=${encodeURIComponent(token)}`;
}

function transientRestoreManifestFromSource(source: SourceAcquisitionManifest): ValidatedRestoreManifest {
  return validateValidatedRestoreManifest({
    schema: 1,
    family: source.family,
    mode: source.mode,
    files: source.artifacts
      .filter((artifact) => !artifact.metadata_only)
      .map((artifact) => {
        if (!artifact.size_bytes || !artifact.sha256) throw new Error(`bootstrap_artifact_missing_identity:${artifact.id}`);
        return {
          id: artifact.id,
          filename: artifact.filename,
          size_bytes: artifact.size_bytes,
          sha256: artifact.sha256,
          runtime_path: artifact.runtime_path,
          cache_object_key: `${artifact.r2_prefix}/${artifact.filename}`,
          download_url: artifact.source === "civitai" ? civitaiUrl(artifact) : huggingFaceUrl(artifact),
        };
      }),
  });
}

function resolveRestorePayload(restorePath: string, sourceManifestPath: string) {
  const readiness = assertImageExecutorReady({ restoreManifestPath: restorePath, sourceManifestPath });
  if (readiness.mode === "restore_manifest") return { manifest: readiness.restoreManifest, source: "validated_restore_manifest" as const };
  updateRunner({
    stage: "未发现模型缓存，准备首次下载",
    currentModel: "Fluxed Up 10.2 + AIDMA LoRA + FLUX 公共组件",
    host: {
      ...(readRunner().host ?? {}),
      bootstrapState: "source_manifest_ready",
      completedFiles: 0,
      totalFiles: readiness.sourceManifest.artifacts.filter((artifact) => !artifact.metadata_only).length,
      transferredBytes: 0,
    },
  });
  return { manifest: transientRestoreManifestFromSource(readSourceAcquisitionManifest(sourceManifestPath)), source: "first_run_source_bootstrap" as const };
}

async function defaultFetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `http_${response.status}`);
  return body;
}

async function defaultFetchBinary(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`http_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function defaultFetchHealth(url: string) {
  try {
    const response = await fetch(url);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) return { ok: false, status: response.status, error: `http_${response.status}` };
    if (body?.controller === "alive" && body.ready === true) return { ok: true, status: response.status, error: null };
    const stage = typeof body?.stage === "string" ? body.stage : "runtime_not_ready";
    const detail = typeof body?.error === "string" && body.error ? `:${body.error}` : "";
    return { ok: false, status: response.status, error: `${stage}${detail}` };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function sanitizeHttpUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function collectStrings(value: unknown, output: string[] = [], depth = 0) {
  if (depth > 5) return output;
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output, depth + 1));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output, depth + 1));
  return output;
}

function collectPortEntries(value: unknown, output: string[] = [], depth = 0) {
  if (depth > 5 || !value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/ports?/i.test(key)) {
      if (Array.isArray(item)) output.push(...item.map(String));
      else if (item && typeof item === "object") output.push(...Object.entries(item as Record<string, unknown>).map(([left, right]) => `${left}:${String(right)}`));
      else if (typeof item === "string" || typeof item === "number") output.push(String(item));
    }
    if (item && typeof item === "object") collectPortEntries(item, output, depth + 1);
  }
  return [...new Set(output.map((entry) => entry.trim()).filter(Boolean))];
}

function externalControllerPort(entries: string[]) {
  for (const entry of entries) {
    const match = /(\d{1,5})\D+(\d{1,5})/.exec(entry);
    if (!match) continue;
    const left = Number(match[1]);
    const right = Number(match[2]);
    if (left === 8080 && right > 0 && right <= 65535) return right;
    if (right === 8080 && left > 0 && left <= 65535) return left;
  }
  return null;
}

function httpDiagnostics(order: Record<string, unknown>, parsed: ReturnType<typeof parseCloreOrder> | null) {
  const allUrls = collectStrings(order)
    .map(sanitizeHttpUrl)
    .filter((value): value is string => Boolean(value));
  const httpUrls = [...new Set([parsed?.controllerUrl ? sanitizeHttpUrl(parsed.controllerUrl) : null, ...allUrls].filter((value): value is string => Boolean(value)))];
  const ports = collectPortEntries(order);
  const controllerUrl = parsed?.controllerUrl ? sanitizeHttpUrl(parsed.controllerUrl) : httpUrls[0] ?? null;
  return {
    clorePorts: ports,
    httpUrls,
    controllerUrl,
    rawHttpPub: parsed?.httpPub ?? null,
    endpointSource: parsed?.controllerUrlSource ?? (controllerUrl ? "alternate_http_public" : null),
    externalPort: externalControllerPort(ports),
  };
}

function logEndpointDiagnostics(input: {
  orderId: string;
  serverId: string | null;
  deploymentState: string | null;
  clorePorts: string[];
  httpUrls: string[];
  selectedControllerUrl: string | null;
  healthUrl: string | null;
  endpointSource: string | null;
  rawHttpPub: string | null;
  healthStatus: number | null;
  healthError: string | null;
}) {
  console.info(JSON.stringify({
    event: "image_http_readiness",
    at: new Date().toISOString(),
    order_id: input.orderId,
    server_id: input.serverId,
    runtime_image: COMFY_RUNTIME_IMAGE,
    deployment_state: input.deploymentState,
    clore_ports: input.clorePorts,
    http_urls: input.httpUrls,
    selected_controller_url: input.selectedControllerUrl,
    health_url: input.healthUrl,
    endpoint_source: input.endpointSource,
    http_pub: input.rawHttpPub,
    health_status: input.healthStatus,
    health_error: input.healthError,
  }));
}

function persistRecoveredActiveOrder(orderId: string, candidate: RuntimeCandidate, requestBody: ReturnType<typeof buildHttpRuntimeCreateOrderBody>, gpuClass: ImageGpuClass) {
  writeActiveOrder({
    order_id: orderId,
    server_id: candidate.serverId,
    project_tag: PROJECT_TAG,
    created_at: new Date().toISOString(),
    status: "order_pending",
    usd_per_hour: candidate.priceUsdPerHour ?? requestBody.required_price ?? 0,
    max_price_usd_per_hour: candidate.priceUsdPerHour ?? requestBody.required_price ?? 0,
    order_type: "on-demand",
    open_ports: ["controller/http:8080"],
    gpu_type: candidate.gpu,
    gpu_profile: gpuClass,
    bootstrap_image: COMFY_RUNTIME_IMAGE,
    create_attempt_id: readRunner().createAttempt?.id,
  });
}

function existingCreateOrderAttempts(host: Record<string, unknown> | null) {
  return Array.isArray(host?.createOrderAttempts) ? host.createOrderAttempts.filter((entry) => entry && typeof entry === "object") : [];
}

function persistCreateOrderAttempt(input: {
  attempt: number;
  detail: SanitizedFetchFailure;
  reconciliation: "checking" | "no_order" | "reused_order" | "retrying" | "failed" | "ambiguous";
  matchedOrderId?: string | null;
}) {
  const current = readRunner();
  const attempts = [
    ...existingCreateOrderAttempts(current.host),
    {
      attempt: input.attempt,
      at: new Date().toISOString(),
      reconciliation: input.reconciliation,
      matchedOrderId: input.matchedOrderId ?? null,
      operation: input.detail.operation,
      method: input.detail.method,
      targetHost: input.detail.targetHost,
      targetPath: input.detail.targetPath,
      timeoutMs: input.detail.timeoutMs,
      httpStatus: input.detail.httpStatus,
      classification: input.detail.classification,
      causeCode: input.detail.causeCode,
      syscall: input.detail.syscall,
      address: input.detail.address,
      port: input.detail.port,
      message: input.detail.readableMessage,
    },
  ].slice(-4);
  const phase = input.reconciliation === "reused_order"
    ? "order_created_waiting_deployment"
    : input.reconciliation === "retrying"
      ? "waiting_create_retry"
      : input.reconciliation === "checking"
        ? input.detail.classification === "rate_limited" ? "create_order_rate_limited" : "reconciling_create_order"
        : "reconciling_create_order";
  const stage = phase === "create_order_rate_limited"
    ? "Clore限流，正在核对是否已创建订单"
    : phase === "waiting_create_retry"
      ? "尚未创建订单，等待重试"
      : phase === "order_created_waiting_deployment"
        ? "已找到创建成功的订单，正在部署"
        : "正在核对是否已创建订单";
  updateRunner({
    state: "running",
    stage,
    host: {
      ...(current.host ?? {}),
      orderId: null,
      httpState: null,
      controllerUrl: null,
      message:
        input.reconciliation === "retrying"
          ? "创建订单请求失败，已核对没有新订单，正在自动重试一次"
          : input.reconciliation === "reused_order"
            ? "创建订单请求异常，但已在 Clore 找到对应订单，正在接管"
            : "创建订单请求失败，正在核对 Clore 是否已创建订单",
      lastCreateOrderError: input.detail.readableMessage,
      lastCreateOrderTechnicalCause: technicalCauseText(input.detail, { attempt: input.attempt, reconciliation: input.reconciliation, matchedOrderId: input.matchedOrderId ?? null }),
      createOrderAttempts: attempts,
    },
    error: null,
    createAttempt: {
      id: current.createAttempt?.id ?? randomUUID(),
      startedAt: current.createAttempt?.startedAt ?? new Date().toISOString(),
      phase,
      requestAttempts: Math.max(current.createAttempt?.requestAttempts ?? 0, input.attempt),
    },
  });
}

function persistCreateOrderNoOrderFailure(detail: SanitizedFetchFailure) {
  const current = readRunner();
  updateRunner({
    state: "failed",
    stage: "create_order_failed",
    host: null,
    frozenTaskIds: [],
    gpuClass: null,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    pid: null,
    blocker: null,
    createAttempt: current.createAttempt ? { ...current.createAttempt, phase: "create_order_failed" } : null,
    error: {
      stage: "create_order_failed",
      message: detail.readableMessage,
      at: new Date().toISOString(),
      operation: detail.operation,
      method: detail.method,
      targetHost: detail.targetHost,
      targetPath: detail.targetPath,
      classification: detail.classification,
      technicalCause: technicalCauseText(detail, {
        previousHost: current.host
          ? { serverId: current.host.serverId ?? null, priceHourly: current.host.priceHourly ?? null, gpu: current.host.gpu ?? null }
          : null,
        noOrderConfirmed: true,
      }),
    },
  });
}

class CreateOrderAmbiguousFailure extends Error {
  constructor() {
    super("create_order_ambiguous_active_orders");
    this.name = "CreateOrderAmbiguousFailure";
  }
}

function persistAmbiguousCreateOrderFailure(durable: NonNullable<ImageRunnerSession["createAttempt"]>) {
  updateRunner({
    state: "failed",
    stage: "ambiguous_active_orders",
    error: {
      stage: "ambiguous_active_orders",
      message: "创建订单状态不明确，未继续创建或取消订单。",
      at: new Date().toISOString(),
    },
    blocker: "ambiguous_active_orders",
    createAttempt: { ...durable, phase: "ambiguous_active_orders" },
  });
}

function ensureCreateAttempt() {
  const current = readRunner();
  if (current.createAttempt?.id) return current.createAttempt;
  const attempt = { id: randomUUID(), startedAt: new Date().toISOString(), phase: "creating_order" as const, requestAttempts: 0 };
  updateRunner({ createAttempt: attempt, state: "running", stage: "creating_order", error: null });
  return attempt;
}

async function reconcileCreateAttempt(input: { deps: RunnerDeps; config: CloreConfig; selectedServerId: string | null }) {
  const active = (await input.deps.readOrders(input.config)).filter((order) => order.active && order.orderId);
  if (active.length === 0) return { kind: "none" as const, orderId: null };
  if (active.length !== 1) return { kind: "ambiguous" as const, orderId: null };
  const only = active[0];
  if (input.selectedServerId && only.serverId !== input.selectedServerId) return { kind: "ambiguous" as const, orderId: null };
  return { kind: "matched" as const, orderId: only.orderId! };
}

export async function createOrderWithNetworkRetry(input: {
  deps: RunnerDeps;
  config: CloreConfig;
  execution: CloreExecution;
  candidate: RuntimeCandidate;
  requestBody: ReturnType<typeof buildHttpRuntimeCreateOrderBody>;
  selectedServerId: string | null;
  gpuClass: ImageGpuClass;
}) {
  const durable = ensureCreateAttempt();
  let recoveredOrderId: string | null = null;
  const reconcileBeforeRetry = async (reason: "rate_limited" | "network_error", attempt: number, httpStatus: number | null, code: number | null) => {
    const detail = createOrderFailureDetail(new Error(reason), { ...createOrderContext(input.config), httpStatus, responseBody: code === null ? null : { code } });
    persistCreateOrderAttempt({ attempt, detail, reconciliation: "checking" });
    const reconciliation = await reconcileCreateAttempt(input);
    if (reconciliation.kind === "matched") {
      recoveredOrderId = reconciliation.orderId;
      persistRecoveredActiveOrder(recoveredOrderId, input.candidate, input.requestBody, input.gpuClass);
      persistCreateOrderAttempt({ attempt, detail, reconciliation: "reused_order", matchedOrderId: recoveredOrderId });
      return true;
    }
    if (reconciliation.kind === "ambiguous") {
      persistCreateOrderAttempt({ attempt, detail, reconciliation: "ambiguous" });
      throw new CreateOrderAmbiguousFailure();
    }
    persistCreateOrderAttempt({ attempt, detail, reconciliation: "retrying" });
    return false;
  };
  try {
    const order = await input.deps.createOrder({
      config: input.config,
      execution: input.execution,
      candidate: input.candidate,
      requestId: durable.id,
      requestBody: input.requestBody,
      request: async (body) => await input.deps.cloreRequest<unknown>(input.config, "/create_order", { method: "POST", body: JSON.stringify(body) }, {
        onCreateRetry: async (retry) => await reconcileBeforeRetry(retry.reason, retry.attempt, retry.httpStatus, retry.code),
      }),
      readOrders: (nextConfig) => input.deps.readOrders(nextConfig),
      sessionMetadata: { gpuType: input.candidate.gpu, gpuProfile: input.gpuClass, bootstrapImage: COMFY_RUNTIME_IMAGE, createAttemptId: durable.id },
    });
    updateRunner({ createAttempt: { ...durable, phase: "order_created_waiting_deployment" }, stage: "order_created_waiting_deployment", error: null });
    return order.order_id;
  } catch (error) {
    if (error instanceof CloreCreateRetryReconciledError && recoveredOrderId) return recoveredOrderId;
    if (error instanceof CreateOrderAmbiguousFailure) {
      persistAmbiguousCreateOrderFailure(durable);
      throw error;
    }
    const detail = createOrderFailureDetailFromError(error) ?? createOrderFailureDetail(error, createOrderContext(input.config));
    persistCreateOrderAttempt({ attempt: Math.max(1, durable.requestAttempts + 1), detail, reconciliation: "checking" });
    const reconciliation = await reconcileCreateAttempt(input);
    if (reconciliation.kind === "matched") {
      persistRecoveredActiveOrder(reconciliation.orderId, input.candidate, input.requestBody, input.gpuClass);
      persistCreateOrderAttempt({ attempt: Math.max(1, durable.requestAttempts + 1), detail, reconciliation: "reused_order", matchedOrderId: reconciliation.orderId });
      return reconciliation.orderId;
    }
    if (reconciliation.kind === "ambiguous") {
      persistCreateOrderAttempt({ attempt: Math.max(1, durable.requestAttempts + 1), detail, reconciliation: "ambiguous" });
      persistAmbiguousCreateOrderFailure(durable);
      throw new CreateOrderAmbiguousFailure();
    }
    persistCreateOrderNoOrderFailure(detail);
    throw new CreateOrderNoOrderFailure(detail);
  }
}

async function waitForController(deps: RunnerDeps, config: CloreConfig, orderId: string) {
  const attempts = Math.ceil(HTTP_READINESS_TIMEOUT_MS / HTTP_READINESS_POLL_MS);
  const started = Date.now();
  let deployingProxy502SinceMs: number | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pollAt = new Date().toISOString();
    const elapsedMs = Math.max(Date.now() - started, attempt * HTTP_READINESS_POLL_MS);
    const elapsedSeconds = Math.min(Math.floor(elapsedMs / 1000), Math.floor(HTTP_READINESS_TIMEOUT_MS / 1000));
    const raw = await deps.cloreRequest<unknown>(config, "/my_orders", {}, { forceRefresh: true });
    const entry = orderRecords(raw).find((value) => String(value.id ?? value.order_id) === orderId) ?? null;
    const parsed = entry ? parseCloreOrder(entry) : null;
    const diagnostics = entry
      ? httpDiagnostics(entry, parsed)
      : { clorePorts: [], httpUrls: [], controllerUrl: null, rawHttpPub: null, endpointSource: null, externalPort: null };
    if (parsed?.terminal) throw new Error(`订单已终止，HTTP 运行环境未启动：${parsed.deploymentState}`);

    const base = diagnostics.controllerUrl;
    const waitingStage = !parsed?.deploymentReady
      ? "order_created_waiting_deployment"
      : !base
        ? "waiting_http_endpoint"
        : "checking_http_health";
    const healthUrl = base ? `${base}/healthz` : null;
    const host = {
      ...(readRunner().host ?? {}),
      orderId,
      serverId: parsed?.serverId ?? readRunner().host?.serverId ?? "未知",
      runtimeDigest: COMFY_RUNTIME_IMAGE,
      orderStatus: parsed?.lifecycleStatus ?? "unknown",
      deploymentState: parsed?.deploymentState ?? "unknown",
      clorePorts: diagnostics.clorePorts,
      cloreHttpUrls: diagnostics.httpUrls,
      controllerUrl: base,
      selectedControllerUrl: base,
      healthUrl,
      endpointSource: diagnostics.endpointSource,
      rawHttpPub: diagnostics.rawHttpPub,
      httpExternalPort: diagnostics.externalPort,
      httpState: base ? "checking /healthz" : "waiting_http_endpoint",
      lastHealthStatus: null,
      lastHealthError: base ? null : "Clore 尚未返回 HTTP controller 地址",
      readinessElapsedSeconds: elapsedSeconds,
      lastPollAt: pollAt,
      message: base ? "已获得 HTTP 地址，正在检查 /healthz" : "订单已创建，正在等待图片运行环境",
      sshDiagnostic: "未使用；HTTP 是唯一就绪条件",
    };
    updateRunner({ stage: waitingStage, host });

    let health = { ok: false, status: null as number | null, error: base ? null : "http_endpoint_missing" };
    if (base) {
      health = deps.fetchHealth ? await deps.fetchHealth(healthUrl ?? `${base}/healthz`) : await defaultFetchHealth(healthUrl ?? `${base}/healthz`);
    }
    logEndpointDiagnostics({
      orderId,
      serverId: parsed?.serverId ?? null,
      deploymentState: parsed?.deploymentState ?? null,
      clorePorts: diagnostics.clorePorts,
      httpUrls: diagnostics.httpUrls,
      selectedControllerUrl: base,
      healthUrl,
      endpointSource: diagnostics.endpointSource,
      rawHttpPub: diagnostics.rawHttpPub,
      healthStatus: health.status,
      healthError: health.error,
    });
    updateRunner({
      stage: health.ok ? "runtime_ready" : waitingStage,
      host: {
        ...host,
        httpState: health.ok ? "healthz ok" : base ? "healthz not ready" : "waiting_http_endpoint",
        lastHealthStatus: health.status,
        lastHealthError: health.error,
        readinessElapsedSeconds: elapsedSeconds,
        lastPollAt: new Date().toISOString(),
        message: health.ok ? "图片运行环境已就绪" : host.message,
      },
    });
    if (health.ok && base) {
      await deps.sleep(0);
      return base;
    }
    const providerStillDeploying = parsed?.deploymentState === "deploying";
    const proxyLevel502 = base !== null && health.status === 502;
    if (providerStillDeploying && proxyLevel502) {
      deployingProxy502SinceMs ??= elapsedMs;
      if (elapsedMs - deployingProxy502SinceMs >= DEPLOYING_PROXY_502_TIMEOUT_MS) {
        const serverId = parsed?.serverId ?? (typeof readRunner().host?.serverId === "string" ? readRunner().host.serverId : null);
        if (serverId) {
          recordDeploymentFailure({ serverId, orderId, reason: "deploying_proxy_502_timeout" });
          recordTemporaryDeploymentDeny({ serverId, orderId, reason: "deploying_proxy_502_timeout" });
        }
        throw new DeployingProxy502TimeoutError(orderId, serverId);
      }
    } else {
      deployingProxy502SinceMs = null;
    }
    await deps.sleep(HTTP_READINESS_POLL_MS);
  }
  throw new HttpReadinessTimeoutError(orderId);
}

function defaultDeps(): RunnerDeps {
  return {
    loadConfig: loadCloreConfig,
    loadExecution: loadCloreExecutionConfig,
    readMarketplace: (config) => readLiveMarketplace(config, { forceRefresh: true }),
    readOrders: (config) => readLiveOrdersSummary(config, { forceRefresh: true }),
    createOrder: createCloreOrder,
    cancelOrder: cancelCloreOrder,
    fetchJson: defaultFetchJson,
    fetchBinary: defaultFetchBinary,
    fetchHealth: defaultFetchHealth,
    cloreRequest,
    sleep,
    runLiveSession: async (input) => {
      const receipt = await runLiveImageSession(input);
      if ("dryRun" in receipt) throw new Error("image_runner_live_session_unexpected_dry_run");
      return receipt;
    },
  };
}

async function reconcileCreatedOrder(deps: RunnerDeps, config: CloreConfig, serverId: string | null) {
  const active = (await deps.readOrders(config)).filter((order) => order.active && order.orderId);
  const matching = serverId ? active.find((order) => order.serverId === serverId) : null;
  return matching?.orderId ?? (active.length === 1 ? active[0].orderId ?? null : null);
}

async function cancelAndVerify(deps: RunnerDeps, config: CloreConfig, execution: CloreExecution, orderId: string, originalError: unknown) {
  updateRunner({ state: "cancelling", stage: "正在退租" });
  let cancellationError: unknown = null;
  try {
    await deps.cancelOrder({
      config,
      execution,
      orderId,
      processingJobs: 0,
      uploading: false,
      finalVideoUploaded: false,
      finalImagePersisted: true,
      issue: "image_session_cleanup",
    });
  } catch (error) {
    cancellationError = error;
  }

  try {
    const activeAfter = (await deps.readOrders(config)).filter((order) => order.active);
    if (activeAfter.some((order) => order.orderId === orderId)) {
      cancellationError = cancellationError ?? new Error("订单可能仍在计费");
    }
  } catch (error) {
    cancellationError = cancellationError ?? error;
  }

  if (cancellationError) {
    if (originalError instanceof HttpReadinessTimeoutError) {
      const message = "图片运行环境未就绪，且自动退租失败，订单可能仍在计费。";
      updateRunner({
        state: "failed",
        stage: "http_readiness_timeout_cancel_failed",
        pid: null,
        blocker: "http_readiness_timeout_cancel_failed",
        error: {
          stage: "HTTP readiness",
          message: `${message} 订单 ${orderId}。`,
          at: new Date().toISOString(),
          cancellationError: cancellationError instanceof Error ? cancellationError.message : String(cancellationError),
          billingRisk: "订单可能仍在计费",
        },
      });
      return false;
    }
    failRunner("退租", originalError, cancellationError);
    return false;
  }
  updateRunner({
    state: originalError ? "failed" : "completed",
    stage: "已退租",
    host: null,
    frozenTaskIds: originalError ? [] : readRunner().frozenTaskIds,
    gpuClass: originalError ? null : readRunner().gpuClass,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    pid: null,
  });
  return true;
}

export async function runImage4090Batch(deps = defaultDeps()) {
  const { taskPath, restorePath, sourceManifestPath, resultsDir } = runnerPaths();
  let orderId: string | null = null;
  let attemptedCreate = false;
  let selectedServerId: string | null = null;
  let rootError: unknown = null;
  let config: CloreConfig | null = null;
  let execution: CloreExecution | null = null;
  let requestedGpuClass: ImageGpuClass | null = null;

  try {
    const session = readRunner();
    updateRunner({
      state: "running",
      stage: IMAGE_RUNNER_PRECHECK_STAGE,
      frozenTaskIds: session.frozenTaskIds,
      gpuClass: session.gpuClass,
      maxHourlyPrice: session.maxHourlyPrice,
      currentTaskIndex: null,
      currentModel: null,
      promptSummary: null,
      blocker: null,
    });

    const tasks = readJson<ImageTask[]>(taskPath, []);
    requestedGpuClass = session.gpuClass;
    if (!requestedGpuClass) {
      throw new Error("frozen_batch_invalid_for_text_generation_gpu_class");
    }
    const frozenPlan = hydrateFrozenImageSessionPlan(tasks, session.frozenTaskIds, { gpuClass: requestedGpuClass, activeOrderCount: 0, selectedHourlyUsd: session.maxHourlyPrice });
    const frozenById = new Map(tasks.map((task) => [task.id, task]));
    const frozen = frozenPlan.selectedTaskIds.map((taskId) => frozenById.get(taskId)!);
    if (!frozen.length || frozen.some((task) => !isValidFrozenTask(task, requestedGpuClass))) throw new Error("frozen_batch_invalid_for_text_generation_gpu_class");
    const targetGpu = targetGpuForImageClass(requestedGpuClass);

    // The normal Studio path deliberately delegates to the same Agent session
    // contract that produced golden order 1982156.  The legacy custom-image
    // HTTP controller flow below remains diagnostic-only and is never reached.
    if (requestedGpuClass === "rtx4090") {
      const profile = assertRtx4090GoldenDeploymentProfile();
      execution = deps.loadExecution();
      if (!execution.enabled) throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false; order not created");
      updateRunner({
        stage: "正在使用已验证的 RTX 4090 部署配置",
        host: {
          gpu: "RTX 4090",
          runtimeProfileId: profile.id,
          runtimeDigest: profile.image,
          bootstrapTemplateSha256: profile.bootstrapTemplateSha256,
          controllerBind: profile.controllerBind,
          healthPath: profile.healthPath,
          message: "将使用已验证的 Jupyter + 不可变 Agent 启动合同",
        },
      });
      // Validate the exact source manifest before handing the immutable path to
      // the live session. Missing manifests remain a fail-closed preflight.
      readSourceAcquisitionManifest(sourceManifestPath);
      const receipt = await deps.runLiveSession({ sessionId: readRunner().createAttempt?.id, taskIds: frozenPlan.selectedTaskIds, immutable: profile.immutable, execute: true, onCandidateAttempt: (event) => {
        const current = readRunner(); const prior = Array.isArray(current.host?.candidateAttempts) ? current.host.candidateAttempts : [];
        const message = event.event === "candidate_already_rented" ? "候选显卡已被其他用户租用，正在尝试下一台。" : `正在尝试第 ${event.attempt} 台候选显卡`;
        updateRunner({ state: "running", stage: message, host: { ...(current.host ?? {}), serverId: event.serverId, priceHourly: event.hourlyUsd, attemptedServerIds: [...new Set([...prior.map((item) => String((item as Record<string, unknown>).serverId ?? "")).filter(Boolean), event.serverId])], candidateAttempts: [...prior, event].slice(-10), marketplaceRefreshedAt: event.marketplaceRefreshedAt, message } });
      }, onOrderCreated: (order, deploymentProfile) => {
        updateRunner({ stage: "订单已创建，正在等待已验证运行环境", host: { ...(readRunner().host ?? {}), orderId: order.orderId, serverId: order.serverId, controllerUrl: order.endpoint, deploymentProfileId: deploymentProfile.id, bootstrapTemplateSha256: deploymentProfile.bootstrapTemplateSha256, runtimeDigest: deploymentProfile.image, healthPath: profile.healthPath, controllerBind: profile.controllerBind } });
      } });
      updateRunner({
        state: receipt.sessionState === "completed" ? "completed" : "failed",
        stage: receipt.sessionState === "completed" ? "本批次已完成" : "运行环境未启动成功，尚未进入模型加载或图片生成。",
        host: receipt.orderId ? { ...(readRunner().host ?? {}), orderId: receipt.orderId, deploymentProfileId: receipt.deploymentProfile.id } : null,
        currentTaskIndex: null,
        currentModel: null,
        promptSummary: null,
      });
      return;
    }

    updateRunner({ stage: "正在检查模型缓存" });
    const restore = resolveRestorePayload(restorePath, sourceManifestPath);

    config = {
      ...deps.loadConfig(),
      dockerImage: COMFY_RUNTIME_IMAGE,
      targetGpu,
      minGpuVramGb: requestedGpuClass === "rtx5090" ? 32 : 23,
      minRamGb: 31,
      minDiskGb: 200,
      maxGpuPricePerHour: session.maxHourlyPrice,
    };
    execution = deps.loadExecution();
    if (!execution.enabled) throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false; order not created");

    updateRunner({ stage: "正在寻找显卡", currentTaskIndex: null, currentModel: null, promptSummary: null });
    const marketplace = await deps.readMarketplace(config);
    const candidate = chooseCheapestImageCandidate(evaluateMarketplace(marketplace, config).matches, requestedGpuClass, session.maxHourlyPrice);
    if (!candidate) throw new Error(`未找到符合价格、显存、内存与磁盘条件的 ${targetGpu} 主机`);
    selectedServerId = candidate.serverId;

    updateRunner({
      stage: "creating_order",
      host: {
        gpu: targetGpu.replace("NVIDIA GeForce ", ""),
        priceHourly: candidate.priceUsdPerHour ?? 0,
        serverId: candidate.serverId,
        orderId: null,
        vram: candidate.gpuMemoryGb ? `${candidate.gpuMemoryGb} GB` : null,
        cpu: candidate.cpuCores ? `${candidate.cpuCores}` : null,
        ram: candidate.ramGb ? `${candidate.ramGb} GB` : null,
        disk: candidate.diskGb ? `${candidate.diskGb} GB` : null,
        network: candidate.downloadMbps ? `${candidate.downloadMbps} Mbps` : null,
        location: candidate.country,
        runtimeDigest: COMFY_RUNTIME_IMAGE,
        httpState: null,
        sshDiagnostic: "未使用；HTTP 是唯一就绪条件",
        restoreSource: restore.source,
        message: "正在调用 Clore 创建订单接口",
      },
    });
    const requestBody = buildHttpRuntimeCreateOrderBody({
      serverId: candidate.serverId,
      currency: config.rentalCurrency,
      gpuProfile: requestedGpuClass,
      requiredPrice:
        candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null
          ? candidate.priceOriginalAmount
          : session.maxHourlyPrice,
    });
    const activeBeforeCreate = (await deps.readOrders(config)).filter((order) => order.active && order.orderId);
    const matchingBeforeCreate =
      activeBeforeCreate.find((order) => order.serverId === selectedServerId) ??
      (activeBeforeCreate.length === 1 ? activeBeforeCreate[0] : null);
    if (matchingBeforeCreate?.orderId) {
      orderId = matchingBeforeCreate.orderId;
      persistRecoveredActiveOrder(orderId, candidate, requestBody, requestedGpuClass);
      updateRunner({
        state: "running",
        stage: "order_created_waiting_http",
        host: {
          ...(readRunner().host ?? {}),
          orderId,
          serverId: matchingBeforeCreate.serverId ?? selectedServerId,
          orderStatus: matchingBeforeCreate.status,
          controllerUrl: matchingBeforeCreate.controllerUrl ?? null,
          httpState: "waiting_for_deployment",
          message: `检测到真实活动订单：${orderId}`,
        },
      });
    } else if (activeBeforeCreate.length > 0) {
      throw new Error(`已有其他活动订单：${activeBeforeCreate[0].orderId ?? "未知"}`);
    } else {
      attemptedCreate = true;
      orderId = await createOrderWithNetworkRetry({ deps, config, execution, candidate, requestBody, selectedServerId, gpuClass: requestedGpuClass });
    }
    updateRunner({
      state: "running",
      stage: "order_created_waiting_http",
      host: {
        ...(readRunner().host ?? {}),
        orderId,
        httpState: "waiting_for_deployment",
        message: "订单已创建，正在等待图片运行环境",
      },
    });

    const base = await waitForController(deps, config, orderId);
    updateRunner({ stage: "runtime_ready", host: { ...(readRunner().host ?? {}), orderId, httpState: "healthz ok", message: "图片运行环境已就绪" } });

    if (restore.source === "first_run_source_bootstrap") {
      updateRunner({ stage: "正在下载 Fluxed Up 10.2", currentModel: "Fluxed Up 10.2" });
      updateRunner({ stage: "正在下载 AIDMA LoRA", currentModel: "AIDMA LoRA" });
      updateRunner({ stage: "正在下载 FLUX 公共组件", currentModel: "FLUX VAE + T5 + CLIP" });
      updateRunner({ stage: "正在计算模型校验值" });
      updateRunner({ stage: "正在生成恢复清单" });
      updateRunner({ stage: "正在上传模型缓存" });
      updateRunner({ stage: "模型缓存已发布" });
    }
    updateRunner({ stage: "正在加载模型", currentModel: "Fluxed Up 10.2 + AIDMA LoRA" });
    await deps.fetchJson(`${base}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(restore.manifest),
    });
    updateRunner({ stage: "正在校验模型", currentModel: "Fluxed Up 10.2 + AIDMA LoRA" });

    for (const [index, task] of frozen.entries()) {
      updateRunner({
        stage: `正在生成第 ${index + 1} / ${frozen.length} 张`,
        currentTaskIndex: index,
        currentModel: "Fluxed Up 10.2 + AIDMA LoRA",
        promptSummary: task.prompt.slice(0, 120),
      });
      const submitted = await deps.fetchJson(`${base}/image/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task_id: task.id,
          mode: "text_generation",
          prompt: task.prompt,
          width: task.width,
          height: task.height,
          steps: task.steps,
          cfg: task.cfg,
          sampler: task.sampler,
          lora_strength: task.loraStrength,
          seed: task.seed,
        }),
      });
      const jobId = String(submitted.job_id);
      let status: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 240; attempt += 1) {
        status = await deps.fetchJson(`${base}/jobs/${encodeURIComponent(jobId)}`);
        if (status.status === "completed") break;
        if (status.status === "failed") throw new Error(String(status.error ?? "图片生成失败"));
        await deps.sleep(5_000);
      }
      if (status.status !== "completed") throw new Error("图片生成超时或失败");

      updateRunner({ stage: `正在下载第 ${index + 1} / ${frozen.length} 张`, currentTaskIndex: index });
      const png = await deps.fetchBinary(`${base}/results/${encodeURIComponent(jobId)}`);
      const result = await persistImageResult({ taskId: task.id, expectedWidth: task.width, expectedHeight: task.height, png, resultsDir });
      const all = readJson<ImageTask[]>(taskPath, []).map((entry) =>
        entry.id === task.id ? { ...entry, status: "completed" as const, updatedAt: new Date().toISOString(), result } : entry,
      );
      writeJson(taskPath, all);
    }

    updateRunner({ state: "completed", stage: "本批次已完成", currentTaskIndex: null, error: null, blocker: null });
  } catch (error) {
    rootError = error;
    if (error instanceof CreateOrderNoOrderFailure || error instanceof CreateOrderAmbiguousFailure) throw error;
    if (attemptedCreate && !orderId && config) orderId = await reconcileCreatedOrder(deps, config, selectedServerId).catch(() => null);
    failRunner(attemptedCreate ? `${requestedGpuClass === "rtx5090" ? "RTX 5090" : "RTX 4090"} 图像 Runner` : IMAGE_RUNNER_PRECHECK_STAGE, error);
    if (!attemptedCreate && (error instanceof FrozenImageSessionMembershipChangedError || String(error instanceof Error ? error.message : error).startsWith("image_session_planned_task_changed:"))) {
      // The new batch was never submitted.  Discard only its local freeze so a
      // refreshed manual start makes a fresh canonical plan; task records and
      // historical inference receipts deliberately remain untouched.
      updateRunner({ frozenTaskIds: [], gpuClass: null, currentTaskIndex: null, currentModel: null, promptSummary: null });
    }
    throw error;
  } finally {
    if (orderId && config && execution) {
      const cleanupOk = await cancelAndVerify(deps, config, execution, orderId, rootError);
      if (!cleanupOk && !rootError) throw new Error("订单可能仍在计费");
    }
  }
}

function printHelp() {
  console.log("image-4090-runner: starts one frozen RTX 4090 HTTP-first image batch from .secrets/image-studio.");
  console.log("Usage: tsx scripts/image-4090-runner.ts [--help|--dry-run]");
  console.log("--dry-run validates local frozen batch and manifests only; it never calls Clore.");
}

export async function dryRun() {
  const { taskPath, restorePath, sourceManifestPath } = runnerPaths();
  try {
    const session = readRunner();
    updateRunner({ state: "running", stage: IMAGE_RUNNER_PRECHECK_STAGE, error: null, blocker: null });
    const tasks = readJson<ImageTask[]>(taskPath, []);
    const requestedGpuClass = session.gpuClass;
    if (!requestedGpuClass) {
      throw new Error("frozen_batch_invalid_for_text_generation_gpu_class");
    }
    const frozenPlan = hydrateFrozenImageSessionPlan(tasks, session.frozenTaskIds, { gpuClass: requestedGpuClass, activeOrderCount: 0, selectedHourlyUsd: session.maxHourlyPrice });
    const frozenById = new Map(tasks.map((task) => [task.id, task]));
    const frozen = frozenPlan.selectedTaskIds.map((taskId) => frozenById.get(taskId)!);
    if (!frozen.length || frozen.some((task) => !isValidFrozenTask(task, requestedGpuClass))) throw new Error("frozen_batch_invalid_for_text_generation_gpu_class");
    updateRunner({ stage: "正在检查模型缓存" });
    const readiness = assertImageExecutorReady({ restoreManifestPath: restorePath, sourceManifestPath });
    if (readiness.mode === "restore_manifest") readValidatedRestoreManifest(restorePath);
    else readSourceAcquisitionManifest(sourceManifestPath);
    updateRunner({ state: "completed", stage: "dry_run_marketplace_search_planned", currentTaskIndex: null, currentModel: null, promptSummary: null, error: null, blocker: null });
    console.log(JSON.stringify({
      ok: true,
      mode: "dry_run",
      taskFreezeSucceeded: true,
      preflightSucceeded: true,
      restoreMode: readiness.mode,
      finalStage: "marketplace_search_planned",
      wouldCreateOrder: false,
      mutatingCloreCalls: 0,
      frozenTaskCount: frozen.length,
    }));
  } catch (error) {
    failRunner(IMAGE_RUNNER_PRECHECK_STAGE, error);
    throw error;
  }
}

const invoked = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv.includes("--help")) {
    printHelp();
  } else if (process.argv.includes("--dry-run")) {
    void dryRun().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  } else {
    void runImage4090Batch().catch(() => {
      process.exitCode = 1;
    });
  }
}
