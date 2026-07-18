import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CloreLongVideoProviderAdapter } from "../src/lib/long-video/clore-adapter";
import type { GpuProvider, GpuSession } from "./gpu-providers/types";
import { getCloreDeploymentHold, setCloreDeploymentHold } from "./clore/deployment-hold";

const baseSession: GpuSession = {
  provider: "clore", id: "fake-order", name: "fake", status: "running", createdAt: new Date().toISOString(), lastStatusChange: null,
  hourlyUsd: 0.24, price: { computeHourly: 0.24, storageHourly: 0, totalHourly: 0.24, projectedSessionTotal: 0.8 }, costPerHr: 0.24,
  adjustedCostPerHr: null, containerDiskInGb: 3000, volumeInGb: 0, cloudType: "SECURE", gpuType: "NVIDIA GeForce RTX 4090",
  target: { provider: "clore", host: "exact.returned.example", port: 1444, username: "root", sshKeyPath: "C:\\fake\\id_ed25519", gpuProfile: "rtx4090", runtimeDigest: "sha256:fake" },
};

class FakeGpuProvider implements GpuProvider {
  readonly id = "clore" as const;
  createCount = 0;
  terminateCount = 0;
  waitFailure = false;
  async inspectCredentials() { return { provider: "clore" as const, credentials_present: true, source: "external" as const, safe_to_query: true }; }
  async getBalance() { return { availableUsd: 10, supported: true }; }
  async listCandidates() { return [
    { id: "4090-a", gpuType: "NVIDIA GeForce RTX 4090", priority: 0, vramGb: 24, gpuCount: 1 as const, minimumRamGb: 64, containerDiskGb: 3000, volumeGb: 0, hourlyUsd: 0.24, interruptible: false as const },
    { id: "5090-b", gpuType: "NVIDIA GeForce RTX 5090", priority: 1, vramGb: 32, gpuCount: 1 as const, minimumRamGb: 64, containerDiskGb: 3000, volumeGb: 0, hourlyUsd: 0.30, interruptible: false as const },
  ]; }
  async createSession() { this.createCount += 1; return this.waitFailure ? { ...baseSession, target: null } : baseSession; }
  async getSession() { return baseSession; }
  async waitForSsh() { if (this.waitFailure) throw new Error("ssh_probe_failed"); return baseSession.target!; }
  async stopSession() {}
  async terminateSession() { this.terminateCount += 1; }
  async getBilling() { return { hourlyUsd: 0.24, computeHourly: 0.24, storageHourly: 0, totalHourly: 0.24, projectedSessionTotal: 0.8, elapsedSeconds: 0, estimatedSpendUsd: 0 }; }
  async recoverExistingSession() { return baseSession; }
}

const previousHold = getCloreDeploymentHold();
setCloreDeploymentHold(true, "stage4h4-contract-test");
void (async () => {
try {
  const gpu = new FakeGpuProvider();
  const adapter = new CloreLongVideoProviderAdapter({ gpu, activeOrderReader: async () => 0 });
  const candidates = await adapter.listCandidates();
  assert.deepEqual(candidates.map((candidate) => candidate.gpuProfile), ["rtx4090"]);
  const watchdogBound = new CloreLongVideoProviderAdapter({ gpu, activeOrderReader: async () => 0, watchdogServerId: "4090-a" });
  assert.deepEqual((await watchdogBound.listCandidates()).map((candidate) => candidate.serverId), ["4090-a"]);
  const authorization = { id: "contract-auth", projectId: "11111111-1111-4111-8111-111111111111", provider: "clore" as const, gpuProfile: "rtx4090" as const, oneUse: true as const, expiresAt: new Date(Date.now() + 60_000).toISOString(), maxSpendUsd: 1.2, releaseHold: true };
  const session = await adapter.createSession({ projectId: authorization.projectId, authorization, candidate: candidates[0] });
  assert.equal(gpu.createCount, 1);
  gpu.waitFailure = true;
  const failedAdapter = new CloreLongVideoProviderAdapter({ gpu, activeOrderReader: async () => 0 });
  await assert.rejects(() => failedAdapter.createSession({ projectId: authorization.projectId, authorization, candidate: candidates[0] }), /ssh_probe_failed/);
  assert.equal(gpu.terminateCount, 1);
  assert.equal(session.host, "exact.returned.example");
  assert.equal(session.port, 1444);
  await assert.rejects(() => adapter.createSession({ projectId: authorization.projectId, authorization, candidate: candidates[0] }), /clore_adapter_session_already_bound/);
  assert.equal(gpu.createCount, 2);
  const source = readFileSync("src/lib/long-video/clore-adapter.ts", "utf8");
  assert.doesNotMatch(source, /stage4[ac]/i);
  assert.doesNotMatch(source, /8fff4d9f|29167|105178/);
  console.log(JSON.stringify({ ok: true, adapterReady: true, rtx5090Rejected: true, watchdogBoundCandidate: true, oneOrderGuard: true, exactEndpoint: true, sshFailureCleanup: true, historicalIdsAbsent: true }));
} finally {
  setCloreDeploymentHold(previousHold.enabled, previousHold.reason);
}
})().catch((error) => { console.error(error); process.exitCode = 1; });
