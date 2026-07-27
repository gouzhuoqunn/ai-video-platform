import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertDownloadedPngMatchesMetadata,
  capturePostFinalizationUiVerification,
  cleanupLiveSession,
  resolveSingleCreatedOrder,
  RuntimeDeploymentFailure,
  type CleanupLiveSessionResult,
} from "./image-live-runtime";
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

  const liveRuntimeSource = readFileSync(new URL("./image-live-runtime.ts", import.meta.url), "utf8");
  const receiptPersistence = liveRuntimeSource.indexOf("await input.onOrderPersisted?.(owned);");
  const activeOrderPersistence = liveRuntimeSource.indexOf("writeActiveOrder({", receiptPersistence);
  const directOrderPersistence = liveRuntimeSource.indexOf("if (direct) await persistCandidateOrder(context, direct);");
  const firstPostCreateRead = liveRuntimeSource.indexOf("const active = await readAttemptOrders();", directOrderPersistence);
  assert.ok(receiptPersistence >= 0 && activeOrderPersistence > receiptPersistence, "the caller receipt is persisted before local active-order state");
  assert.ok(directOrderPersistence >= 0 && firstPostCreateRead > directOrderPersistence, "a direct create result is persisted before any reconciliation read");

  const supervisorSource = readFileSync(new URL("./image-session-supervisor.ts", import.meta.url), "utf8");
  const statusStart = supervisorSource.indexOf("async function status()");
  const waitStart = supervisorSource.indexOf("async function wait()", statusStart);
  const statusSource = supervisorSource.slice(statusStart, waitStart);
  assert.ok(statusStart >= 0 && waitStart > statusStart);
  assert.match(statusSource, /terminalizeDeadWorker\b/, "status may terminalize local worker metadata");
  assert.doesNotMatch(statusSource, /cleanupLiveSession|cleanupReceiptOwnedOrder|readLiveOrdersSummary|cloreRequest|cancelOrder/, "status polling must not read or mutate provider state");

  const apiRouteSource = readFileSync(new URL("../../src/app/api/local-lab/image-tasks/route.ts", import.meta.url), "utf8");
  const responsePayloadStart = apiRouteSource.indexOf("async function responsePayload(");
  const localProgramStart = apiRouteSource.indexOf("function readLocalProgramStatus()", responsePayloadStart);
  const responsePayloadSource = apiRouteSource.slice(responsePayloadStart, localProgramStart);
  assert.ok(responsePayloadStart >= 0 && localProgramStart > responsePayloadStart);
  assert.doesNotMatch(responsePayloadSource, /reconcileStaleRunner|clearLocalActiveImageState|clearOrderCreateLocks|stopRunnerProcessTree|saveRunner|cloreRequest|readLiveOrdersSummary/, "UI status polling must remain read-only");
  assert.match(apiRouteSource, /scripts", "clore", "image-session-supervisor\.ts"/, "the guarded UI start uses the detached session supervisor");
  assert.doesNotMatch(apiRouteSource, /scripts", "image-4090-runner\.ts"/, "the UI must not start the legacy runner directly");
  const directExecuteSource = readFileSync(new URL("./image-session-execute.ts", import.meta.url), "utf8");
  assert.doesNotMatch(directExecuteSource, /runLiveImageSession/, "the legacy execute command must not bypass the detached worker");
  assert.match(directExecuteSource, /direct_image_session_execute_disabled_use_image_session_supervisor/);

  const png = Buffer.from("fixture-png");
  const sha256 = createHash("sha256").update(png).digest("hex");
  assert.doesNotThrow(() => assertDownloadedPngMatchesMetadata(png, { byte_size: png.length, sha256 }));
  assert.throws(() => assertDownloadedPngMatchesMetadata(png, { byte_size: png.length + 1, sha256 }), /remote_png_verification_failed/);
  console.log(JSON.stringify({ ok: true, singleOrderInvariant: true, selectedCandidatePlanPersisted: true, immediateOwnedOrderPersistence: true, sessionReceiptEndpointRedacted: true, detachedSupervisorProductionWiring: true, twoZeroCleanupRequired: true, watchdogRetainedOnUncertainty: true, deadWorkerReceiptCleanupProjection: true, statusPollingProviderMutationCount: 0, postFinalizationUiFailureNonfatal: true, pngByteSizeVerified: true, providerMutationCount: 0 }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
