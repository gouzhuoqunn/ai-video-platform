import assert from "node:assert/strict";
import { FrozenImageSessionMembershipChangedError, hydrateFrozenImageSessionPlan, planImageSession, runImageSession, type ImageSessionDeps, type ImageSessionReceipt } from "./clore/image-session";
import { receiptHasAcceptedInference, terminalizeReceipt } from "./clore/image-session-supervision";
import type { LocalImageTask } from "../src/lib/image-generation/local-image-task-store";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const task = (value: number, patch: Partial<LocalImageTask> = {}): LocalImageTask => ({
  id: id(value),
  status: "waiting_for_gpu",
  mode: "text_generation",
  referenceImage: null,
  prompt: `fixture-${value}`,
  width: 768,
  height: 768,
  steps: 30,
  cfg: 4,
  loraStrength: .8,
  seed: value,
  sampler: "Euler",
  gpuClass: "rtx4090",
  createdAt: `2026-07-26T00:0${value}:00.000Z`,
  updatedAt: "2026-07-26T00:00:00.000Z",
  ...patch,
});

async function main() {
  const storedInUiOrder = [task(5), task(4), task(3), task(2), task(1, { priority: "urgent" })];
  const uiOrderA = [id(5), id(4), id(3), id(2), id(1)];
  const expectedCanonical = [id(1), id(2), id(3), id(4), id(5)];
  const planned = planImageSession(storedInUiOrder, { requestedTaskIds: uiOrderA, gpuClass: "rtx4090", maxBatchSize: 5, activeOrderCount: 0 });
  const sameIdsDifferentInputOrder = planImageSession(storedInUiOrder, { requestedTaskIds: [...uiOrderA].reverse(), gpuClass: "rtx4090", maxBatchSize: 5, activeOrderCount: 0 });
  assert.deepEqual(planned.selectedTaskIds, expectedCanonical, "planner owns the only canonical order");
  assert.deepEqual(sameIdsDifferentInputOrder.selectedTaskIds, expectedCanonical, "harmless UI input order changes normalize once");
  assert.deepEqual(
    planImageSession([task(1)], { requestedTaskIds: [id(1)], gpuClass: "rtx4090", maxBatchSize: 8 }).selectedTaskIds,
    [id(1)],
    "the paid acceptance plan is exactly one explicitly requested task",
  );

  const rehydrated = hydrateFrozenImageSessionPlan([...storedInUiOrder].reverse(), planned.selectedTaskIds, { gpuClass: "rtx4090", activeOrderCount: 0 });
  assert.deepEqual(rehydrated.selectedTaskIds, expectedCanonical, "runner/session preflight preserve persisted order without sorting again");

  let storedReceipt: ImageSessionReceipt | null = null;
  const events: string[] = [];
  const byId = new Map(storedInUiOrder.map((value) => [value.id, value]));
  const deps: ImageSessionDeps = {
    now: () => "2026-07-26T01:00:00.000Z",
    nowMs: () => Date.parse("2026-07-26T01:00:00.000Z"),
    persist: (receipt) => { storedReceipt = structuredClone(receipt); },
    load: () => storedReceipt,
    reconcileZeroActiveOrders: async () => { events.push("reconcile"); },
    preflight: async (taskIds) => { events.push(`preflight:${taskIds.join(",")}`); },
    createOrder: async () => ({ orderId: "fake-order" }),
    armWatchdog: async () => { events.push("watchdog"); },
    prepareRuntimeOnce: async () => { events.push("runtime"); },
    verifyModelsOnce: async () => { events.push("models"); },
    readEligible: async (taskId) => byId.get(taskId) as never,
    claim: async (value) => { events.push(`claim:${value.id}`); return { token: `token:${value.id}` }; },
    startHeartbeat: () => ({ stop: () => undefined, assertHealthy: () => undefined }),
    writeTaskReceipt: async () => undefined,
    submitInference: async (value) => { events.push(`submit:${value.id}`); },
    pollAndFinalize: async (value) => { events.push(`finalize:${value.id}`); },
    failTask: async () => undefined,
    cancelExactOrder: async () => { events.push("cancel"); },
    confirmNoActiveOrders: async () => { events.push("zero"); },
    disarmWatchdog: async () => { events.push("disarm"); },
  };
  const completed = await runImageSession({ sessionId: "canonical", plan: rehydrated, normalGenerationMs: 1, cleanupMs: 1 }, deps);
  assert.deepEqual(completed.selectedTaskIds, expectedCanonical, "receipt receives the persisted canonical order");
  assert.deepEqual(events.filter((event) => event.startsWith("preflight:")), [`preflight:${expectedCanonical.join(",")}`]);
  assert.deepEqual(events.filter((event) => event.startsWith("claim:")).map((event) => event.slice("claim:".length)), expectedCanonical, "worker claims in canonical order");
  assert.deepEqual(events.filter((event) => event.startsWith("submit:")).map((event) => event.slice("submit:".length)), expectedCanonical, "progress/inference follows canonical order");

  const providerMutationCount = 0;
  const changed = storedInUiOrder.map((value) => value.id === id(3) ? { ...value, status: "generating" as const } : value);
  assert.throws(() => hydrateFrozenImageSessionPlan(changed, expectedCanonical, { gpuClass: "rtx4090" }), FrozenImageSessionMembershipChangedError);
  assert.equal(providerMutationCount, 0, "membership mismatch occurs before any provider call");
  assert.throws(() => hydrateFrozenImageSessionPlan(storedInUiOrder.filter((value) => value.id !== id(4)), expectedCanonical, { gpuClass: "rtx4090" }), FrozenImageSessionMembershipChangedError);
  assert.throws(() => hydrateFrozenImageSessionPlan(storedInUiOrder.map((value) => value.id === id(2) ? { ...value, result: { pngSha256: "x" } } : value), expectedCanonical, { gpuClass: "rtx4090" }), FrozenImageSessionMembershipChangedError);
  assert.deepEqual(planImageSession(storedInUiOrder, { requestedTaskIds: [id(5), id(4)], gpuClass: "rtx4090", maxBatchSize: 2 }).selectedTaskIds, [id(4), id(5)], "a new start does not reuse stale frozen IDs");

  const acceptedReceipt = { sessionId: "historical", sessionState: "ambiguous", currentTaskId: id(1), tasks: { [id(1)]: { inferenceState: "accepted", terminal: "ambiguous" } }, timestamps: {} };
  assert.equal(receiptHasAcceptedInference(acceptedReceipt), true);
  assert.equal(terminalizeReceipt(acceptedReceipt, { sessionId: "historical", state: "failed", error: "fixture", now: "2026-07-26T01:00:00.000Z" })?.sessionState, "ambiguous", "accepted historical evidence is preserved, not cleared");

  console.log(JSON.stringify({ ok: true, canonicalTaskIds: expectedCanonical, canonicalSingleTask: true, membershipChangesFailBeforeProvider: true, stalePreOrderFreezeDoesNotContaminateNewPlan: true, acceptedHistoricalReceiptPreserved: true, providerMutationCount }));
}

void main();
