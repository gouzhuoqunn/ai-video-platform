import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function holdPath() {
  return path.join(process.cwd(), ".secrets", "clore-deployment-hold.json");
}

type HoldState = { enabled: boolean; reason: string; updated_at: string };

export function getCloreDeploymentHold(): HoldState {
  if (process.env.CLORE_DEPLOYMENT_HOLD === "true") {
    return { enabled: true, reason: "environment", updated_at: "environment" };
  }
  const statePath = holdPath();
  if (!existsSync(statePath)) return { enabled: false, reason: "not_set", updated_at: "" };
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<HoldState>;
    return { enabled: parsed.enabled === true, reason: parsed.reason ?? "local_state", updated_at: parsed.updated_at ?? "" };
  } catch {
    return { enabled: true, reason: "invalid_hold_state_fail_closed", updated_at: "" };
  }
}

export function assertCloreDeploymentAllowed() {
  const hold = getCloreDeploymentHold();
  if (hold.enabled) throw new Error("CLORE_DEPLOYMENT_HOLD=true: Clore deployment is paused pending platform investigation.");
}

export function setCloreDeploymentHold(enabled: boolean, reason = "platform_deployment_incident") {
  const statePath = holdPath();
  mkdirSync(path.dirname(statePath), { recursive: true });
  const state: HoldState = { enabled, reason, updated_at: new Date().toISOString() };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

if (process.argv[1]?.endsWith("deployment-hold.ts")) {
  const enabled = process.argv.includes("--enable");
  const disabled = process.argv.includes("--disable");
  if (enabled === disabled) throw new Error("Use exactly one of --enable or --disable.");
  const reasonArg = process.argv.find((value) => value.startsWith("--reason="))?.slice("--reason=".length);
  console.log(JSON.stringify(setCloreDeploymentHold(enabled, reasonArg || "platform_deployment_incident"), null, 2));
}
