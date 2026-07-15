import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getCloreDeploymentHold } from "../clore/deployment-hold";
import { readActiveOrder } from "../clore/order-state";
import { getPrivateKeyPath } from "../clore/ssh-client";
import { assertGpuTarget, FIXED_RUNTIME_DIGEST, sshCommand } from "./common";
import type { CreateSessionInput, GpuCandidate, GpuProvider, GpuSession, GpuTarget } from "./types";

const CLORE_ENV = path.join(process.cwd(), ".secrets", "clore.env");
const TARGET_PATH = path.join(process.cwd(), ".secrets", "clore-ssh-target.json");

function loadTarget(): GpuTarget {
  const input = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as Partial<GpuTarget> & { user?: string };
  return assertGpuTarget({ provider: "clore", host: String(input.host ?? ""), port: Number(input.port), username: String(input.username ?? input.user ?? "root"), sshKeyPath: String(input.sshKeyPath ?? getPrivateKeyPath()), gpuProfile: input.gpuProfile === "rtx5090" || input.gpuProfile === "bootstrap_image_gpu" ? input.gpuProfile : "rtx4090", runtimeDigest: String(input.runtimeDigest ?? FIXED_RUNTIME_DIGEST) });
}

export class CloreProvider implements GpuProvider {
  readonly id = "clore" as const;
  async inspectCredentials() { return { provider: this.id, credentials_present: existsSync(CLORE_ENV), source: existsSync(CLORE_ENV) ? "secret_file" as const : "none" as const, safe_to_query: existsSync(CLORE_ENV) }; }
  async getBalance() { return { availableUsd: null, supported: true }; }
  async listCandidates(): Promise<GpuCandidate[]> { return []; }
  async createSession(_input: CreateSessionInput): Promise<GpuSession> {
    if (getCloreDeploymentHold().enabled) throw new Error("CLORE_DEPLOYMENT_HOLD=true: refusing Clore session creation.");
    throw new Error("Clore creation remains in the guarded legacy order executor.");
  }
  async recoverExistingSession() { const active = readActiveOrder(); return active ? this.getSession(active.order_id) : null; }
  async getSession(_sessionId: string): Promise<GpuSession | null> {
    const active = readActiveOrder();
    if (!active) return null;
    return { provider: this.id, id: active.order_id, name: `clore-${active.server_id}`, status: active.status, createdAt: active.created_at, lastStatusChange: null, hourlyUsd: active.usd_per_hour, price: active.usd_per_hour === null ? null : { computeHourly: active.usd_per_hour, storageHourly: 0, totalHourly: active.usd_per_hour, projectedSessionTotal: active.usd_per_hour * 3.5 }, costPerHr: active.usd_per_hour, adjustedCostPerHr: null, containerDiskInGb: null, volumeInGb: null, cloudType: null, gpuType: null, target: existsSync(TARGET_PATH) ? loadTarget() : null };
  }
  async waitForSsh(session: GpuSession) { const target = session.target ?? loadTarget(); if (sshCommand(target, "true").status !== 0) throw new Error("clore_ssh_failed"); return target; }
  async stopSession() { /* Guarded legacy cancel remains authoritative. */ }
  async terminateSession() { /* Guarded legacy cancel remains authoritative. */ }
  async getBilling() { return { hourlyUsd: null, computeHourly: null, storageHourly: null, totalHourly: null, projectedSessionTotal: null, elapsedSeconds: null, estimatedSpendUsd: null }; }
}
