import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertDownloadedPngMatchesMetadata,
  buildLiveAgentModelManifest,
  capturePostFinalizationUiVerification,
  cleanupLiveSession,
  recordGoldenRuntimeDeploymentFailureEvidence,
  recordGoldenRuntimeDeploymentSuccessEvidence,
  resolveSingleCreatedOrder,
  RuntimeDeploymentFailure,
  type CleanupLiveSessionResult,
} from "./image-live-runtime";
import type { EligibleImageTask } from "./run-image-e2e";
import type { RemoteImageModel } from "./image-model-preflight";
import {
  deploymentFailureCount,
  readTemporaryDeploymentDeniedServerIds,
  scopedDeploymentFailureCount,
} from "./deployment-host-blacklist";
import { rtx4090GoldenDeploymentFingerprint } from "../image-executor/rtx4090-golden-deployment-profile";
import { cleanupReceiptOwnedOrder } from "./image-session-supervision";
import { applySelectedPlanToReceipt } from "./image-session-live";
import type { CloreOrderSummary } from "./live";

const order = (patch: Partial<CloreOrderSummary> = {}): CloreOrderSummary => ({
  orderId: "order-1",
  serverId: "1001",
  status: "running",
  currency: "USD-Blockchain",
  price: .2,
  fee: 0,
  creationFee: 0,
  spend: 0,
  createdTimestamp: Math.floor(Date.parse("2026-07-27T00:00:01.000Z") / 1_000),
  expired: false,
  active: true,
  startedAt: "2026-07-27T00:00:01.000Z",
  controllerUrl: null,
  ...patch,
});

const owned = { orderId: "order-1", serverId: "1001", startingBalanceUsd: 4 };

