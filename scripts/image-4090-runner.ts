import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloreConfig, COMFY_RUNTIME_IMAGE } from "./clore/config";
import { loadCloreExecutionConfig } from "./clore/execution-config";
import { readLiveMarketplace, readLiveOrdersSummary } from "./clore/live";
import { evaluateMarketplace } from "./clore/marketplace";
import { buildHttpRuntimeCreateOrderBody, createCloreOrder } from "./clore/order-execution";
import { cancelCloreOrder } from "./clore/cancel-execution";
import { cloreRequest, sleep } from "./clore/client";
import { orderRecords, parseCloreOrder } from "./clore/order-readiness-parser";
import { persistImageResult } from "./image-executor/result-persistence";
import { resolveImageRestoreManifest } from "./image-executor/bootstrap";
import type { ValidatedRestoreManifest } from "./image-executor/manifests";

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
  error: { stage: string; message: string; at: string; cancellationError?: string; billingRisk?: string } | null;
  blocker: string | null;
};

type CloreConfig = ReturnType<typeof loadCloreConfig>;
type CloreExecution = ReturnType<typeof loadCloreExecutionConfig>;
type OrderSummary = Awaited<ReturnType<typeof readLiveOrdersSummary>>[number];
type MarketplacePayload = Awaited<ReturnType<typeof readLiveMarketplace>>;

export type RunnerDeps = {
  loadConfig: () => CloreConfig;
  loadExecution: () => CloreExecution;
  readMarketplace: (config: CloreConfig) => Promise<MarketplacePayload>;
  readOrders: (config: CloreConfig) => Promise<OrderSummary[]>;
  createOrder: typeof createCloreOrder;
  cancelOrder: typeof cancelCloreOrder;
  fetchJson: (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;
  fetchBinary: (url: string, init?: RequestInit) => Promise<Buffer>;
  cloreRequest: typeof cloreRequest;
  sleep: (ms: number) => Promise<void>;
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
  });
}

function updateRunner(patch: Partial<ImageRunnerSession>) {
  const { runnerPath } = runnerPaths();
  writeJson(runnerPath, { ...readRunner(), ...patch, updatedAt: new Date().toISOString() });
}

function failRunner(stage: string, error: unknown, cancellationError?: unknown) {
  updateRunner({
    state: "failed",
    stage: "执行失败",
    error: {
      stage,
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
      cancellationError: cancellationError ? (cancellationError instanceof Error ? cancellationError.message : String(cancellationError)) : undefined,
      billingRisk: cancellationError ? "订单可能仍在计费" : undefined,
    },
  });
}

function isValidFrozenTask(task: ImageTask) {
  return (
    task.mode === "text_generation" &&
    !task.referenceImage &&
    task.gpuClass === "rtx4090" &&
    task.width <= 1280 &&
    task.height <= 1280 &&
    task.steps >= 25 &&
    task.steps <= 40 &&
    task.cfg >= 3.5 &&
    task.cfg <= 5 &&
    task.loraStrength >= 0.6 &&
    task.loraStrength <= 1.1 &&
    task.prompt.trim().length > 0
  );
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

async function waitForController(deps: RunnerDeps, config: CloreConfig, orderId: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const raw = await deps.cloreRequest<unknown>(config, "/my_orders", {}, { forceRefresh: true });
    const entry = orderRecords(raw).find((value) => String(value.id ?? value.order_id) === orderId);
    const parsed = entry ? parseCloreOrder(entry) : null;
    if (parsed?.terminal) throw new Error(`订单已终止，HTTP 运行环境未启动：${parsed.deploymentState}`);
    if (parsed?.controllerUrl) {
      const base = parsed.controllerUrl.replace(/\/$/, "");
      updateRunner({
        stage: "等待图片运行环境",
        host: {
          ...(readRunner().host ?? {}),
          orderId,
          serverId: parsed.serverId ?? readRunner().host?.serverId ?? "未知",
          runtimeDigest: COMFY_RUNTIME_IMAGE,
          httpState: "等待 /healthz",
          sshDiagnostic: "未使用；HTTP 是唯一就绪条件",
        },
      });
      try {
        await deps.fetchJson(`${base}/healthz`);
        return base;
      } catch {
        // Clore can publish the HTTP URL before the controller finishes booting.
      }
    }
    await deps.sleep(10_000);
  }
  throw new Error("15 分钟内未获得可用 HTTP 图片运行环境");
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
    cloreRequest,
    sleep,
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
    failRunner("退租", originalError, cancellationError);
    return false;
  }
  updateRunner({ state: originalError ? "failed" : "completed", stage: "已退租", host: null });
  return true;
}

