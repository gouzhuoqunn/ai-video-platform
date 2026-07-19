import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getCloreDeploymentHold } from "../clore/deployment-hold";
import { loadCloreConfig } from "../clore/config";
import { loadCloreExecutionConfig } from "../clore/execution-config";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "../clore/live";
import { readActiveOrder, writeActiveOrder } from "../clore/order-state";
import { cleanupOrderKnownHosts, orderKnownHostsPath } from "../clore/ssh-readiness-policy";
import { findBootstrapImageCandidates } from "../clore/bootstrap-image-profile";
import { buildCreateOrderBody, buildKeyOnlyCreateOrderBody, buildKeyWithPasswordFallbackCreateOrderBody, buildManualParityCreateOrderBody, createCloreOrder } from "../clore/order-execution";
import { cancelCloreOrder } from "../clore/cancel-execution";
import { assertWatchdogsReadyForCreate } from "../clore/watchdog-preflight";
import { CLORE_LIGHT_BOOTSTRAP_IMAGE, CLORE_LIGHT_BOOTSTRAP_PROFILE, loadVerifiedCloreLightBootstrapImage } from "../clore/public-image";
import { assertGpuTarget, FIXED_RUNTIME_DIGEST, sleep, sshCommand } from "./common";
import type { CreateSessionInput, GpuCandidate, GpuProvider, GpuSession, GpuTarget } from "./types";
import { clearManualParitySecrets, createManualParityState, updateManualParityState } from "../clore/manual-parity";
import { ensureValidatedProjectSshKey } from "../clore/ssh-key-validation";
import { assertResolvedBatchRelease } from "../clore/deployment-resolution";

const CLORE_ENV = path.join(process.cwd(), ".secrets", "clore.env");
const TARGET_PATH = path.join(process.cwd(), ".secrets", "clore-ssh-target.json");
const LAST_CREATE_EVIDENCE_PATH = path.join(process.cwd(), ".secrets", "clore-last-create-evidence.json");

