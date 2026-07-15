import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RunPodHoldState = { enabled: boolean; reason: string; updated_at: string };

function holdPath() {
  return path.join(process.cwd(), ".secrets", "runpod-deployment-hold.json");
}

export function getRunPodDeploymentHold(): RunPodHoldState {
  if (process.env.RUNPOD_DEPLOYMENT_HOLD === "true") return { enabled: true, reason: "environment", updated_at: "environment" };
  const filePath = holdPath();
  if (!existsSync(filePath)) return { enabled: false, reason: "not_set", updated_at: "" };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<RunPodHoldState>;
    return { enabled: parsed.enabled === true, reason: parsed.reason ?? "local_state", updated_at: parsed.updated_at ?? "" };
  } catch {
    return { enabled: true, reason: "invalid_hold_state_fail_closed", updated_at: "" };
  }
}

export function assertRunPodDeploymentAllowed() {
  if (getRunPodDeploymentHold().enabled) throw new Error("RUNPOD_DEPLOYMENT_HOLD=true: RunPod automatic execution is disabled.");
}

export function setRunPodDeploymentHold(enabled: boolean, reason = "stage3m_clore_only_automatic_provider") {
  const filePath = holdPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const state: RunPodHoldState = { enabled, reason, updated_at: new Date().toISOString() };
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

if (process.argv[1]?.endsWith("runpod-deployment-hold.ts")) {
  const enabled = process.argv.includes("--enable");
  const disabled = process.argv.includes("--disable");
  if (enabled === disabled) throw new Error("Use exactly one of --enable or --disable.");
  console.log(JSON.stringify(setRunPodDeploymentHold(enabled), null, 2));
}
