import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getCloreDeploymentHold } from "../clore/deployment-hold";
import { loadCloreConfig } from "../clore/config";
import { loadCloreExecutionConfig } from "../clore/execution-config";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "../clore/live";
import { readActiveOrder } from "../clore/order-state";
import { getPrivateKeyPath } from "../clore/ssh-client";
import { findBootstrapImageCandidates } from "../clore/bootstrap-image-profile";
import { buildCreateOrderBody, buildManualParityCreateOrderBody, createCloreOrder } from "../clore/order-execution";
import { cancelCloreOrder } from "../clore/cancel-execution";
import { assertWatchdogsReadyForCreate } from "../clore/watchdog-preflight";
import { CLORE_LIGHT_BOOTSTRAP_IMAGE, CLORE_LIGHT_BOOTSTRAP_PROFILE, loadVerifiedCloreLightBootstrapImage } from "../clore/public-image";
import { assertGpuTarget, FIXED_RUNTIME_DIGEST, sshCommand } from "./common";
import type { CreateSessionInput, GpuCandidate, GpuProvider, GpuSession, GpuTarget } from "./types";
import { clearManualParitySecrets, createManualParityState, updateManualParityState } from "../clore/manual-parity";
import { ensureValidatedProjectSshKey } from "../clore/ssh-key-validation";

const CLORE_ENV = path.join(process.cwd(), ".secrets", "clore.env");
const TARGET_PATH = path.join(process.cwd(), ".secrets", "clore-ssh-target.json");

function loadTarget(): GpuTarget {
  const input = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as Partial<GpuTarget> & { user?: string };
  const active = readActiveOrder();
  const profile = input.gpuProfile ?? active?.gpu_profile ?? "rtx4090";
  return assertGpuTarget({ provider: "clore", host: String(input.host ?? ""), port: Number(input.port), username: String(input.username ?? input.user ?? "root"), sshKeyPath: String(input.sshKeyPath ?? getPrivateKeyPath()), gpuProfile: profile, runtimeDigest: String(input.runtimeDigest ?? FIXED_RUNTIME_DIGEST) });
}

function mapCandidate(candidate: ReturnType<typeof findBootstrapImageCandidates>[number]): GpuCandidate {
  return {
    id: candidate.serverId,
    gpuType: candidate.gpu,
    priority: candidate.gpuPriority,
    vramGb: candidate.gpuMemoryGb ?? 0,
    gpuCount: 1,
    minimumRamGb: candidate.ramGb ?? 0,
    containerDiskGb: candidate.diskGb ?? 0,
    volumeGb: 0,
    hourlyUsd: candidate.effectivePriceUsdPerHour,
    availability: candidate.rentable ? "High" : "None",
    reliability: candidate.reliability,
    rating: candidate.rating,
    downloadMbps: candidate.downloadMbps,
    uploadMbps: candidate.uploadMbps,
    interruptible: false,
  };
}

export class CloreProvider implements GpuProvider {
  readonly id = "clore" as const;

  async inspectCredentials() {
    return { provider: this.id, credentials_present: existsSync(CLORE_ENV), source: existsSync(CLORE_ENV) ? "secret_file" as const : "none" as const, safe_to_query: existsSync(CLORE_ENV) };
  }

  async getBalance() {
    const wallet = await readWalletSummary(loadCloreConfig(), { forceRefresh: true });
    return { availableUsd: wallet.availableUsdBalance, supported: true };
  }

  async listCandidates(): Promise<GpuCandidate[]> {
    const config = loadCloreConfig();
    return findBootstrapImageCandidates(await readLiveMarketplace(config), config).map(mapCandidate);
  }