function writeLastCreateEvidence(value: unknown) {
  const part = `${LAST_CREATE_EVIDENCE_PATH}.${process.pid}.part`;
  writeFileSync(part, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(part, LAST_CREATE_EVIDENCE_PATH);
}

export function readLastCloreCreateEvidence() {
  return existsSync(LAST_CREATE_EVIDENCE_PATH)
    ? JSON.parse(readFileSync(LAST_CREATE_EVIDENCE_PATH, "utf8")) as Record<string, unknown>
    : null;
}

export type CloreSshAuthEvidence = {
  passwordAuthSucceeded: boolean;
  keyInstalled: boolean;
  keyAuthSucceeded: boolean;
};

export function readCloreSshAuthEvidence(): CloreSshAuthEvidence {
  if (!existsSync(TARGET_PATH)) throw new Error("clore_ssh_auth_evidence_missing");
  const input = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as { ssh_auth?: Partial<CloreSshAuthEvidence> };
  const evidence = input.ssh_auth;
  if (!evidence || typeof evidence.passwordAuthSucceeded !== "boolean" || typeof evidence.keyInstalled !== "boolean" || evidence.keyAuthSucceeded !== true) {
    throw new Error("clore_ssh_auth_evidence_invalid");
  }
  return { passwordAuthSucceeded: evidence.passwordAuthSucceeded, keyInstalled: evidence.keyInstalled, keyAuthSucceeded: evidence.keyAuthSucceeded };
}

function loadTarget(): GpuTarget {
  const input = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as Partial<GpuTarget> & { user?: string };
  const active = readActiveOrder();
  const profile = input.gpuProfile ?? active?.gpu_profile ?? "rtx4090";
  const identity = ensureValidatedProjectSshKey();
  return assertGpuTarget({ provider: "clore", host: String(input.host ?? ""), port: Number(input.port), username: String(input.username ?? input.user ?? "root"), sshKeyPath: identity.privateKeyPath, sshCredentialSource: "canonical_clore_project_key", sshIdentityFingerprint: identity.fingerprint, gpuProfile: profile, runtimeDigest: String(input.runtimeDigest ?? FIXED_RUNTIME_DIGEST), knownHostsPath: typeof input.knownHostsPath === "string" ? input.knownHostsPath : active?.order_id ? orderKnownHostsPath(active.order_id) : undefined });
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
    allowedCurrencies: candidate.allowedCurrencies,
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

  async listCandidates(options: { forceRefresh?: boolean } = {}): Promise<GpuCandidate[]> {
    const config = loadCloreConfig();
    return findBootstrapImageCandidates(await readLiveMarketplace(config, { forceRefresh: options.forceRefresh }), config).map(mapCandidate);
  }

  async createSession(input: CreateSessionInput): Promise<GpuSession> {
    if (input.dryRun) throw new Error("Clore real session creation is not called during dry-run.");
    if (getCloreDeploymentHold().enabled) {
      if (!input.resolvedBatchRelease) throw new Error("CLORE_DEPLOYMENT_HOLD=true: refusing Clore session creation.");
      assertResolvedBatchRelease(input.resolvedBatchRelease);
    }
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
    const parity = input.cloreProfile === "clore_manual_parity" || input.cloreProfile === "clore_key_with_password_fallback" ? createManualParityState(candidate.serverId) : null;
    const key = keyValidation.normalizedPublicKey;
    const requiredPriceForApi = candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null ? candidate.priceOriginalAmount : candidate.priceUsdPerHour ?? 0;
    const request = parity
      ? input.cloreProfile === "clore_key_with_password_fallback"
        ? buildKeyWithPasswordFallbackCreateOrderBody({ serverId: candidate.serverId, currency: config.rentalCurrency, sshPassword: parity.sshPassword, sshPublicKey: key, requiredPriceForApi })
        : buildManualParityCreateOrderBody({ serverId: candidate.serverId, currency: config.rentalCurrency, sshPassword: parity.sshPassword, sshPublicKey: key })
      : input.cloreProfile === "clore_key_only"
        ? buildKeyOnlyCreateOrderBody({ serverId: candidate.serverId, currency: config.rentalCurrency, sshPublicKey: key, requiredPriceForApi })
        : buildCreateOrderBody({ serverId: candidate.serverId, image: CLORE_LIGHT_BOOTSTRAP_IMAGE, currency: config.rentalCurrency, sshPublicKey: key, maxPriceUsdPerHour: candidate.priceUsdPerHour ?? 0, requiredPriceForApi, bootstrapProfile: CLORE_LIGHT_BOOTSTRAP_PROFILE });
    let created;
    const createStartedAt = new Date();
    try {
      created = await createCloreOrder({
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
          const maximumHourlyUsd = /5090/i.test(input.candidate.gpuType ?? "") ? 0.65 : 0.7;
          if (!latest || latest.effectivePriceUsdPerHour === null || latest.effectivePriceUsdPerHour > maximumHourlyUsd) throw new Error("Selected Clore host price or compliance changed before create_order.");
          if ((latest.projectedFirstImageCostUsd ?? Infinity) > 2.5) throw new Error("Projected Clore session changed above 2.50 USD before create_order.");
          if (latestWallet.availableUsdBalance === null || latestWallet.availableUsdBalance - (latest.projectedFirstImageCostUsd ?? 0) < 1) throw new Error("Clore wallet reserve changed before create_order.");
          if (input.cloreProfile === "clore_key_only" || input.cloreProfile === "clore_key_with_password_fallback") {
            const freshRequiredPrice = latest.priceOriginalCurrency === "USD" && latest.priceOriginalUnit === "day" && latest.priceOriginalAmount !== null ? latest.priceOriginalAmount : latest.priceUsdPerHour;
            if (freshRequiredPrice === null || !Number.isFinite(freshRequiredPrice) || freshRequiredPrice <= 0) throw new Error("Fresh Clore marketplace price is unavailable.");
            request.required_price = freshRequiredPrice;
          }
          await input.beforeCreateRequest?.();
        },
        afterCreateRequestAttempt: input.afterCreateRequestAttempt,
        resolvedBatchRelease: Boolean(input.resolvedBatchRelease),
      });
    } catch (error) {
      await sleep(2500);
      const reconciledOrders = await readLiveOrdersSummary(config, { forceRefresh: true });
      const matching = reconciledOrders.find((order) => {
        if (!order.active || !order.orderId || order.serverId !== candidate.serverId) return false;
        if (order.createdTimestamp === null) return true;
        const timestampMs = order.createdTimestamp > 10_000_000_000 ? order.createdTimestamp : order.createdTimestamp * 1000;
        return timestampMs >= createStartedAt.getTime() - 30_000 && timestampMs <= Date.now() + 30_000;
      });
      const failure = error && typeof error === "object" && "failure" in error
        ? (error as { failure: unknown }).failure
        : { message: error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000) };
      if (matching?.orderId) {
        writeActiveOrder({
          order_id: matching.orderId,
          server_id: candidate.serverId,
          project_tag: "ai-video-platform-wan22",
          created_at: createStartedAt.toISOString(),
          status: "order_pending",
          usd_per_hour: candidate.effectivePriceUsdPerHour ?? input.candidate.hourlyUsd ?? 0,
          max_price_usd_per_hour: candidate.effectivePriceUsdPerHour ?? input.candidate.hourlyUsd ?? 0,
          order_type: "on-demand",
          open_ports: ["ssh/tcp"],
          gpu_type: candidate.gpu,
          gpu_profile: candidate.runtimeGpuProfile,
          bootstrap_image: `${manifest.image}@${manifest.digest}`,
        });
        if (parity) updateManualParityState({ orderId: matching.orderId, passwordConfiguredInPayload: request.ssh_password === parity.sshPassword });
        writeLastCreateEvidence({
          requestStartedAt: createStartedAt.toISOString(), completedAt: new Date().toISOString(),
          candidateId: candidate.serverId, outcome: "reconciled_order", orderId: matching.orderId, failure,
        });
        const recovered = await this.getSession(matching.orderId);
        if (!recovered) throw new Error("clore_reconciled_session_state_missing");
        return recovered;
      }
      if (parity) clearManualParitySecrets();
      writeLastCreateEvidence({
        requestStartedAt: createStartedAt.toISOString(), completedAt: new Date().toISOString(),
        candidateId: candidate.serverId, outcome: "failed_request", orderId: null, failure,
      });
      throw error;
    }
    writeLastCreateEvidence({
      requestStartedAt: createStartedAt.toISOString(), completedAt: new Date().toISOString(),
      candidateId: candidate.serverId, outcome: "successful_order", orderId: created.order_id, failure: null,
    });
    if (parity) updateManualParityState({ orderId: created.order_id, passwordConfiguredInPayload: request.ssh_password === parity.sshPassword });
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
    return loadTarget();
  }

  async stopSession() { /* Runtime is stopped over SSH by the first-image orchestrator. */ }

  async terminateSession(session: GpuSession) {
    const active = readActiveOrder();
    if (!active || active.order_id !== session.id) return;
    try {
      await cancelCloreOrder({ config: loadCloreConfig(), execution: loadCloreExecutionConfig(), orderId: session.id, processingJobs: 0, uploading: false, finalVideoUploaded: true, issue: "stage3m_session_complete" });
    } finally {
      clearManualParitySecrets();
      cleanupOrderKnownHosts(session.id);
      rmSync(TARGET_PATH, { force: true });
    }
  }

  async getBilling(session: GpuSession) {
    const elapsedSeconds = session.createdAt ? Math.max(0, (Date.now() - Date.parse(session.createdAt)) / 1000) : null;
    const estimatedSpendUsd = elapsedSeconds === null || session.hourlyUsd === null ? null : session.hourlyUsd * elapsedSeconds / 3600;
    return { hourlyUsd: session.hourlyUsd, computeHourly: session.price?.computeHourly ?? null, storageHourly: 0, totalHourly: session.price?.totalHourly ?? null, projectedSessionTotal: session.price?.projectedSessionTotal ?? null, elapsedSeconds, estimatedSpendUsd };
  }
}
