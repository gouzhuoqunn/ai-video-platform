import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { beginFirstImageState, completeFirstImageStage, nextFirstImageStage } from "./first-image-state";
import { FIXED_RUNTIME_DIGEST, sanitizeGpuTarget, scpFile, sleep, sshCommand } from "./gpu-providers/common";
import { getGpuProvider, parseProviderArg, type GpuProviderId } from "./gpu-providers";
import { buildRunPodDirectPodPayload, buildRunPodDirectTemplatePayload, loadRunPodConfig, RUNPOD_DIRECT_LAUNCH_MODE } from "./gpu-providers/runpod";
import { writeColabBundle } from "./first-image-colab-bundle";
import type { GpuSession, GpuTarget } from "./gpu-providers/types";
import { armRunPodWatchdog } from "./runpod-watchdog";

function argument(name: string) {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function dryRunPublicKey() {
  return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFN0YWdlM0pEcnlSdW5Pbmx5S2V5 stage3j-dry-run";
}

function readPublicKey(filePath: string) {
  if (!existsSync(filePath)) throw new Error("RunPod SSH public key is missing.");
  const value = readFileSync(filePath, "utf8").split(/\r?\n/)[0].trim();
  if (!value || /PRIVATE KEY/.test(value)) throw new Error("RunPod requires an SSH public key, not a private key.");
  return value;
}

export async function buildProviderDryRun(providerId: GpuProviderId) {
  const provider = getGpuProvider(providerId);
  const credentials = await provider.inspectCredentials();
  const candidates = await provider.listCandidates();
  const candidate = candidates[0];
  const directTemplate = providerId === "runpod" ? buildRunPodDirectTemplatePayload({ sshPublicKey: dryRunPublicKey() }) : null;
  const runpodPayload = providerId === "runpod" && candidate
    ? buildRunPodDirectPodPayload({ sessionId: "dry-run", candidate, sshPublicKey: dryRunPublicKey(), bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: true }, "dry-run-template")
    : null;
  return {
    dry_run: true,
    provider: providerId,
    credentials,
    candidates,
    create_session_called: false,
    launch_mode: providerId === "runpod" ? RUNPOD_DIRECT_LAUNCH_MODE : "external",
    direct_template: directTemplate,
    payload: runpodPayload,
    model_restore_order: ["R2 current.json", "revision manifest", "read-only presigned downloads", "HF fallback once after R2 failure"],
  };
}

async function availableLoopbackPort(start = 18188) {
  for (let port = start; port < start + 32; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("local_ssh_tunnel_port_unavailable");
}

function requireSuccess(result: ReturnType<typeof spawnSync>, classification: string) {
  if (result.status !== 0) throw new Error(classification);
  return String(result.stdout ?? "");
}

async function runRemoteFirstImage(target: GpuTarget, providerId: GpuProviderId, sessionId: string, gpuModel: string) {
  const { outputPath: bundlePath } = writeColabBundle();
  const restorePath = path.join(process.cwd(), "scripts", "clore", "restore-flux-r2.py");
  try {
    requireSuccess(scpFile(target, bundlePath, "/workspace/flux-r2-manifest.json", 5 * 60_000), "r2_bundle_copy_failed");
    requireSuccess(scpFile(target, restorePath, "/workspace/restore-flux-r2.py", 2 * 60_000), "r2_restore_script_copy_failed");
    const restoreStarted = Date.now();
    const restore = sshCommand(target, "set -e; FLUX_R2_RESTORE_MANIFEST=/workspace/flux-r2-manifest.json python3.11 /workspace/restore-flux-r2.py", 90 * 60_000);
    requireSuccess(restore, "r2_model_restore_failed");
    const restoreElapsedMs = Date.now() - restoreStarted;
    const runtime = sshCommand(target, `set -e; mkdir -p /workspace/logs; if test -s /workspace/runtime-stage3j.pid && kill -0 \"$(cat /workspace/runtime-stage3j.pid)\" 2>/dev/null; then exit 0; fi; nohup env COMFY_RUNTIME_MODE=gpu COMFY_NODE_PROFILE=production_minimal COMFY_GPU_PROFILE=${target.gpuProfile} /opt/comfy-runtime/entrypoint.sh >/workspace/logs/runtime-stage3j.log 2>&1 </dev/null & echo $! >/workspace/runtime-stage3j.pid`, 60_000);
    requireSuccess(runtime, "runtime_start_failure");
    const healthDeadline = Date.now() + 5 * 60_000;
    while (Date.now() < healthDeadline) {
      if (sshCommand(target, "curl -fsS --max-time 5 http://127.0.0.1:8080/health >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:8188/system_stats >/dev/null", 20_000).status === 0) break;
      await sleep(5_000);
    }
    if (sshCommand(target, "curl -fsS --max-time 5 http://127.0.0.1:8080/health >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:8188/system_stats >/dev/null", 20_000).status !== 0) throw new Error("runtime_health_timeout");
    const port = await availableLoopbackPort();
    const tunnel = spawn("ssh", ["-N", "-i", target.sshKeyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "PasswordAuthentication=no", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-p", String(target.port), "-L", `127.0.0.1:${port}:127.0.0.1:8188`, `${target.username}@${target.host}`], { stdio: "ignore" });
    try {
      await sleep(1500);
      if (tunnel.exitCode !== null) throw new Error("ssh_tunnel_failed");
      const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      const generated = spawnSync(process.execPath, [tsxCli, "scripts/flux-first-image-executor.ts", `--base-url=http://127.0.0.1:${port}`, `--session-id=${sessionId}`, `--provider=${providerId}`, `--gpu-model=${gpuModel}`, `--restore-elapsed-ms=${restoreElapsedMs}`], { cwd: process.cwd(), encoding: "utf8", timeout: 40 * 60_000 });
      const output = requireSuccess(generated, "flux_first_image_generation_failed");
      return { restoreElapsedMs, generated: JSON.parse(output) as Record<string, unknown> };
    } finally {
      tunnel.kill();
    }
  } finally {
    rmSync(bundlePath, { force: true });
  }
}

async function main() {
  const providerId = parseProviderArg();
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify(await buildProviderDryRun(providerId), null, 2));
    return;
  }

  const provider = getGpuProvider(providerId);
  const sessionId = argument("session-id") ?? `first-image-${Date.now()}`;
  const runpodConfig = providerId === "runpod" ? loadRunPodConfig() : null;
  const watchdog = runpodConfig ? armRunPodWatchdog(sessionId, runpodConfig.maxSessionUsd) : null;
  const heartbeat = watchdog ? setInterval(() => watchdog.heartbeat(), 60_000) : null;
  let session: GpuSession | null = null;
  try {
  let state = beginFirstImageState(providerId, sessionId);
  const candidates = await provider.listCandidates();
  session = await provider.recoverExistingSession(sessionId);
  if (nextFirstImageStage(state) === "candidate_selected") {
    state = completeFirstImageStage(state, "candidate_selected", { provider: providerId, candidate: candidates[0]?.id ?? "external" });
  }
  if (nextFirstImageStage(state) === "order_created") {
    if (!session && providerId === "runpod") {
      const config = runpodConfig ?? loadRunPodConfig();
      const candidate = candidates[0];
      if (!candidate) throw new Error("No RunPod candidate profile is available.");
      session = await provider.createSession({ sessionId, candidate, sshPublicKey: readPublicKey(config.sshPublicKeyPath), bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false });
    } else if (!session) {
      session = await provider.getSession(providerId);
    }
    if (!session) throw new Error(`${providerId}_session_unavailable`);
    watchdog?.recordPod(session.id, session.hourlyUsd);
    state = completeFirstImageStage(state, "order_created", { provider_session_id: session.id, lifecycle_managed: providerId === "runpod" });
  }
  session ??= await provider.recoverExistingSession(sessionId);
  if (!session) throw new Error(`${providerId}_session_recovery_failed`);
  let target = session.target;
  try {
    if (nextFirstImageStage(state) === "ssh_ready") {
      target = await provider.waitForSsh(session);
      state = completeFirstImageStage(state, "ssh_ready", { target: sanitizeGpuTarget(target), ssh_true: true });
    }
    target ??= await provider.waitForSsh(session, 60_000);
    let gpuModel = "unknown";
    if (nextFirstImageStage(state) === "hardware_verified") {
      const hardware = sshCommand(target, "set -e; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader; free -b; df -B1 /workspace; python3.11 -c 'import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"no-cuda\")'", 120_000);
      if (hardware.status !== 0) throw new Error("gpu_hardware_verification_failed");
      gpuModel = String(hardware.stdout).split(/\r?\n/)[0]?.split(",")[0]?.trim() || "unknown";
      state = completeFirstImageStage(state, "hardware_verified", { verified: true, gpu_model: gpuModel, output_sha256_recorded_separately: true });
    }
    if (["runtime_ready", "models_restored"].includes(String(nextFirstImageStage(state)))) {
      const result = await runRemoteFirstImage(target, providerId, sessionId, gpuModel);
      if (nextFirstImageStage(state) === "runtime_ready") state = completeFirstImageStage(state, "runtime_ready", { controller_and_comfy_health_verified: true });
      if (nextFirstImageStage(state) === "models_restored") state = completeFirstImageStage(state, "models_restored", { source: "r2_presigned_get", elapsed_ms: result.restoreElapsedMs, size_and_sha_verified: true });
      state = completeFirstImageStage(state, "prompt_submitted", { submitted_by_existing_executor: true });
      state = completeFirstImageStage(state, "image_generated", { result: result.generated });
      state = completeFirstImageStage(state, "result_synced", { local_archive: true, provider_session_json: true });
    }
    if (nextFirstImageStage(state) === "session_stopped") {
      sshCommand(target, "if test -s /workspace/runtime-stage3j.pid; then kill -TERM \"$(cat /workspace/runtime-stage3j.pid)\" 2>/dev/null || true; fi; rm -f /workspace/flux-r2-manifest.json", 60_000);
      await provider.stopSession(session);
      state = completeFirstImageStage(state, "session_stopped", { runtime_stopped: true });
    }
    if (nextFirstImageStage(state) === "order_cancelled") {
      await provider.terminateSession(session);
      watchdog?.disarm();
      state = completeFirstImageStage(state, "order_cancelled", { provider_session_terminated: providerId === "runpod", external_lifecycle_untouched: providerId !== "runpod" });
    }
    console.log(JSON.stringify({ resumed: true, provider: providerId, session_id: session.id, next_stage: nextFirstImageStage(state), completed: state.completed, target: sanitizeGpuTarget(target) }, null, 2));
  } catch (error) {
    if (target) sshCommand(target, "if test -s /workspace/runtime-stage3j.pid; then kill -TERM \"$(cat /workspace/runtime-stage3j.pid)\" 2>/dev/null || true; fi; rm -f /workspace/flux-r2-manifest.json", 60_000);
    if (providerId === "runpod") {
      try { await provider.terminateSession(session); watchdog?.disarm(); } catch { /* Keep Watchdog armed when termination is not confirmed. */ }
    }
    throw error;
  }
  } catch (error) {
    if (!session) watchdog?.disarm();
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

if (process.argv[1]?.endsWith("gpu-first-image.ts")) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "first image orchestration failed"); process.exitCode = 1; });
}