  async createSession(input: CreateSessionInput): Promise<GpuSession> {
    if (input.dryRun) throw new Error("Clore real session creation is not called during dry-run.");
    if (getCloreDeploymentHold().enabled) throw new Error("CLORE_DEPLOYMENT_HOLD=true: refusing Clore session creation.");
    const config = loadCloreConfig();
    const execution = loadCloreExecutionConfig();
    if (!execution.enabled) throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false.");
    const [orders, wallet, marketplace] = await Promise.all([
      readLiveOrdersSummary(config, { forceRefresh: true }),
      readWalletSummary(config, { forceRefresh: true }),
      readLiveMarketplace(config, { forceRefresh: true }),
    ]);
    if (orders.some((order) => order.active)) throw new Error("An active Clore order already exists.");
    const candidate = findBootstrapImageCandidates(marketplace, config).find((value) => value.serverId === input.candidate.id);
    if (!candidate) throw new Error("Selected Clore host is no longer compliant.");
    if ((candidate.projectedFirstImageCostUsd ?? Infinity) > 2.5) throw new Error("Projected Clore session exceeds 2.50 USD.");
    if (wallet.availableUsdBalance === null || wallet.availableUsdBalance - (candidate.projectedFirstImageCostUsd ?? 0) < 1) throw new Error("Clore wallet reserve would be violated.");
    const manifest = await loadVerifiedCloreLightBootstrapImage();
    await assertWatchdogsReadyForCreate(candidate.serverId);
    const keyValidation = ensureValidatedProjectSshKey();
    const parity = input.cloreProfile === "clore_manual_parity" ? createManualParityState(candidate.serverId) : null;
    const key = readFileSync(keyValidation.publicKeyPath, "utf8").split(/\r?\n/)[0].trim();
    const request = parity
      ? buildManualParityCreateOrderBody({ serverId: candidate.serverId, currency: config.rentalCurrency, sshPassword: parity.sshPassword })
      : buildCreateOrderBody({ serverId: candidate.serverId, image: CLORE_LIGHT_BOOTSTRAP_IMAGE, currency: config.rentalCurrency, sshPublicKey: key, maxPriceUsdPerHour: candidate.priceUsdPerHour ?? 0, requiredPriceForApi: candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null ? candidate.priceOriginalAmount : candidate.priceUsdPerHour ?? 0, bootstrapProfile: CLORE_LIGHT_BOOTSTRAP_PROFILE });
    const created = await createCloreOrder({
      config,
      execution,
      candidate,
      requestBody: request,
      sessionMetadata: { gpuType: candidate.gpu, gpuProfile: candidate.runtimeGpuProfile, bootstrapImage: `${manifest.image}@${manifest.digest}` },
      beforeCreateRequest: async () => {
        const [latestOrders, latestWallet, latestMarketplace] = await Promise.all([
          readLiveOrdersSummary(config, { forceRefresh: true }),
          readWalletSummary(config, { forceRefresh: true }),
          readLiveMarketplace(config, { forceRefresh: true }),
        ]);
        if (latestOrders.some((order) => order.active)) throw new Error("An active Clore order appeared before create_order.");
        const latest = findBootstrapImageCandidates(latestMarketplace, config).find((value) => value.serverId === candidate.serverId);
        if (!latest || latest.effectivePriceUsdPerHour === null || latest.effectivePriceUsdPerHour > 0.7) throw new Error("Selected Clore host price or compliance changed before create_order.");
        if ((latest.projectedFirstImageCostUsd ?? Infinity) > 2.5) throw new Error("Projected Clore session changed above 2.50 USD before create_order.");
        if (latestWallet.availableUsdBalance === null || latestWallet.availableUsdBalance - (latest.projectedFirstImageCostUsd ?? 0) < 1) throw new Error("Clore wallet reserve changed before create_order.");
        await input.beforeCreateRequest?.();
      },
      afterCreateRequestAttempt: input.afterCreateRequestAttempt,
    });
    if (parity) updateManualParityState({ orderId: created.order_id });
    const session = await this.getSession(created.order_id);
    if (!session) throw new Error("clore_session_state_missing_after_create");
    return session;
  }

  async recoverExistingSession() {
    const active = readActiveOrder();
    return active ? this.getSession(active.order_id) : null;
  }

  async getSession(sessionId: string): Promise<GpuSession | null> {
    const active = readActiveOrder();
    if (!active || (sessionId !== this.id && sessionId !== active.order_id)) return null;
    const price = { computeHourly: active.usd_per_hour, storageHourly: 0, totalHourly: active.usd_per_hour, projectedSessionTotal: active.usd_per_hour * 3.5 };
    return { provider: this.id, id: active.order_id, name: `clore-${active.server_id}`, status: active.status, createdAt: active.created_at, lastStatusChange: null, hourlyUsd: active.usd_per_hour, price, costPerHr: active.usd_per_hour, adjustedCostPerHr: null, containerDiskInGb: null, volumeInGb: null, cloudType: null, gpuType: active.gpu_type ?? null, target: existsSync(TARGET_PATH) ? loadTarget() : null };
  }

  async waitForSsh(session: GpuSession, timeoutMs = 10 * 60_000) {
    if (session.target && sshCommand(session.target, "true").status === 0) return session.target;
    const timeoutMinutes = Math.min(12, Math.max(1, Math.ceil(timeoutMs / 60_000)));
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const readiness = spawnSync(process.execPath, [tsxCli, "scripts/clore/order-readiness.ts", `--order-id=${session.id}`, `--timeout-minutes=${timeoutMinutes}`], { cwd: process.cwd(), encoding: "utf8", timeout: timeoutMinutes * 60_000 + 30_000 });
    if (readiness.status !== 0 || !existsSync(TARGET_PATH)) {
      const output = `${String(readiness.stdout ?? "")}\n${String(readiness.stderr ?? "")}`;
      const issues = [...output.matchAll(/"issue"\s*:\s*"([^"]+)"/g)];
      throw new Error(issues.at(-1)?.[1] ?? `clore_ssh_readiness_failed:${output.trim().slice(-500)}`);
    }
    const target = loadTarget();
    if (sshCommand(target, "true").status !== 0) throw new Error("clore_ssh_failed");
    return target;
  }

  async stopSession() { /* Runtime is stopped over SSH by the first-image orchestrator. */ }

  async terminateSession(session: GpuSession) {
    const active = readActiveOrder();
    if (!active || active.order_id !== session.id) return;
    await cancelCloreOrder({ config: loadCloreConfig(), execution: loadCloreExecutionConfig(), orderId: session.id, processingJobs: 0, uploading: false, finalVideoUploaded: true, issue: "stage3m_session_complete" });
    clearManualParitySecrets();
    rmSync(TARGET_PATH, { force: true });
  }

  async getBilling(session: GpuSession) {
    const elapsedSeconds = session.createdAt ? Math.max(0, (Date.now() - Date.parse(session.createdAt)) / 1000) : null;
    const estimatedSpendUsd = elapsedSeconds === null || session.hourlyUsd === null ? null : session.hourlyUsd * elapsedSeconds / 3600;
    return { hourlyUsd: session.hourlyUsd, computeHourly: session.price?.computeHourly ?? null, storageHourly: 0, totalHourly: session.price?.totalHourly ?? null, projectedSessionTotal: session.price?.projectedSessionTotal ?? null, elapsedSeconds, estimatedSpendUsd };
  }
}
