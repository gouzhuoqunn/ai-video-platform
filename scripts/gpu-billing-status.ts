import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertNoSecretOutput } from "./clore/client";
import { loadCloreConfig } from "./clore/config";
import { getCloreDeploymentHold } from "./clore/deployment-hold";
import { readLiveOrdersSummary } from "./clore/live";
import { getRunPodDeploymentHold } from "./runpod-deployment-hold";
import { loadRunPodConfig, RUNPOD_API_BASE, RunPodRestClient } from "./gpu-providers/runpod";

export function watchdogSummary() {
  const armPath = path.join(process.cwd(), ".secrets", "clore-watchdog-arm.json");
  let remoteArmed = false;
  try { remoteArmed = existsSync(armPath) && JSON.parse(readFileSync(armPath, "utf8")).armed === true; } catch { remoteArmed = true; }
  if (process.platform !== "win32") return { remoteArmed, scheduledTaskActive: false, processCount: 0, deploymentWatcherProcessCount: 0 };
  const script = "$task=Get-ScheduledTask -TaskName 'AiVideoPlatformCloreWatchdog' -ErrorAction SilentlyContinue; $all=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|wscript|cscript)\\.exe$' -and $_.CommandLine -like '*ai-video-platform*' }); $count=@($all | Where-Object { $_.CommandLine -match 'clore.*watchdog|watchdog.*clore' }).Count; $deployment=@($all | Where-Object { $_.CommandLine -match 'deployment-watch' }).Count; [pscustomobject]@{taskActive=($null -ne $task -and [string]$task.State -ne 'Disabled');processCount=$count;deploymentWatcherProcessCount=$deployment}|ConvertTo-Json -Compress";
  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 15_000 })) as { taskActive?: boolean; processCount?: number; deploymentWatcherProcessCount?: number };
    return { remoteArmed, scheduledTaskActive: parsed.taskActive === true, processCount: Number(parsed.processCount ?? 0), deploymentWatcherProcessCount: Number(parsed.deploymentWatcherProcessCount ?? 0) };
  } catch { return { remoteArmed, scheduledTaskActive: true, processCount: -1, deploymentWatcherProcessCount: -1 }; }
}

export async function readGpuBillingStatus() {
  const cloreConfig = loadCloreConfig();
  const cloreOrders = cloreConfig.apiKey ? await readLiveOrdersSummary(cloreConfig, { forceRefresh: true }) : [];
  const runpodConfig = loadRunPodConfig();
  let runpodPods: unknown[] = [];
  let runpodVolumes: unknown[] = [];
  if (runpodConfig.apiKey) {
    runpodPods = await new RunPodRestClient(runpodConfig).listPods();
    const response = await fetch(`${RUNPOD_API_BASE}/networkvolumes`, { headers: { Authorization: `Bearer ${runpodConfig.apiKey}` } });
    if (!response.ok) throw new Error(`runpod_network_volumes_http_${response.status}`);
    const payload = await response.json() as unknown[] | { items?: unknown[]; data?: unknown[] };
    runpodVolumes = Array.isArray(payload) ? payload : payload.items ?? payload.data ?? [];
  }
  return {
    mode: "read_only_billing_status",
    clore: { credentialsPresent: Boolean(cloreConfig.apiKey), activeOrders: cloreOrders.filter((order) => order.active).length, totalReturnedOrders: cloreOrders.length },
    runpod: { credentialsPresent: Boolean(runpodConfig.apiKey), activePods: runpodPods.length, networkVolumes: runpodVolumes.length },
    watchdogs: watchdogSummary(),
    holds: { clore: getCloreDeploymentHold().enabled, runpod: getRunPodDeploymentHold().enabled },
    createLockPresent: existsSync(path.join(process.cwd(), ".secrets", "clore-order-create.lock")) || existsSync(path.join(process.cwd(), ".secrets", "clore-create.lock")) || existsSync(path.join(process.cwd(), ".secrets", "runpod-create.lock")),
    mutatingCallsMade: false,
    secretsPrinted: false,
  };
}

async function main() {
  const output = await readGpuBillingStatus();
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

if (process.argv[1]?.endsWith("gpu-billing-status.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "billing status failed"); process.exitCode = 1; });
