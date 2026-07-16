import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { buildRuntimeOverlay } from "./runtime-overlay";
import { getCloreDeploymentHold, setCloreDeploymentHold } from "./clore/deployment-hold";
import { classifyHostProbeFailure, HOST_TOOLCHAIN_PACKAGES, hostProbeCorrectionCommand, parseTritonProbeOutput, stage3UHostCompilerProbes } from "./clore/host-compiler-probes";
import { archiveFluxFirstImage, buildFluxFirstImageWorkflow } from "./flux-first-image";
import { validatePngPixels } from "./flux-first-image-executor";
import { downloadRemoteRunnerOutput, installRemoteComfyRunner, runRemoteComfyProbe, runRemoteComfyWorkflow, websocketCapabilityEvidence } from "./comfy-remote-runner";

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

export async function buildProviderDryRun(providerId: GpuProviderId, requestedGpuType?: string, requestedCloudType?: string) {
  const provider = getGpuProvider(providerId);
  const credentials = await provider.inspectCredentials();
  const allCandidates = await provider.listCandidates();
  const candidates = allCandidates.filter((candidate) => (!requestedGpuType || candidate.id === requestedGpuType) && (!requestedCloudType || candidate.cloudType === requestedCloudType));
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
  if (result.status !== 0) throw new Error(`${classification}:${String(result.stderr ?? result.stdout ?? "").trim().slice(-1000)}`);
  return String(result.stdout ?? "");
}

const STAGE3T_COMMAND_EVIDENCE_PATH = path.join(process.cwd(), ".secrets", "stage3t-command-evidence.json");
type CommandEvidence = { label: string; command: string; startedAt: string; completedAt: string; exitCode: number | null; stdout: string; stderr: string };

function sanitizeEvidenceText(value: unknown) {
  return String(value ?? "")
    .replace(/(https:\/\/[^\s?]+)\?[^\s]+/g, "$1?<redacted-query>")
    .replace(/(authorization|bearer|token|secret|password)\s*[:=]\s*[^\s]+/gi, "$1=<redacted>");
}

function writeCommandEvidence(records: CommandEvidence[]) {
  mkdirSync(path.dirname(STAGE3T_COMMAND_EVIDENCE_PATH), { recursive: true });
  const partial = `${STAGE3T_COMMAND_EVIDENCE_PATH}.${process.pid}.part`;
  writeFileSync(partial, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(partial, STAGE3T_COMMAND_EVIDENCE_PATH);
}

function recordedCommand(records: CommandEvidence[], label: string, command: string, execute: () => ReturnType<typeof spawnSync>) {
  const startedAt = new Date().toISOString(); const result = execute();
  records.push({ label, command, startedAt, completedAt: new Date().toISOString(), exitCode: result.status, stdout: sanitizeEvidenceText(result.stdout), stderr: sanitizeEvidenceText(result.stderr) });
  writeCommandEvidence(records);
  return result;
}

function recordEvidence(records: CommandEvidence[], label: string, command: string, exitCode: number, stdout: string, stderr = "") {
  const now = new Date().toISOString();
  records.push({ label, command, startedAt: now, completedAt: now, exitCode, stdout, stderr });
  writeCommandEvidence(records);
}

export function runStage3UHostCompilerProbes(target: GpuTarget, records: CommandEvidence[], execute = sshCommand) {
  const mode = recordedCommand(records, "bootstrap_mode", "cat /workspace/ai-runtime/bootstrap-mode", () => execute(target, "cat /workspace/ai-runtime/bootstrap-mode", 30_000));
  requireSuccess(mode, "bootstrap_mode_missing");
  if (String(mode.stdout).trim() !== "native") {
    recordEvidence(records, "host_compiler_probes", "native host compiler probes", 0, "skipped_for_fixed_docker_runtime=true");
    return [];
  }
  const results: Array<{ label: string; corrected: boolean; classification: string | null; stdout: string }> = [];
  for (const probe of stage3UHostCompilerProbes()) {
    let result = recordedCommand(records, probe.label, probe.command, () => execute(target, probe.command, probe.label === "triton_vector_add" ? 5 * 60_000 : 120_000));
    let corrected = false;
    let classification: string | null = null;
    if (result.status !== 0) {
      const output = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
      const failure = classifyHostProbeFailure(probe.label, output);
      classification = failure.classification;
      recordEvidence(records, `${probe.label}_classification`, `classify ${probe.label}`, 0, JSON.stringify(failure));
      const correction = hostProbeCorrectionCommand(failure);
      if (!correction) throw new Error(`host_probe_failed_without_package_correction:${probe.label}:${failure.classification}`);
      requireSuccess(recordedCommand(records, `${probe.label}_in_place_correction`, correction, () => execute(target, correction, 20 * 60_000)), `host_probe_correction_failed:${probe.label}:${failure.classification}`);
      result = recordedCommand(records, `${probe.label}_retry`, probe.command, () => execute(target, probe.command, probe.label === "triton_vector_add" ? 5 * 60_000 : 120_000));
      corrected = true;
    }
    requireSuccess(result, `host_probe_failed:${probe.label}:${classification ?? "unclassified"}`);
    const stdout = String(result.stdout ?? "");
    if (probe.label === "triton_vector_add" && !parseTritonProbeOutput(stdout).valid) throw new Error("triton_probe_output_invalid");
    results.push({ label: probe.label, corrected, classification, stdout });
  }
  return results;
}

async function waitForRuntimeHealth(target: GpuTarget, records: CommandEvidence[], labelPrefix: string, healthCommand: string, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = recordedCommand(records, `${labelPrefix}_poll`, healthCommand, () => sshCommand(target, healthCommand, 20_000));
    if (result.status === 0) return result;
    await sleep(5_000);
  }
  return recordedCommand(records, `${labelPrefix}_final`, healthCommand, () => sshCommand(target, healthCommand, 20_000));
}

