import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCloreDeploymentHold } from "./deployment-hold";

export const DEPLOYMENT_RESOLUTION_PATH = path.join(process.cwd(), ".secrets", "clore-deployment-resolution.json");

export type DeploymentResolution = {
  schemaVersion: 1;
  resolved: true;
  historicalPauseReason: "stage4h5_ssh_cleanup";
  rootCause: "reused_proxy_endpoint_and_stale_global_host_key";
  fixingCommits: string[];
  evidence: string[];
  batchId: string;
  resolutionNonce: string;
  operatorDecision: string;
  zeroResourceState: { cloreActiveOrders: 0; runpodPods: 0; runpodVolumes: 0; cloreHold: true; runpodHold: true };
  resolvedAt: string;
};

export function readDeploymentResolution(filePath = DEPLOYMENT_RESOLUTION_PATH): DeploymentResolution | null {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, "utf8")) as DeploymentResolution; } catch { return null; }
}

export function resolutionNonceHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validateDeploymentResolution(value: unknown, expectedBatchId: string, resolutionNonce?: string) {
  const resolution = value as Partial<DeploymentResolution> | null;
  const blockers: string[] = [];
  if (!resolution || resolution.schemaVersion !== 1 || resolution.resolved !== true) blockers.push("deployment_resolution_missing");
  if (resolution?.historicalPauseReason !== "stage4h5_ssh_cleanup") blockers.push("deployment_resolution_reason_mismatch");
  if (resolution?.rootCause !== "reused_proxy_endpoint_and_stale_global_host_key") blockers.push("deployment_resolution_root_cause_mismatch");
  if (resolution?.batchId !== expectedBatchId) blockers.push("deployment_resolution_batch_mismatch");
  if (!resolution?.resolutionNonce || (resolutionNonce && resolution.resolutionNonce !== resolutionNonce)) blockers.push("deployment_resolution_nonce_mismatch");
  if (resolution?.zeroResourceState?.cloreActiveOrders !== 0 || resolution?.zeroResourceState?.runpodPods !== 0 || resolution?.zeroResourceState?.runpodVolumes !== 0 || resolution?.zeroResourceState?.cloreHold !== true || resolution?.zeroResourceState?.runpodHold !== true) blockers.push("deployment_resolution_zero_state_invalid");
  return { valid: blockers.length === 0, blockers, resolution: blockers.length === 0 ? resolution as DeploymentResolution : null };
}

export function assertResolvedBatchRelease(input: { batchId: string; resolutionNonce: string; gpuProfile: "rtx5090" }) {
  const hold = getCloreDeploymentHold();
  if (!hold.enabled) return;
  const result = validateDeploymentResolution(readDeploymentResolution(), input.batchId, input.resolutionNonce);
  if (!result.valid) throw new Error(`CLORE_DEPLOYMENT_HOLD=true:${result.blockers.join(",")}`);
}

export function writeDeploymentResolution(input: { batchId: string; operatorDecision: string; filePath?: string; now?: Date }) {
  const hold = getCloreDeploymentHold();
  if (!hold.enabled || hold.reason !== "stage4h5_ssh_cleanup") throw new Error("deployment_pause_not_obsolete_stage4h5_cleanup");
  const resolution: DeploymentResolution = {
    schemaVersion: 1,
    resolved: true,
    historicalPauseReason: "stage4h5_ssh_cleanup",
    rootCause: "reused_proxy_endpoint_and_stale_global_host_key",
    fixingCommits: ["34262c7", "c7de7fa", "f636f9f", "8886e45"],
    evidence: ["scripts/stage4h6-ssh-readiness-tests.ts", "scripts/stage4h4-adapter-contract-tests.ts", "scripts/stage4h5-resume-tests.ts"],
    batchId: input.batchId,
    resolutionNonce: randomBytes(24).toString("base64url"),
    operatorDecision: input.operatorDecision,
    zeroResourceState: { cloreActiveOrders: 0, runpodPods: 0, runpodVolumes: 0, cloreHold: true, runpodHold: true },
    resolvedAt: (input.now ?? new Date()).toISOString(),
  };
  const filePath = input.filePath ?? DEPLOYMENT_RESOLUTION_PATH;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const part = `${filePath}.${process.pid}.part`;
  writeFileSync(part, `${JSON.stringify(resolution, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(part, filePath);
  return resolution;
}
