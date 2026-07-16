import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readGpuBillingStatus } from "../gpu-billing-status";
import { buildFluxFirstImageWorkflow, validateFluxFirstImageWorkflow } from "../flux-first-image";
import { fluxCacheStatus } from "../model-cache/flux4090-cache";
import { verify as verifyWanCache } from "../model-cache/wan-stage3m-cache";
import { STAGE3O_BATCH_ID, STAGE3O_TASK_IDS } from "../stage3o-batch";
import { buildStage3OWanWorkflow, validateStage3OWanWorkflow } from "../stage3o-wan-executor";
import { readGenerationPool } from "../../src/lib/generation/task-pool";
import { assertNoSecretOutput } from "./client";
import { billingSafetyBlockers } from "./support-acknowledgement";

const SECRET_DIR = path.join(process.cwd(), ".secrets");
export const OPERATOR_RETRY_PATH = path.join(SECRET_DIR, "clore-deployment-operator-retry.json");
export const OPERATOR_RETRY_CONSUMING_PATH = path.join(SECRET_DIR, "clore-deployment-operator-retry.consuming.json");
export const OPERATOR_RETRY_CONSUMED_PATH = path.join(SECRET_DIR, "clore-deployment-operator-retry.consumed.json");

export type OperatorRetryOverride = {
  createdAt: string;
  expiresAt: string;
  limits: {
    maxAttempts: 1 | 2;
    maxFailedSpendUsd: 0.2 | 0.4;
    maxSessionSpendUsd: 2.5;
  };
  nonce: string;
  integritySha256: string;
};

export type OperatorRetryPaths = {
  available: string;
  consuming: string;
  consumed: string;
};

export function operatorRetryPaths(root = SECRET_DIR): OperatorRetryPaths {
  return {
    available: path.join(root, path.basename(OPERATOR_RETRY_PATH)),
    consuming: path.join(root, path.basename(OPERATOR_RETRY_CONSUMING_PATH)),
    consumed: path.join(root, path.basename(OPERATOR_RETRY_CONSUMED_PATH)),
  };
}

function unsignedRecord(value: Omit<OperatorRetryOverride, "integritySha256">) {
  return JSON.stringify({ createdAt: value.createdAt, expiresAt: value.expiresAt, limits: value.limits, nonce: value.nonce });
}

export function operatorRetryIntegrity(value: Omit<OperatorRetryOverride, "integritySha256">) {
  return createHash("sha256").update(unsignedRecord(value), "utf8").digest("hex");
}

export function buildOperatorRetryOverride(now = new Date(), expiresInMinutes = 180, limits: OperatorRetryOverride["limits"] = { maxAttempts: 1, maxFailedSpendUsd: 0.2, maxSessionSpendUsd: 2.5 }): OperatorRetryOverride {
  const unsigned: Omit<OperatorRetryOverride, "integritySha256"> = {
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000).toISOString(),
    limits,
    nonce: randomBytes(24).toString("base64url"),
  };
  return { ...unsigned, integritySha256: operatorRetryIntegrity(unsigned) };
}

export function validateOperatorRetryOverride(value: unknown, now = Date.now()) {
  const record = value as Partial<OperatorRetryOverride> | null;
  const blockers: string[] = [];
  const keys = record && typeof record === "object" ? Object.keys(record).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify(["createdAt", "expiresAt", "integritySha256", "limits", "nonce"])) blockers.push("operator_retry_record_fields_invalid");
  const createdAt = Date.parse(record?.createdAt ?? "");
  const expiresAt = Date.parse(record?.expiresAt ?? "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) blockers.push("operator_retry_timestamps_invalid");
  else {
    if (createdAt > now + 60_000) blockers.push("operator_retry_created_in_future");
    if (expiresAt <= now) blockers.push("operator_retry_expired");
    if (expiresAt - createdAt > 180 * 60_000) blockers.push("operator_retry_expiry_too_long");
  }
  const limits = record?.limits;
  const validLimitPair = (limits?.maxAttempts === 1 && limits.maxFailedSpendUsd === 0.2) || (limits?.maxAttempts === 2 && limits.maxFailedSpendUsd === 0.4);
  if (!limits || JSON.stringify(Object.keys(limits).sort()) !== JSON.stringify(["maxAttempts", "maxFailedSpendUsd", "maxSessionSpendUsd"]) || !validLimitPair || limits.maxSessionSpendUsd !== 2.5) blockers.push("operator_retry_limits_invalid");
  if (!/^[A-Za-z0-9_-]{32}$/.test(record?.nonce ?? "")) blockers.push("operator_retry_nonce_invalid");
  if (!/^[a-f0-9]{64}$/.test(record?.integritySha256 ?? "")) blockers.push("operator_retry_integrity_invalid");
  if (blockers.length === 0) {
    const unsigned = { createdAt: record!.createdAt!, expiresAt: record!.expiresAt!, limits: record!.limits!, nonce: record!.nonce! } as Omit<OperatorRetryOverride, "integritySha256">;
    if (operatorRetryIntegrity(unsigned) !== record!.integritySha256) blockers.push("operator_retry_integrity_mismatch");
  }
  return { valid: blockers.length === 0, blockers, override: blockers.length ? null : record as OperatorRetryOverride };
}