async function verifyRuntimeWebSocket(baseUrl: string, clientId: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws?clientId=${encodeURIComponent(clientId)}`);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("runtime_websocket_timeout")); }, 15_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); socket.close(); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("runtime_websocket_failed")); }, { once: true });
  });
}

async function verifyRuntimeTunnel(baseUrl: string, clientId: string) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`runtime_tunnel_http_${response.status}`);
      await verifyRuntimeWebSocket(baseUrl, clientId);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(2_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("runtime_tunnel_verification_failed");
}

async function probeOptionalRuntimeTunnel(target: GpuTarget, clientId: string) {
  const port = await availableLoopbackPort();
  const tunnel = spawn("ssh", ["-N", "-i", target.sshKeyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "PasswordAuthentication=no", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-p", String(target.port), "-L", `127.0.0.1:${port}:127.0.0.1:8188`, `${target.username}@${target.host}`], { stdio: "ignore" });
  try {
    await sleep(1500);
    if (tunnel.exitCode !== null) return { attempted: true, connected: false, error: "ssh_tunnel_exited", port };
    try {
      const verified = await verifyRuntimeTunnel(`http://127.0.0.1:${port}`, clientId);
      return { attempted: true, connected: true, attempts: verified.attempts, port };
    } catch (error) {
      return { attempted: true, connected: false, error: error instanceof Error ? error.message : "tunnel_probe_failed", port };
    }
  } finally {
    tunnel.kill();
  }
}

