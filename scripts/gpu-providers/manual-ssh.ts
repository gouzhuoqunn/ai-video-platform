import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertGpuTarget, FIXED_RUNTIME_DIGEST, sshCommand } from "./common";
import type { CreateSessionInput, GpuCandidate, GpuProvider, GpuSession, GpuTarget } from "./types";

const TARGET_PATH = path.join(process.cwd(), ".secrets", "manual-gpu-target.json");

export function loadManualTarget(): GpuTarget {
  if (!existsSync(TARGET_PATH)) throw new Error("manual_ssh target is missing from .secrets.");
  const input = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as Partial<GpuTarget> & { user?: string };
  return assertGpuTarget({
    provider: "manual_ssh",
    host: String(input.host ?? ""),
    port: Number(input.port),
    username: String(input.username ?? input.user ?? "root"),
    sshKeyPath: String(input.sshKeyPath ?? ""),
    gpuProfile: input.gpuProfile === "rtx5090" || input.gpuProfile === "bootstrap_image_gpu" || input.gpuProfile === "ampere_image_gpu" ? input.gpuProfile : "rtx4090",
    runtimeDigest: String(input.runtimeDigest ?? FIXED_RUNTIME_DIGEST),
  });
}

export class ManualSshProvider implements GpuProvider {
  readonly id = "manual_ssh" as const;
  async inspectCredentials() { return { provider: this.id, credentials_present: existsSync(TARGET_PATH), source: existsSync(TARGET_PATH) ? "external" as const : "none" as const, safe_to_query: existsSync(TARGET_PATH) }; }
  async getBalance() { return { availableUsd: null, supported: false }; }
  async listCandidates(): Promise<GpuCandidate[]> { return []; }
  async createSession(_input: CreateSessionInput): Promise<GpuSession> { throw new Error("manual_ssh does not create or pay for GPU sessions."); }
  async recoverExistingSession() { return existsSync(TARGET_PATH) ? this.getSession("manual-ssh") : null; }
  async getSession(_sessionId: string): Promise<GpuSession | null> {
    if (!existsSync(TARGET_PATH)) return null;
    return { provider: this.id, id: "manual-ssh", name: "manual-ssh", status: "EXTERNAL", createdAt: null, lastStatusChange: null, hourlyUsd: null, price: null, costPerHr: null, adjustedCostPerHr: null, containerDiskInGb: null, volumeInGb: null, cloudType: null, gpuType: null, target: loadManualTarget() };
  }
  async waitForSsh(session: GpuSession) {
    const target = session.target ?? loadManualTarget();
    if (sshCommand(target, "true").status !== 0) throw new Error("manual_ssh_connection_failed");
    return target;
  }
  async stopSession() { /* External lifecycle stays user-managed. */ }
  async terminateSession() { /* External lifecycle stays user-managed. */ }
  async getBilling() { return { hourlyUsd: null, computeHourly: null, storageHourly: null, totalHourly: null, projectedSessionTotal: null, elapsedSeconds: null, estimatedSpendUsd: null }; }
}
