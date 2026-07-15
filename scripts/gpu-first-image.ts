import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beginFirstImageState, completeFirstImageStage, nextFirstImageStage, readFirstImageState } from "./first-image-state";
import { COMFY_RUNTIME_IMAGE } from "./clore/config";
import { getPrivateKeyPath } from "./clore/ssh-client";
import { getCloreDeploymentHold } from "./clore/deployment-hold";

export type GpuTarget = { provider: "clore" | "manual_ssh"; host: string; port: number; username: string; sshKeyPath: string; gpuProfile: "rtx4090" | "rtx5090" | "bootstrap_image_gpu"; runtimeDigest: string };
const MANUAL_TARGET_PATH = path.join(process.cwd(), ".secrets", "manual-gpu-target.json");
const CLORE_TARGET_PATH = path.join(process.cwd(), ".secrets", "clore-ssh-target.json");

function providerArg() {
  const value = process.argv.find((item) => item.startsWith("--provider="))?.slice("--provider=".length);
  if (value !== "clore" && value !== "manual_ssh") throw new Error("Use --provider=clore or --provider=manual_ssh.");
  return value;
}

export function loadGpuTarget(provider: GpuTarget["provider"]): GpuTarget {
  const source = provider === "manual_ssh" ? MANUAL_TARGET_PATH : CLORE_TARGET_PATH;
  if (!existsSync(source)) throw new Error(`${provider} target is missing from .secrets.`);
  const input = JSON.parse(readFileSync(source, "utf8")) as Partial<GpuTarget> & { user?: string };
  const target: GpuTarget = { provider, host: String(input.host ?? ""), port: Number(input.port), username: String(input.username ?? input.user ?? "root"), sshKeyPath: String(input.sshKeyPath ?? (provider === "clore" ? getPrivateKeyPath() : "")), gpuProfile: input.gpuProfile === "rtx5090" || input.gpuProfile === "bootstrap_image_gpu" ? input.gpuProfile : "rtx4090", runtimeDigest: String(input.runtimeDigest ?? COMFY_RUNTIME_IMAGE) };
  if (!target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !target.sshKeyPath || !target.runtimeDigest.includes("@sha256:")) throw new Error("GpuTarget is incomplete or does not use a fixed Runtime digest.");
  if (!existsSync(target.sshKeyPath)) throw new Error("GpuTarget SSH private key path is unavailable.");
  return target;
}

export function sanitizeGpuTarget(target: GpuTarget) {
  return { provider: target.provider, host_suffix: target.host.split(".").slice(-2).join("."), port: target.port, username: target.username, gpu_profile: target.gpuProfile, runtime_digest_pinned: target.runtimeDigest.includes("@sha256:"), ssh_private_key_returned: false };
}

function ssh(target: GpuTarget, command: string) {
  return spawnSync("ssh", ["-i", target.sshKeyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "PasswordAuthentication=no", "-p", String(target.port), `${target.username}@${target.host}`, command], { encoding: "utf8", timeout: 60_000 });
}

async function main() {
  const provider = providerArg();
  if (provider === "clore" && getCloreDeploymentHold().enabled) throw new Error("CLORE_DEPLOYMENT_HOLD=true: refusing Clore first-image execution.");
  const target = loadGpuTarget(provider);
  const sessionId = process.argv.find((item) => item.startsWith("--session-id="))?.slice("--session-id=".length) ?? `first-image-${Date.now()}`;
  let state = beginFirstImageState(provider, sessionId);
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({ dry_run: true, target: sanitizeGpuTarget(target), next_stage: nextFirstImageStage(state), runtime_pull: target.runtimeDigest, model_restore_order: ["R2 current.json", "revision manifest", "read-only R2 download", "HF fallback only on cache miss"], create_order_called: false }, null, 2));
    return;
  }
  if (nextFirstImageStage(state) === "candidate_selected") state = completeFirstImageStage(state, "candidate_selected", { provider, target: sanitizeGpuTarget(target) });
  if (nextFirstImageStage(state) === "order_created" && provider === "manual_ssh") state = completeFirstImageStage(state, "order_created", { external_provider_payment_or_cancel_not_managed: true });
  if (nextFirstImageStage(state) === "ssh_ready") {
    const result = ssh(target, "true");
    if (result.status !== 0) throw new Error("manual_ssh_connection_failed");
    state = completeFirstImageStage(state, "ssh_ready", { ssh_true: true });
  }
  console.log(JSON.stringify({ resumed: true, provider, next_stage: nextFirstImageStage(state), completed: state.completed, create_order_called: false, manual_adapter_does_not_manage_payment_or_cancel: provider === "manual_ssh" }, null, 2));
}
if (process.argv[1]?.endsWith("gpu-first-image.ts")) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "first image orchestration failed"); process.exitCode = 1; });
}