export async function runRemoteFirstImage(target: GpuTarget, providerId: GpuProviderId, sessionId: string, gpuModel: string, options: { warmRun?: boolean } = {}) {
  void options;
  const { outputPath: bundlePath } = writeColabBundle();
  const restorePath = path.join(process.cwd(), "scripts", "clore", "restore-flux-r2.py");
  const cloreBootstrapPath = path.join(process.cwd(), "scripts", "clore", "clore-light-bootstrap.sh");
  const evidence: CommandEvidence[] = []; writeCommandEvidence(evidence);
  try {
    if (providerId === "clore") {
      const overlay = buildRuntimeOverlay();
      requireSuccess(recordedCommand(evidence, "runtime_overlay_copy", "scp runtime-overlay.tgz /workspace/runtime-overlay.tgz", () => scpFile(target, overlay.outputPath, "/workspace/runtime-overlay.tgz", 5 * 60_000)), "runtime_overlay_copy_failed");
      requireSuccess(recordedCommand(evidence, "bootstrap_script_copy", "scp clore-light-bootstrap.sh /workspace/clore-light-bootstrap.sh", () => scpFile(target, cloreBootstrapPath, "/workspace/clore-light-bootstrap.sh", 2 * 60_000)), "clore_light_bootstrap_copy_failed");
      const prepareCommand = "sed -i 's/\\r$//' /workspace/clore-light-bootstrap.sh; chmod 700 /workspace/clore-light-bootstrap.sh; /workspace/clore-light-bootstrap.sh prepare /workspace/runtime-overlay.tgz";
      let prepare = recordedCommand(evidence, "runtime_prepare", prepareCommand, () => sshCommand(target, prepareCommand, 40 * 60_000));
      if (prepare.status !== 0) {
        const fixCommand = "set -e; sed -i 's/\\r$//' /workspace/clore-light-bootstrap.sh; rm -rf /workspace/ai-runtime/venv; /workspace/clore-light-bootstrap.sh prepare /workspace/runtime-overlay.tgz";
        prepare = recordedCommand(evidence, "runtime_prepare_in_place_fix", fixCommand, () => sshCommand(target, fixCommand, 45 * 60_000));
      }
      requireSuccess(prepare, "clore_light_bootstrap_prepare_failed");
      runStage3UHostCompilerProbes(target, evidence);
    }
    const runtimeCommand = providerId === "clore"
      ? `/workspace/clore-light-bootstrap.sh start ${target.gpuProfile}`
      : `set -e; mkdir -p /workspace/logs; if test -s /workspace/runtime-stage3j.pid && kill -0 \"$(cat /workspace/runtime-stage3j.pid)\" 2>/dev/null; then exit 0; fi; nohup env COMFY_RUNTIME_MODE=gpu COMFY_NODE_PROFILE=production_minimal COMFY_GPU_PROFILE=${target.gpuProfile} /opt/comfy-runtime/entrypoint.sh >/workspace/logs/runtime-stage3j.log 2>&1 </dev/null & echo $! >/workspace/runtime-stage3j.pid`;
    requireSuccess(recordedCommand(evidence, "runtime_start", runtimeCommand, () => sshCommand(target, runtimeCommand, 60_000)), "runtime_start_failure");
    if (providerId === "clore") {
      const cudaCommand = "set -e; mode=$(cat /workspace/ai-runtime/bootstrap-mode); if [ \"$mode\" = docker ]; then docker exec stage3m-comfy-runtime python3 -c 'import torch; print(\"torch_version=\"+torch.__version__); print(\"torch_cuda_version=\"+str(torch.version.cuda)); print(\"cuda_available=\"+str(torch.cuda.is_available()).lower()); print(\"cuda_device=\"+torch.cuda.get_device_name(0)); assert torch.cuda.is_available()'; else /workspace/ai-runtime/venv/bin/python -c 'import torch; print(\"torch_version=\"+torch.__version__); print(\"torch_cuda_version=\"+str(torch.version.cuda)); print(\"cuda_available=\"+str(torch.cuda.is_available()).lower()); print(\"cuda_device=\"+torch.cuda.get_device_name(0)); assert torch.cuda.is_available()'; fi";
      requireSuccess(recordedCommand(evidence, "post_bootstrap_torch_cuda", cudaCommand, () => sshCommand(target, cudaCommand, 180_000)), "post_bootstrap_torch_cuda_failed");
    }
    const healthCommand = "set -e; curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null; curl -fsS --max-time 5 http://127.0.0.1:8188/system_stats >/dev/null; curl -fsS --max-time 5 http://127.0.0.1:8188/object_info | python3 -c 'import json,sys; d=json.load(sys.stdin); required={\"UNETLoader\",\"CLIPLoader\",\"VAELoader\",\"KSampler\",\"VAEDecode\",\"SaveImage\",\"SaveWEBM\"}; missing=sorted(required-set(d)); print(\"required_nodes_missing=\"+\",\".join(missing)); raise SystemExit(1 if missing else 0)'; test -r /workspace/comfy-user/comfyui.db";
    let health = await waitForRuntimeHealth(target, evidence, "runtime_health", healthCommand);
    if (health.status !== 0 && providerId === "clore") {
      const logsCommand = "set +e; echo '=== runtime log ==='; cat /workspace/logs/runtime-stage3m.log; echo '=== processes ==='; ps -ef; echo '=== ports ==='; ss -ltnp";
      const logs = recordedCommand(evidence, "runtime_startup_logs", logsCommand, () => sshCommand(target, logsCommand, 120_000));
      const failure = classifyHostProbeFailure("runtime_startup", `${String(logs.stdout ?? "")}\n${String(logs.stderr ?? "")}`);
      recordEvidence(evidence, "runtime_startup_classification", "classify runtime startup", 0, JSON.stringify(failure));
      const packages = HOST_TOOLCHAIN_PACKAGES.join(" ");
      const correctionCommand = `set -e; apt-get update; pyver=$(python3 -c 'import sys; print(f\"{sys.version_info.major}.{sys.version_info.minor}\")'); pydev=python${"${pyver}"}-dev; apt-cache show \"$pydev\" >/dev/null 2>&1 || pydev=python3-dev; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages} \"$pydev\"; rm -rf /root/.triton/cache /tmp/torchinductor_root; /workspace/clore-light-bootstrap.sh stop`;
      requireSuccess(recordedCommand(evidence, "runtime_startup_in_place_correction", correctionCommand, () => sshCommand(target, correctionCommand, 20 * 60_000)), "runtime_startup_in_place_correction_failed");
      requireSuccess(recordedCommand(evidence, "runtime_start_retry", runtimeCommand, () => sshCommand(target, runtimeCommand, 60_000)), "runtime_start_retry_failed");
      health = await waitForRuntimeHealth(target, evidence, "runtime_health_retry", healthCommand);
      if (health.status !== 0) recordedCommand(evidence, "runtime_startup_logs_after_fix", logsCommand, () => sshCommand(target, logsCommand, 120_000));
    }
    if (health.status !== 0) throw new Error("runtime_health_failed_after_in_place_fix");
    installRemoteComfyRunner(target);
    const probe = runRemoteComfyProbe(target);
    recordEvidence(evidence, "remote_runner_structure_probe", "python3 /workspace/runtime-tools/comfy_remote_runner.py --probe", 0, JSON.stringify(probe));
    const tunneled = await probeOptionalRuntimeTunnel(target, sessionId);
    recordEvidence(evidence, "runtime_websocket_optional", "optional local SSH tunnel HTTP/WebSocket probe", tunneled.connected ? 0 : 1, JSON.stringify(tunneled), tunneled.connected ? "" : String(tunneled.error ?? "optional_tunnel_unavailable"));
    requireSuccess(recordedCommand(evidence, "flux_manifest_copy", "scp flux-r2-manifest.json /workspace/flux-r2-manifest.json", () => scpFile(target, bundlePath, "/workspace/flux-r2-manifest.json", 5 * 60_000)), "r2_bundle_copy_failed");
    requireSuccess(recordedCommand(evidence, "flux_restore_script_copy", "scp restore-flux-r2.py /workspace/restore-flux-r2.py", () => scpFile(target, restorePath, "/workspace/restore-flux-r2.py", 2 * 60_000)), "r2_restore_script_copy_failed");
    const restoreStarted = Date.now(); const restoreCommand = "set -e; FLUX_R2_RESTORE_MANIFEST=/workspace/flux-r2-manifest.json python3 /workspace/restore-flux-r2.py";
    requireSuccess(recordedCommand(evidence, "flux_r2_restore", restoreCommand, () => sshCommand(target, restoreCommand, 90 * 60_000)), "r2_model_restore_failed");
    const restoreElapsedMs = Date.now() - restoreStarted;
    const executeImage = (id: string, width: number, height: number) => runRemoteComfyWorkflow({ target, workflow: buildFluxFirstImageWorkflow({ width, height, seed: 20260715, steps: 4 }) as unknown as Record<string, unknown>, clientId: id, kind: "image", timeoutSeconds: 20 * 60 });
    let remoteResult;
    let width = 1024; let height = 1024; let oomFallbackUsed = false;
    try { remoteResult = executeImage(sessionId, width, height); }
    catch (error) {
      if (!/out of memory|cuda.*memory|oom/i.test(error instanceof Error ? error.message : String(error))) throw error;
      width = 768; height = 768; oomFallbackUsed = true;
      remoteResult = executeImage(sessionId, width, height);
    }
    const temporaryPng = downloadRemoteRunnerOutput(target, remoteResult, ".png");
    try {
      const bytes = readFileSync(temporaryPng); const png = validatePngPixels(bytes);
      const workflow = buildFluxFirstImageWorkflow({ width, height, seed: 20260715, steps: 4 });
      const capabilityEvidence = websocketCapabilityEvidence(remoteResult.websocket_remote_local, tunneled);
      const archived = archiveFluxFirstImage({
        sourcePng: temporaryPng,
        sessionId,
        workflow,
        metadata: { provider: providerId, gpu_model: gpuModel, prompt_id: remoteResult.prompt_id, width: png.width, height: png.height, steps: 4, seed: 20260715, elapsed_ms: remoteResult.elapsed_ms, r2_restore_elapsed_ms: restoreElapsedMs, png_size_bytes: bytes.length, pixel_range: png.pixel_range, oom_fallback_used: oomFallbackUsed },
        evidence: { system_stats: remoteResult.system_stats, required_nodes_verified: remoteResult.required_nodes_verified, history_verified: remoteResult.history_verified, runner_structure_probe: probe, ...capabilityEvidence },
      });
      writeFileSync(path.join(archived.archiveDir, "provider-session.json"), `${JSON.stringify({ provider: providerId, gpu_model: gpuModel, session_id: sessionId, runtime_digest_pinned: true, ...capabilityEvidence }, null, 2)}\n`, "utf8");
      const generated = { flux_first_image_verified: true, prompt_id: remoteResult.prompt_id, elapsed_ms: remoteResult.elapsed_ms, archive: archived, width, height, oomFallbackUsed, ...capabilityEvidence };
      return { restoreElapsedMs, generated, warm: { attempted: false }, commandEvidencePath: STAGE3T_COMMAND_EVIDENCE_PATH, bootstrapMode: evidence.find((item) => item.label === "runtime_prepare" || item.label === "runtime_prepare_in_place_fix")?.stdout.trim() ?? "unknown", postBootstrapTorchCuda: evidence.find((item) => item.label === "post_bootstrap_torch_cuda")?.stdout ?? "" };
    } finally { rmSync(temporaryPng, { force: true }); }
  } finally { rmSync(bundlePath, { force: true }); }
}