function parseOverride(filePath: string, now: number) {
  try { return validateOperatorRetryOverride(JSON.parse(readFileSync(filePath, "utf8")), now); }
  catch { return { valid: false, blockers: ["operator_retry_record_unreadable"], override: null }; }
}

export function readOperatorRetryOverride(paths = operatorRetryPaths(), now = Date.now()) {
  if (existsSync(paths.consuming)) return { valid: false, blockers: ["operator_retry_already_consuming"], override: null };
  if (!existsSync(paths.available)) {
    return existsSync(paths.consumed)
      ? { valid: false, blockers: ["operator_retry_already_consumed"], override: null }
      : { valid: false, blockers: ["operator_retry_missing"], override: null };
  }
  return parseOverride(paths.available, now);
}

export function readConsumedOperatorRetryOverride(paths = operatorRetryPaths(), now = Date.now()) {
  if (!existsSync(paths.consumed)) return { valid: false, blockers: ["operator_retry_consumed_record_missing"], override: null };
  return parseOverride(paths.consumed, now);
}

export function writeOperatorRetryOverride(value: OperatorRetryOverride, paths = operatorRetryPaths()) {
  const validated = validateOperatorRetryOverride(value);
  if (!validated.valid) throw new Error(validated.blockers.join(","));
  if (existsSync(paths.available) || existsSync(paths.consuming)) throw new Error("operator_retry_already_available_or_consuming");
  mkdirSync(path.dirname(paths.available), { recursive: true });
  rmSync(paths.consumed, { force: true });
  const partial = `${paths.available}.${process.pid}.part`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(partial, paths.available);
  return value;
}

export function consumeOperatorRetryOverride(paths = operatorRetryPaths(), now = Date.now()) {
  const current = readOperatorRetryOverride(paths, now);
  if (!current.valid || !current.override) throw new Error(current.blockers.join(","));
  renameSync(paths.available, paths.consuming);
  return current.override;
}

export function markOperatorRetryConsumed(paths = operatorRetryPaths()) {
  if (existsSync(paths.consumed) && !existsSync(paths.consuming)) return;
  if (existsSync(paths.consumed)) throw new Error("operator_retry_consumed_destination_exists");
  if (!existsSync(paths.consuming)) {
    throw new Error("operator_retry_not_consuming");
  }
  renameSync(paths.consuming, paths.consumed);
}

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export async function validateOperatorRetryPrerequisites() {
  const billing = await readGpuBillingStatus();
  const blockers = billingSafetyBlockers(billing);
  if (blockers.length) throw new Error(blockers.join(";"));
  const pool = readGenerationPool();
  const armed = STAGE3O_TASK_IDS.map((id) => pool.tasks.find((task) => task.id === id));
  if (pool.scheduler.selectedBatchId !== STAGE3O_BATCH_ID || pool.scheduler.selectedTaskIds.length !== 2 || armed.some((task) => !task || task.status !== "armed" || task.batchId !== STAGE3O_BATCH_ID)) throw new Error("stage3o_armed_batch_missing");
  const flux = await fluxCacheStatus();
  if (!flux.ready || flux.total_size_bytes !== 12_451_817_860) throw new Error("flux_cache_not_ready");
  const wan = await verifyWanCache();
  if (!wan.wan_cache_ready || wan.total_size_bytes !== 18_144_966_705) throw new Error("wan_cache_not_ready");
  const fluxErrors = validateFluxFirstImageWorkflow(buildFluxFirstImageWorkflow({ width: 1024, height: 1024, steps: 4, seed: 20260715 }));
  if (fluxErrors.length) throw new Error(`flux_workflow_not_ready:${fluxErrors.join(",")}`);
  validateStage3OWanWorkflow(buildStage3OWanWorkflow());
  return { billing, pool, flux, wan };
}

async function main() {
  if (!process.argv.includes("--accept-platform-risk")) throw new Error("missing_exact_flag:--accept-platform-risk");
  const maxAttempts = argument("max-attempts"); const maxFailedSpend = argument("max-failed-spend");
  const stage3p = maxAttempts === "1" && maxFailedSpend === "0.20"; const stage3r = maxAttempts === "2" && maxFailedSpend === "0.40";
  if (!stage3p && !stage3r) throw new Error("accepted limit pairs are exactly 1/0.20 or 2/0.40");
  if (argument("max-session-spend") !== "2.50") throw new Error("--max-session-spend must be exactly 2.50");
  if (argument("expires-in-minutes") !== "180") throw new Error("--expires-in-minutes must be exactly 180");
  await validateOperatorRetryPrerequisites();
  const override = writeOperatorRetryOverride(buildOperatorRetryOverride(new Date(), 180, { maxAttempts: stage3r ? 2 : 1, maxFailedSpendUsd: stage3r ? 0.4 : 0.2, maxSessionSpendUsd: 2.5 }));
  const output = JSON.stringify({ created: true, expiresAt: override.expiresAt, limits: override.limits, supportRecoveryConfirmed: false, oneUse: true }, null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

if (process.argv[1]?.endsWith("operator-retry-override.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "operator_retry_creation_failed"); process.exitCode = 1; });
