import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { buildRunPodCreatePayload, RUNPOD_GPU_PRIORITY, RunPodProvider, RunPodRestClient, runPodCandidates, runPodWatchdogPlan, type RunPodConfig } from "./gpu-providers/runpod";
import { CloreProvider } from "./gpu-providers/clore";

async function main() {
const config: RunPodConfig = { apiKey: "test-only-token", keySource: "environment", maxHourlyUsd: 0.7, maxSessionUsd: 2.5, sshPublicKeyPath: "test.pub", sshPrivateKeyPath: "test", bootstrapImage: "ghcr.io/example/bootstrap@sha256:" + "a".repeat(64) };
const candidate = runPodCandidates(0.69)[0];
const input = { sessionId: "stage3j-test", candidate, sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFN0YWdlM0pUZXN0S2V5 test", bootstrapImage: config.bootstrapImage, dryRun: false };
const payload = buildRunPodCreatePayload(input);
assert.deepEqual(payload.ports, ["22/tcp", "8080/http"]);
assert.ok(!payload.ports.some((port) => port.startsWith("8188/")));
assert.equal(payload.interruptible, false);
assert.equal(payload.cloudType, "SECURE");
assert.equal(payload.gpuCount, 1);
assert.equal(payload.volumeMountPath, "/workspace");
assert.deepEqual(runPodCandidates().map((item) => item.gpuType), RUNPOD_GPU_PRIORITY.map(([name]) => name));
assert.throws(() => buildRunPodCreatePayload({ ...input, candidate: { ...candidate, interruptible: true as false } }), /spot/);
assert.throws(() => buildRunPodCreatePayload({ ...input, candidate: { ...candidate, vramGb: 12 } }), /hardware/);
assert.deepEqual(runPodWatchdogPlan("pod-1"), { provider: "runpod", session_id: "pod-1", action: "terminate", deadline_minutes: 15, terminate_priority: true });
await assert.rejects(() => new RunPodProvider({ config: { ...config, maxHourlyUsd: 0.5 } }).createSession(input), /hourly_budget/);
process.env.CLORE_DEPLOYMENT_HOLD = "true";
await assert.rejects(() => new CloreProvider().createSession(input), /HOLD/);
assert.equal((await new RunPodProvider({ config: { ...config, apiKey: "" } }).inspectCredentials()).credentials_present, false);

let retryCalls = 0;
const retryClient = new RunPodRestClient(config, async () => {
  retryCalls += 1;
  return retryCalls === 1 ? new Response("limited", { status: 429, headers: { "retry-after": "0.001" } }) : Response.json([]);
});
await retryClient.listPods();
assert.equal(retryCalls, 2);

let createCalls = 0;
const fetchMock: typeof fetch = async (_url, init) => {
  const method = init?.method ?? "GET";
  if (method === "POST") {
    createCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({ id: "pod-1", name: "ai-video-first-image-stage3j-test", desiredStatus: "CREATED", adjustedCostPerHr: 0.69 });
  }
  return Response.json([]);
};
rmSync(path.join(process.cwd(), ".secrets", "runpod-create.lock"), { force: true });
const provider = new RunPodProvider({ config, fetchImpl: fetchMock });
const [first, second] = await Promise.all([provider.createSession(input), provider.createSession(input)]);
assert.equal(first.id, "pod-1");
assert.equal(second.id, "pod-1");
assert.equal(createCalls, 1);
console.log("RunPod provider API, payload, budget, retry, idempotency, hold isolation, and watchdog tests passed.");
}
void main();
