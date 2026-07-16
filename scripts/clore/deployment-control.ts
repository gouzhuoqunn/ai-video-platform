import { existsSync } from "node:fs";
import path from "node:path";
import { generationPoolSummary, readGenerationPool, writeGenerationPool } from "../../src/lib/generation/task-pool";
import { modelAvailabilityGate } from "../../src/lib/generation/model-availability";
import { assertNoSecretOutput } from "./client";
import { loadCloreConfig } from "./config";
import { getCloreDeploymentHold, setCloreDeploymentHold } from "./deployment-hold";
import { readLiveOrdersSummary } from "./live";
import { readSupportAcknowledgement } from "./support-acknowledgement";

const LOCK_PATHS = ["clore-order-create.lock", "clore-create.lock"].map((name) => path.join(process.cwd(), ".secrets", name));

function acknowledged() {
  return readSupportAcknowledgement().valid;
}

function localConditions() {
  const state = readGenerationPool();
  const selected = state.scheduler.selectedTaskIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean);
  const modelGates = selected.map((task) => ({ modelProfile: task!.modelProfile, ...modelAvailabilityGate(task!.modelProfile) }));
  return { state, selected, modelGates, createLockPresent: LOCK_PATHS.some(existsSync), supportIncidentAcknowledged: acknowledged() };
}

async function resume() {
  const confirmed = process.argv.includes("--confirm-platform-recovered");
  const local = localConditions();
  if (!confirmed) return { mode: "read_only", hold: getCloreDeploymentHold(), confirmationAccepted: false, activeOrderCheck: "not_called_without_exact_flag", armedBatchExists: local.selected.length > 0, modelCacheReady: local.modelGates.length > 0 && local.modelGates.every((gate) => gate.allowed && gate.model?.restoreReady), createLockPresent: local.createLockPresent, supportIncidentAcknowledged: local.supportIncidentAcknowledged, holdChanged: false };
  const orders = await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true });
  const blockers: string[] = [];
  if (orders.some((order) => order.active)) blockers.push("仍有活跃 Clore 订单");
  if (local.createLockPresent) blockers.push("存在创建锁");
  if (local.selected.length === 0) blockers.push("没有已锁定批次");
  if (!local.modelGates.length || local.modelGates.some((gate) => !gate.allowed || !gate.model?.restoreReady)) blockers.push("所选批次模型缓存尚未通过 current.json 恢复门禁");
  if (!local.supportIncidentAcknowledged) blockers.push("尚未手工记录 Clore 支持事件确认");
  if (blockers.length) return { mode: "confirmed_but_blocked", confirmationAccepted: true, blockers, hold: getCloreDeploymentHold(), holdChanged: false };
  return { mode: "resumed", confirmationAccepted: true, blockers: [], hold: setCloreDeploymentHold(false, "platform_recovery_confirmed_with_armed_batch"), holdChanged: true };
}

function pause() {
  const state = readGenerationPool();
  const active = ["order_pending", "session_active", "draining"].includes(state.scheduler.state) || state.tasks.some((task) => ["deploying", "restoring_models", "generating", "syncing"].includes(task.status));
  if (active) {
    state.scheduler.state = "draining";
    state.scheduler.drainingRequested = true;
    writeGenerationPool(state);
  }
  return { mode: "paused", hold: setCloreDeploymentHold(true, "operator_pause"), sessionMarkedDraining: active, activeSessionCancelled: false, safetyBudgetStillAuthoritative: true, pool: generationPoolSummary(readGenerationPool()) };
}

async function main() {
  const action = process.argv[2];
  const output = action === "resume" ? await resume() : action === "pause" ? pause() : (() => { throw new Error("Use resume or pause."); })();
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "deployment control failed"); process.exitCode = 1; });