export async function runImage4090Batch(deps = defaultDeps()) {
  const { taskPath, restorePath, sourceManifestPath, resultsDir } = runnerPaths();
  const session = readRunner();
  const tasks = readJson<ImageTask[]>(taskPath, []);
  const frozen = tasks.filter((task) => session.frozenTaskIds.includes(task.id));
  if (!frozen.length || frozen.some((task) => !isValidFrozenTask(task)) || session.gpuClass !== "rtx4090") {
    throw new Error("冻结批次不是有效的 RTX 4090 文生图任务");
  }

  const restoreManifest: ValidatedRestoreManifest = await resolveImageRestoreManifest({
    restoreManifestPath: restorePath,
    sourceManifestPath,
    workspaceDir: "/workspace/comfy-model-cache",
  });

  const config = {
    ...deps.loadConfig(),
    dockerImage: COMFY_RUNTIME_IMAGE,
    targetGpu: "NVIDIA GeForce RTX 4090" as const,
    minGpuVramGb: 23,
    minRamGb: 31,
    minDiskGb: 200,
    maxGpuPricePerHour: session.maxHourlyPrice,
  };
  const execution = deps.loadExecution();
  if (!execution.enabled) throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false；尚未创建订单");

  let orderId: string | null = null;
  let attemptedCreate = false;
  let selectedServerId: string | null = null;
  let rootError: unknown = null;

  try {
    updateRunner({ stage: "正在寻找显卡", currentTaskIndex: null, currentModel: null, promptSummary: null });
    const marketplace = await deps.readMarketplace(config);
    const candidates = evaluateMarketplace(marketplace, config).matches.filter(
      (candidate) => candidate.priceUsdPerHour !== null && candidate.priceUsdPerHour <= session.maxHourlyPrice,
    );
    const candidate = candidates[0];
    if (!candidate) throw new Error("未找到符合价格、显存、内存与磁盘条件的 RTX 4090 主机");
    selectedServerId = candidate.serverId;

    if ((await deps.readOrders(config)).some((order) => order.active)) {
      throw new Error("已有活跃 Clore 订单，拒绝创建第二个订单");
    }

    updateRunner({
      stage: "正在创建订单",
      host: {
        gpu: "RTX 4090",
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
        httpState: "等待",
        sshDiagnostic: "未使用；HTTP 是唯一就绪条件",
      },
    });
    attemptedCreate = true;
    const order = await deps.createOrder({
      config,
      execution,
      candidate,
      requestBody: buildHttpRuntimeCreateOrderBody({
        serverId: candidate.serverId,
        currency: config.rentalCurrency,
        requiredPrice:
          candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null
            ? candidate.priceOriginalAmount
            : session.maxHourlyPrice,
      }),
      sessionMetadata: { gpuType: candidate.gpu, gpuProfile: "rtx4090", bootstrapImage: COMFY_RUNTIME_IMAGE },
    });
    orderId = order.order_id;

    const base = await waitForController(deps, config, orderId);
    updateRunner({ stage: "图片运行环境已启动", host: { ...(readRunner().host ?? {}), orderId, httpState: "healthz 已连接" } });

    updateRunner({ stage: "正在下载模型", currentModel: "Fluxed Up 10.2" });
    await deps.fetchJson(`${base}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(restoreManifest),
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

    updateRunner({ state: "completed", stage: "本批次已完成", currentTaskIndex: null });
  } catch (error) {
    rootError = error;
    if (attemptedCreate && !orderId) orderId = await reconcileCreatedOrder(deps, config, selectedServerId).catch(() => null);
    failRunner("RTX 4090 图片 Runner", error);
    throw error;
  } finally {
    if (orderId) {
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
  const session = readRunner();
  const tasks = readJson<ImageTask[]>(taskPath, []);
  const frozen = tasks.filter((task) => session.frozenTaskIds.includes(task.id));
  if (frozen.length && frozen.every(isValidFrozenTask) && session.gpuClass === "rtx4090") {
    await resolveImageRestoreManifest({ restoreManifestPath: restorePath, sourceManifestPath, workspaceDir: "/workspace/comfy-model-cache" });
  }
  console.log(JSON.stringify({ ok: true, mode: "dry_run", wouldCreateOrder: false, frozenTaskCount: frozen.length }));
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