async function main() {
  const providerId = parseProviderArg();
  const requestedGpuType = argument("gpu-type");
  const requestedCloudType = argument("cloud-type")?.toUpperCase();
  if (requestedCloudType && requestedCloudType !== "SECURE" && requestedCloudType !== "COMMUNITY") throw new Error("Use --cloud-type=SECURE or --cloud-type=COMMUNITY.");
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify(await buildProviderDryRun(providerId, requestedGpuType, requestedCloudType), null, 2));
    return;
  }
  if (providerId === "clore" && !process.argv.includes("--controlled-clore-session")) throw new Error("Real Clore execution requires --controlled-clore-session.");
  if (providerId === "runpod" && !requestedGpuType) throw new Error("Real RunPod execution requires an explicit --gpu-type; the fixed Runtime currently supports RTX 4090/5090 only.");

  const provider = getGpuProvider(providerId);
  const sessionId = argument("session-id") ?? `first-image-${Date.now()}`;
  const runpodConfig = providerId === "runpod" ? loadRunPodConfig() : null;
  const watchdog = runpodConfig ? armRunPodWatchdog(sessionId, runpodConfig.maxSessionUsd) : null;
  const heartbeat = watchdog ? setInterval(() => watchdog.heartbeat(), 60_000) : null;
  let session: GpuSession | null = null;
  const priorCloreHold = providerId === "clore" ? getCloreDeploymentHold() : null;
  if (providerId === "clore") setCloreDeploymentHold(false, "stage3m_controlled_execution_session");
  try {
  let state = beginFirstImageState(providerId, sessionId);
  const allCandidates = await provider.listCandidates();
  const candidates = allCandidates.filter((candidate) => (!requestedGpuType || candidate.id === requestedGpuType) && (!requestedCloudType || candidate.cloudType === requestedCloudType));
  if (requestedGpuType && candidates.length === 0) throw new Error(`Requested GPU is not currently available and budget-compliant: ${requestedGpuType}`);
  session = await provider.recoverExistingSession(sessionId);
  if (nextFirstImageStage(state) === "candidate_selected") {
    state = completeFirstImageStage(state, "candidate_selected", { provider: providerId, candidate: candidates[0]?.id ?? "external" });
  }
  if (nextFirstImageStage(state) === "order_created") {
    if (!session && (providerId === "runpod" || providerId === "clore")) {
      const candidate = candidates[0];
      if (!candidate) throw new Error(`No ${providerId} candidate profile is available.`);
      const sshPublicKey = providerId === "runpod" ? readPublicKey((runpodConfig ?? loadRunPodConfig()).sshPublicKeyPath) : "managed-by-clore-provider";
      session = await provider.createSession({ sessionId, candidate, sshPublicKey, bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false });
    } else if (!session) {
      session = await provider.getSession(providerId);
    }
    if (!session) throw new Error(`${providerId}_session_unavailable`);
    watchdog?.recordPod(session.id, session.hourlyUsd);
    state = completeFirstImageStage(state, "order_created", { provider_session_id: session.id, lifecycle_managed: providerId !== "manual_ssh", gpu_type: session.gpuType, cloud_type: session.cloudType, costPerHr: session.costPerHr, adjustedCostPerHr: session.adjustedCostPerHr, containerDiskInGb: session.containerDiskInGb, volumeInGb: session.volumeInGb, ...(session.price ?? { computeHourly: null, storageHourly: null, totalHourly: null, projectedSessionTotal: null }) });
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
      const hardware = sshCommand(target, "set -e; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader; nvidia-smi; free -b; df -B1 /workspace; python3 --version; python3 -c 'import importlib.util; print(\"torch_present=\"+str(importlib.util.find_spec(\"torch\") is not None)); import torch; print(\"torch_version=\"+torch.__version__); print(\"cuda_available=\"+str(torch.cuda.is_available())); print(\"cuda_version=\"+str(torch.version.cuda)); print(\"compute_capability=\"+str(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else \"compute_capability=none\")' || true; (docker version || true)", 120_000);
      if (hardware.status !== 0) throw new Error("gpu_hardware_verification_failed");
      gpuModel = String(hardware.stdout).split(/\r?\n/)[0]?.split(",")[0]?.trim() || "unknown";
      state = completeFirstImageStage(state, "hardware_verified", { verified: true, gpu_model: gpuModel, inspection_output: String(hardware.stdout), output_sha256_recorded_separately: true });
    }
    if (["runtime_ready", "models_restored"].includes(String(nextFirstImageStage(state)))) {
      const result = await runRemoteFirstImage(target, providerId, sessionId, gpuModel);
      if (nextFirstImageStage(state) === "runtime_ready") state = completeFirstImageStage(state, "runtime_ready", { controller_and_comfy_health_verified: true });
      if (nextFirstImageStage(state) === "models_restored") state = completeFirstImageStage(state, "models_restored", { source: "r2_presigned_get", elapsed_ms: result.restoreElapsedMs, size_and_sha_verified: true });
      state = completeFirstImageStage(state, "prompt_submitted", { submitted_by_existing_executor: true });
      state = completeFirstImageStage(state, "image_generated", { result: result.generated, warm_run: result.warm });
      state = completeFirstImageStage(state, "result_synced", { local_archive: true, provider_session_json: true });
    }
    if (nextFirstImageStage(state) === "session_stopped") {
      sshCommand(target, providerId === "clore" ? "/workspace/clore-light-bootstrap.sh stop || true" : "if test -s /workspace/runtime-stage3j.pid; then kill -TERM \"$(cat /workspace/runtime-stage3j.pid)\" 2>/dev/null || true; fi; rm -f /workspace/flux-r2-manifest.json", 60_000);
      await provider.stopSession(session);
      state = completeFirstImageStage(state, "session_stopped", { runtime_stopped: true });
    }
    if (nextFirstImageStage(state) === "order_cancelled") {
      await provider.terminateSession(session);
      watchdog?.disarm();
      state = completeFirstImageStage(state, "order_cancelled", { provider_session_terminated: providerId !== "manual_ssh", external_lifecycle_untouched: providerId === "manual_ssh" });
    }
    console.log(JSON.stringify({ resumed: true, provider: providerId, session_id: session.id, next_stage: nextFirstImageStage(state), completed: state.completed, target: sanitizeGpuTarget(target) }, null, 2));
  } catch (error) {
    if (target) sshCommand(target, providerId === "clore" ? "/workspace/clore-light-bootstrap.sh stop || true" : "if test -s /workspace/runtime-stage3j.pid; then kill -TERM \"$(cat /workspace/runtime-stage3j.pid)\" 2>/dev/null || true; fi; rm -f /workspace/flux-r2-manifest.json", 60_000);
    if (providerId !== "manual_ssh") {
      try { await provider.terminateSession(session); watchdog?.disarm(); } catch { /* Keep Watchdog armed when termination is not confirmed. */ }
    }
    throw error;
  }
  } catch (error) {
    if (!session) watchdog?.disarm();
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (providerId === "clore") setCloreDeploymentHold(true, priorCloreHold?.reason || "stage3m_session_complete");
  }
}

if (process.argv[1]?.endsWith("gpu-first-image.ts")) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "first image orchestration failed"); process.exitCode = 1; });
}