async function main() {
  const selected = resolveSingleCreatedOrder({
    activeOrders: [order()],
    serverId: "1001",
    requestStartedAt: new Date("2026-07-27T00:00:00.000Z"),
    directOrderId: "order-1",
  });
  assert.equal(selected?.orderId, "order-1");
  assert.throws(() => resolveSingleCreatedOrder({
    activeOrders: [order(), order({ orderId: "order-2", serverId: "1002" })],
    serverId: "1001",
    requestStartedAt: new Date("2026-07-27T00:00:00.000Z"),
  }), /ambiguous/);
  assert.throws(() => resolveSingleCreatedOrder({
    activeOrders: [order({ serverId: "1002" })],
    serverId: "1001",
    requestStartedAt: new Date("2026-07-27T00:00:00.000Z"),
  }), /server_mismatch/);
  assert.throws(() => resolveSingleCreatedOrder({
    activeOrders: [order({ createdTimestamp: Math.floor(Date.parse("2026-07-26T00:00:00.000Z") / 1_000) })],
    serverId: "1001",
    requestStartedAt: new Date("2026-07-27T00:00:00.000Z"),
  }), /predates/);

  let cancelCalls = 0;
  let disarmCalls = 0;
  const clean = await cleanupLiveSession(owned, {
    cancelOrder: async (id) => { cancelCalls += 1; assert.equal(id, owned.orderId); },
    readOrders: async () => [],
    sleep: async () => undefined,
    readActive: () => null,
    disarmWatchdog: () => { disarmCalls += 1; },
  });
  assert.equal(clean.cancellationState, "cancelled");
  assert.equal(clean.zeroConfirmations, 2);
  assert.equal(clean.cleanupConfirmed, true);
  assert.equal(clean.watchdogDisarmed, true);
  assert.equal(clean.localOrderStateCleared, true);
  assert.equal(cancelCalls, 1);
  assert.equal(disarmCalls, 1);

  let unsafeDisarmCalls = 0;
  const unsafe = await cleanupLiveSession(owned, {
    cancelOrder: async () => undefined,
    readOrders: async () => [{ ...order(), active: true }],
    sleep: async () => undefined,
    readActive: () => ({ order_id: owned.orderId, project_tag: "ai-video-platform-wan22", server_id: owned.serverId, created_at: "2026-07-27T00:00:00.000Z", status: "order_pending", usd_per_hour: .2, max_price_usd_per_hour: .3, order_type: "on-demand", open_ports: ["controller/http:8080"] }),
    disarmWatchdog: () => { unsafeDisarmCalls += 1; },
  });
  assert.equal(unsafe.zeroConfirmations, 0);
  assert.equal(unsafe.cancellationState, "cancellation_unconfirmed");
  assert.equal(unsafe.watchdogDisarmed, false);
  assert.equal(unsafe.cleanupConfirmed, false);
  assert.equal(unsafeDisarmCalls, 0);

  const reconciled = await cleanupLiveSession(owned, {
    cancelOrder: async () => { throw new Error("already gone"); },
    readOrders: async () => [],
    sleep: async () => undefined,
    readActive: () => null,
    disarmWatchdog: () => undefined,
  });
  assert.equal(reconciled.cancellationState, "reconciled_inactive");
  assert.equal(reconciled.cleanupConfirmed, true);

  let knownInactiveCancelCalls = 0;
  let knownInactiveReads = 0;
  const knownInactive = await cleanupLiveSession(owned, {
    orderKnownInactive: true,
    cancelOrder: async () => { knownInactiveCancelCalls += 1; },
    readOrders: async () => { knownInactiveReads += 1; return []; },
    sleep: async () => undefined,
    readActive: () => null,
    disarmWatchdog: () => undefined,
  });
  assert.equal(knownInactiveCancelCalls, 0, "inactive reconciliation performs no cancel mutation");
  assert.equal(knownInactiveReads, 2, "inactive reconciliation still requires two fresh zero reads");
  assert.equal(knownInactive.cancellationState, "reconciled_inactive");
  assert.equal(knownInactive.cleanupConfirmed, true);

  let splitReadCount = 0;
  let splitDisarmCalls = 0;
  const splitRead = await cleanupLiveSession(owned, {
    orderKnownInactive: true,
    readOrders: async () => {
      splitReadCount += 1;
      return splitReadCount === 1 ? [] : [order()];
    },
    sleep: async () => undefined,
    readActive: () => null,
    disarmWatchdog: () => { splitDisarmCalls += 1; },
  });
  assert.equal(splitRead.zeroConfirmations, 1);
  assert.equal(splitRead.cleanupConfirmed, false);
  assert.equal(splitDisarmCalls, 0);

  const fiveRoles = ["transformer", "lora", "vae", "clip_l", "t5"];
  const fiveIds = ["fluxed-up-10.2", "aidma-lora", "flux-vae", "flux-clip-l", "flux-t5xxl-fp8"] as const;
  const coreModels: RemoteImageModel[] = fiveRoles.map((role, index) => ({
    role,
    id: fiveIds[index],
    filename: `core-${index}.safetensors`,
    url: `https://downloads.example.invalid/core-${index}.safetensors`,
    sha256: String(index).repeat(64),
    size_bytes: index + 1,
  }));
  const loraSelection = [{
    id: "11111111-1111-4111-8111-111111111111",
    name: "fixture",
    filename: "fixture.safetensors",
    strength: .8,
    enabled: true,
    sha256: "a".repeat(64),
    sizeBytes: 123,
  }];
  const sameLoraTasks = Array.from({ length: 4 }, (_, index) => ({
    id: `task-${index}`,
    loras: structuredClone(loraSelection),
  })) as EligibleImageTask[];
  let coreVerifyCalls = 0;
  let loraVerifyCalls = 0;
  const deduplicatedManifest = await buildLiveAgentModelManifest(sameLoraTasks, {
    verifyModels: async () => {
      coreVerifyCalls += 1;
      return { models: coreModels, checked: [] };
    },
    verifyLoras: async () => {
      loraVerifyCalls += 1;
      return {
        loras: [{
          id: loraSelection[0].id,
          filename: loraSelection[0].filename,
          url: "https://downloads.example.invalid/fixture.safetensors",
          sha256: loraSelection[0].sha256,
          size_bytes: loraSelection[0].sizeBytes,
        }],
        checked: [],
      };
    },
  });
  assert.equal(coreVerifyCalls, 1);
  assert.equal(loraVerifyCalls, 1, "four cloned task selections share one immutable LoRA preflight");
  assert.equal(deduplicatedManifest.models.length, 5);
  assert.equal(deduplicatedManifest.loras?.length, 1);

  const fakeResult: CleanupLiveSessionResult = {
    cancellationState: "cancellation_unconfirmed",
    zeroConfirmations: 1,
    watchdogDisarmed: false,
    localOrderStateCleared: false,
    cleanupConfirmed: false,
    cleanupErrors: ["fixture"],
  };
  const recovered = await cleanupReceiptOwnedOrder(
    { sessionId: "session", orderId: owned.orderId, serverId: owned.serverId, sessionState: "running", cleanupEvidence: null, timestamps: {}, firstError: null },
    { cleanup: async (value) => { assert.equal(value.orderId, owned.orderId); assert.equal(value.serverId, owned.serverId); assert.equal(typeof value.startingBalanceUsd, "number"); return fakeResult; }, now: () => "2026-07-27T00:00:02.000Z" },
  );
  assert.equal(recovered.receipt?.sessionState, "ambiguous");
  assert.equal(recovered.receipt?.cancellationState, "cancellation_unconfirmed");
  assert.deepEqual(recovered.receipt?.cleanupEvidence, { zeroActiveOrderConfirmations: 1, watchdogDisarmed: false, localOrderStateCleared: false });

  const uiFailure = await capturePostFinalizationUiVerification(async () => { throw new Error("fixture_ui_unavailable"); });
  assert.equal(uiFailure.uiVerified, false);
  assert.match(uiFailure.uiVerificationError ?? "", /fixture_ui_unavailable/);
  const uiSuccess = await capturePostFinalizationUiVerification(async () => undefined);
  assert.deepEqual(uiSuccess, { uiVerified: true, uiVerificationError: null });

  const selectedPlanReceipt = {
    selectedGpuModel: null as string | null,
    selectedHourlyUsd: .3,
    projectedRentalCostUsd: 1.8,
    projectedCreationFeeUsd: 1.5,
    projectedProviderCostCeilingUsd: 3.3,
  };
  applySelectedPlanToReceipt(selectedPlanReceipt, {
    selectedGpuModel: "NVIDIA GeForce RTX 4090",
    selectedHourlyUsd: .2079166667,
    projectedRentalCostUsd: 1.25,
    projectedCreationFeeUsd: 1.5,
    projectedProviderCostCeilingUsd: 2.75,
  });
  assert.deepEqual(selectedPlanReceipt, {
    selectedGpuModel: "NVIDIA GeForce RTX 4090",
    selectedHourlyUsd: .2079166667,
    projectedRentalCostUsd: 1.25,
    projectedCreationFeeUsd: 1.5,
    projectedProviderCostCeilingUsd: 2.75,
  });

  const deploymentFailure = new RuntimeDeploymentFailure({
    order: { orderId: "order-1", serverId: "1001" },
    elapsedMs: 60_000,
    lastHttpStatus: 502,
    lastStartupDiagnostic: "agent_http_502",
  });
  const deploymentFailureEvidence = JSON.parse(deploymentFailure.message) as Record<string, unknown>;
  assert.equal(deploymentFailureEvidence.orderId, "order-1");
  assert.equal(deploymentFailureEvidence.serverId, "1001");
  assert.equal("proxyUrl" in deploymentFailureEvidence, false);
  assert.doesNotMatch(deploymentFailure.message, /https?:\/\//i);

  const deploymentEvidenceRoot = mkdtempSync(path.join(os.tmpdir(), "golden-runtime-failure-"));
  try {
    const historyPath = path.join(deploymentEvidenceRoot, "history.json");
    const denylistPath = path.join(deploymentEvidenceRoot, "denylist.json");
    const profileFingerprint = rtx4090GoldenDeploymentFingerprint();
    const recorded = recordGoldenRuntimeDeploymentFailureEvidence(
      { orderId: "order-1", serverId: "1001", lastHttpStatus: 502, profileFingerprint },
      { historyPath, denylistPath },
    );
    assert.deepEqual(recorded, {
      orderId: "order-1",
      serverId: "1001",
      reason: "golden_agent_proxy_502_timeout",
      profileFingerprint,
    });
    assert.equal(deploymentFailureCount("1001", historyPath), 1);
    assert.equal(scopedDeploymentFailureCount("1001", profileFingerprint, historyPath), 1);
    assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denylistPath, Date.now(), profileFingerprint), ["1001"]);
    assert.deepEqual(recordGoldenRuntimeDeploymentSuccessEvidence(
      { orderId: "order-3", serverId: "1001", profileFingerprint },
      { historyPath, denylistPath },
    ), { orderId: "order-3", serverId: "1001", profileFingerprint });
    assert.equal(scopedDeploymentFailureCount("1001", profileFingerprint, historyPath), 0);
    assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denylistPath, Date.now(), profileFingerprint), []);
    assert.doesNotThrow(() => recordGoldenRuntimeDeploymentFailureEvidence(
      { orderId: "order-2", serverId: "1002", lastHttpStatus: null, profileFingerprint },
      { historyPath: deploymentEvidenceRoot, denylistPath: deploymentEvidenceRoot },
    ), "failure-evidence persistence must not replace the primary deployment error");
  } finally {
    rmSync(deploymentEvidenceRoot, { recursive: true, force: true });
  }

  const liveRuntimeSource = readFileSync(new URL("./image-live-runtime.ts", import.meta.url), "utf8");
  assert.match(liveRuntimeSource, /recordGoldenRuntimeDeploymentFailureEvidence\(\{ orderId: order\.orderId, serverId: order\.serverId, lastHttpStatus, profileFingerprint: order\.deploymentProfileFingerprint \}\)/);
  assert.match(liveRuntimeSource, /recordGoldenRuntimeDeploymentSuccessEvidence\(\{ orderId: order\.orderId, serverId: order\.serverId, profileFingerprint: order\.deploymentProfileFingerprint \}\)/);
  const publishedSourcePreflight = liveRuntimeSource.indexOf("await verifyRtx4090GoldenPublishedSources();");
  const preCreateOrderRead = liveRuntimeSource.indexOf("const before = await readLiveOrdersSummary", publishedSourcePreflight);
  assert.ok(publishedSourcePreflight >= 0 && preCreateOrderRead > publishedSourcePreflight, "published immutable runtime sources are verified before any Clore order reconciliation or creation");
  const receiptPersistence = liveRuntimeSource.indexOf("await input.onOrderPersisted?.(owned);");
  const activeOrderPersistence = liveRuntimeSource.indexOf("writeActiveOrder({", receiptPersistence);
  const directOrderPersistence = liveRuntimeSource.indexOf("if (direct) await persistCandidateOrder(context, direct);");
  const firstPostCreateRead = liveRuntimeSource.indexOf("const active = await readAttemptOrders();", directOrderPersistence);
  assert.ok(receiptPersistence >= 0 && activeOrderPersistence > receiptPersistence, "the caller receipt is persisted before local active-order state");
  assert.ok(directOrderPersistence >= 0 && firstPostCreateRead > directOrderPersistence, "a direct create result is persisted before any reconciliation read");
  const inferenceBoundary = liveRuntimeSource.indexOf("export async function submitTaskInference");
  const submittingRetryBlock = liveRuntimeSource.indexOf("markImageTaskInferenceRetryBlocked(task.id", inferenceBoundary);
  const soleInferencePost = liveRuntimeSource.indexOf("agentPostJson(order.endpoint, order.token, \"/stage/inference\"", inferenceBoundary);
  const acceptedRetryBlock = liveRuntimeSource.indexOf("inferenceState: \"accepted\"", soleInferencePost);
  assert.ok(
    inferenceBoundary >= 0
    && soleInferencePost > inferenceBoundary
    && submittingRetryBlock > soleInferencePost
    && acceptedRetryBlock > submittingRetryBlock,
    "the inference call wires both the submitting tombstone and its accepted upgrade",
  );
  const inferenceFunctionSource = liveRuntimeSource.slice(inferenceBoundary, liveRuntimeSource.indexOf("export type CleanupLiveSessionResult", inferenceBoundary));
  assert.match(inferenceFunctionSource, /onRequested:\s*\(stageRunId\)\s*=>\s*\{[\s\S]*?markImageTaskInferenceRetryBlocked[\s\S]*?inferenceState:\s*"submitting"[\s\S]*?receipt\.requested\(stageRunId\)/);
  const agentPostSource = readFileSync(new URL("./run-image-e2e.ts", import.meta.url), "utf8");
  const agentPostBoundary = agentPostSource.slice(agentPostSource.indexOf("export async function agentPostJson"), agentPostSource.indexOf("export function resolveExactEligibleImageTask"));
  assert.ok(agentPostBoundary.indexOf("await options.onRequested?.(stageRunId)") < agentPostBoundary.indexOf("const response = await"), "onRequested persistence settles before fetch");
  assert.doesNotMatch(agentPostSource, /submitInferenceStage/, "no unguarded inference-specific POST helper remains");

  const supervisorSource = readFileSync(new URL("./image-session-supervisor.ts", import.meta.url), "utf8");
  const statusStart = supervisorSource.indexOf("async function status()");
  const waitStart = supervisorSource.indexOf("async function wait()", statusStart);
  const statusSource = supervisorSource.slice(statusStart, waitStart);
  assert.ok(statusStart >= 0 && waitStart > statusStart);
  assert.match(statusSource, /terminalizeDeadWorker\b/, "status may terminalize local worker metadata");
  assert.doesNotMatch(statusSource, /cleanupLiveSession|cleanupReceiptOwnedOrder|readLiveOrdersSummary|cloreRequest|cancelOrder/, "status polling must not read or mutate provider state");
  assert.match(supervisorSource, /--deployment-profile-fingerprint/, "supervisor handoff carries the complete deployment profile identity");
  assert.match(supervisorSource, /--agent-source-sha256/, "supervisor handoff carries the immutable Agent source hash");
  assert.match(supervisorSource, /rtx4090GoldenDeploymentFingerprint/, "supervisor validates the profile fingerprint before spawning the worker");
  assert.match(supervisorSource, /deploymentProfileFingerprint: fingerprint/, "the exact profile fingerprint is retained in worker state");
  assert.match(supervisorSource, /immutableSourcePreflight: \(\) => verifyRtx4090GoldenPublishedSources\(\)/, "source preflight is wired before prior-session reconciliation");
  const supervisionSource = readFileSync(new URL("./image-session-supervision.ts", import.meta.url), "utf8");
  const sourcePreflightCall = supervisionSource.indexOf("await options.immutableSourcePreflight?.();");
  const priorOrderRead = supervisionSource.indexOf("const active = await (options.readActiveOrders", sourcePreflightCall);
  assert.ok(sourcePreflightCall >= 0 && priorOrderRead > sourcePreflightCall, "a failed immutable-source preflight performs no Clore read");
  const workerSource = readFileSync(new URL("./image-session-worker.ts", import.meta.url), "utf8");
  assert.match(workerSource, /--deployment-profile-fingerprint/, "worker receives the complete deployment profile identity");
  assert.match(workerSource, /agentSourceSha256 !== profile\.immutable\.agentSourceSha256/, "worker rejects a mismatched immutable Agent source hash");

  const apiRouteSource = readFileSync(new URL("../../src/app/api/local-lab/image-tasks/route.ts", import.meta.url), "utf8");
  const responsePayloadStart = apiRouteSource.indexOf("async function responsePayload(");
  const localProgramStart = apiRouteSource.indexOf("function readLocalProgramStatus()", responsePayloadStart);
  const responsePayloadSource = apiRouteSource.slice(responsePayloadStart, localProgramStart);
  assert.ok(responsePayloadStart >= 0 && localProgramStart > responsePayloadStart);
  assert.doesNotMatch(responsePayloadSource, /reconcileStaleRunner|clearLocalActiveImageState|clearOrderCreateLocks|stopRunnerProcessTree|saveRunner|cloreRequest|readLiveOrdersSummary/, "UI status polling must remain read-only");
  assert.match(apiRouteSource, /scripts", "clore", "image-session-supervisor\.ts"/, "the guarded UI start uses the detached session supervisor");
  assert.match(apiRouteSource, /"--deployment-profile-fingerprint"/, "the guarded UI start passes the exact deployment profile fingerprint");
  assert.match(apiRouteSource, /"--agent-source-sha256"/, "the guarded UI start passes the immutable Agent source hash");
  assert.doesNotMatch(apiRouteSource, /scripts", "image-4090-runner\.ts"/, "the UI must not start the legacy runner directly");
  assert.match(apiRouteSource, /reconcileKnownInactiveLocalSession/, "zero-order recovery uses canonical two-read cleanup");
  assert.match(apiRouteSource, /cleanupLiveSession\(/, "operator cancellation uses centralized cleanup");
  assert.doesNotMatch(apiRouteSource, /cloreRequest\([^)]*cancel_order/, "the route never owns an independent cancel mutation");
  const matchingOrderSource = apiRouteSource.slice(
    apiRouteSource.indexOf("function matchingImageOrder"),
    apiRouteSource.indexOf("function resetRunnerAfterCancel"),
  );
  assert.doesNotMatch(matchingOrderSource, /order\.serverId\s*===/, "server reuse never authorizes cancellation");
  const directExecuteSource = readFileSync(new URL("./image-session-execute.ts", import.meta.url), "utf8");
  assert.doesNotMatch(directExecuteSource, /runLiveImageSession/, "the legacy execute command must not bypass the detached worker");
  assert.match(directExecuteSource, /direct_image_session_execute_disabled_use_image_session_supervisor/);

  const png = Buffer.from("fixture-png");
  const sha256 = createHash("sha256").update(png).digest("hex");
  assert.doesNotThrow(() => assertDownloadedPngMatchesMetadata(png, { byte_size: png.length, sha256 }));
  assert.throws(() => assertDownloadedPngMatchesMetadata(png, { byte_size: png.length + 1, sha256 }), /remote_png_verification_failed/);
  console.log(JSON.stringify({ ok: true, singleOrderInvariant: true, selectedCandidatePlanPersisted: true, immediateOwnedOrderPersistence: true, inferenceRetryBlockBeforeSolePost: true, sessionReceiptEndpointRedacted: true, detachedSupervisorProductionWiring: true, twoZeroCleanupRequired: true, knownInactiveSkipsCancelMutation: true, watchdogRetainedOnUncertainty: true, identicalGroupPreflightDeduplicated: true, deadWorkerReceiptCleanupProjection: true, statusPollingProviderMutationCount: 0, postFinalizationUiFailureNonfatal: true, pngByteSizeVerified: true, providerMutationCount: 0 }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
