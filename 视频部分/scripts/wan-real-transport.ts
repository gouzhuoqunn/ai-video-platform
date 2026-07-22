import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scpFile, sshCommand } from "./gpu-providers/common";
import type { GpuTarget } from "./gpu-providers/types";
import { archiveStage3OWanVideo, buildStage3OWanWorkflow, validateStage3OWanWorkflow } from "./stage3o-wan-executor";
import { downloadRemoteRunnerOutput, runRemoteComfyWorkflow, websocketCapabilityEvidence } from "./comfy-remote-runner";
import { buildStage3OWanBundle, writeStage3OWanBundle } from "./stage3o-wan-bundle";

type CommandResult = { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null };
function requireSuccess(result: CommandResult, code: string) {
  if (result.status !== 0) throw new Error(`${code}:${String(result.stderr ?? result.stdout ?? "").trim().slice(-800)}`);
  return String(result.stdout ?? "");
}

export type WanTransportTask = { id: string; prompt: string; seed?: number };
export type WanTransportDependencies = {
  writeBundle: typeof writeStage3OWanBundle;
  scp: typeof scpFile;
  ssh: typeof sshCommand;
  runWorkflow: typeof runRemoteComfyWorkflow;
  download: typeof downloadRemoteRunnerOutput;
  archive: typeof archiveStage3OWanVideo;
};
const realDependencies: WanTransportDependencies = { writeBundle: writeStage3OWanBundle, scp: scpFile, ssh: sshCommand, runWorkflow: runRemoteComfyWorkflow, download: downloadRemoteRunnerOutput, archive: archiveStage3OWanVideo };

/** One SSH host keeps the restored Wan model for every task in one frozen batch. */
export function createRealWanTransport(target: GpuTarget, dependencies: WanTransportDependencies = realDependencies) {
  let restored: Record<string, unknown> | null = null;
  async function ensureRestored() {
    if (restored) return restored;
    const bundle = dependencies.writeBundle();
    const restoreScript = path.join(process.cwd(), "scripts", "clore", "restore-stage3o-r2.py");
    requireSuccess(dependencies.scp(target, bundle.filePath, "/workspace/stage3o-wan-r2-bundle.json", 5 * 60_000), "wan_bundle_copy_failed");
    requireSuccess(dependencies.scp(target, restoreScript, "/workspace/restore-stage3o-r2.py", 2 * 60_000), "wan_restore_script_copy_failed");
    const output = requireSuccess(dependencies.ssh(target, "set -e; test $(df --output=avail -B1 /workspace | tail -1) -ge 50000000000; STAGE3O_R2_RESTORE_MANIFEST=/workspace/stage3o-wan-r2-bundle.json python3 /workspace/restore-stage3o-r2.py", 90 * 60_000), "wan_restore_failed");
    restored = JSON.parse(output) as Record<string, unknown>;
    return restored;
  }
  async function run(task: WanTransportTask) {
    const restore = await ensureRestored();
    let workflow = buildStage3OWanWorkflow();
    if (task.prompt.trim()) workflow["6"].inputs.text = task.prompt.trim();
    let validation = validateStage3OWanWorkflow(workflow); let oomFallbackUsed = false;
    let remoteResult: ReturnType<typeof runRemoteComfyWorkflow>;
    try { remoteResult = dependencies.runWorkflow({ target, workflow: workflow as unknown as Record<string, unknown>, clientId: task.id, kind: "video", timeoutSeconds: 90 * 60 }); }
    catch (error) {
      if (!/out of memory|cuda.*memory|oom/i.test(error instanceof Error ? error.message : String(error))) throw error;
      requireSuccess(dependencies.ssh(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":false,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null", 60_000), "wan_oom_memory_clear_failed");
      workflow = buildStage3OWanWorkflow({ width: 640, height: 368 }); if (task.prompt.trim()) workflow["6"].inputs.text = task.prompt.trim(); validation = validateStage3OWanWorkflow(workflow); oomFallbackUsed = true;
      remoteResult = dependencies.runWorkflow({ target, workflow: workflow as unknown as Record<string, unknown>, clientId: `${task.id}-low`, kind: "video", timeoutSeconds: 90 * 60 });
    }
    const localWebm = dependencies.download(target, remoteResult, ".webm");
    try {
      const generated = dependencies.archive({ sourceWebm: localWebm, workflow, promptId: String(remoteResult.prompt_id ?? ""), validation, oomFallbackUsed, jobId: task.id, seed: task.seed, runtimeEvidence: { system_stats: remoteResult.system_stats, required_nodes_verified: remoteResult.required_nodes_verified, history_verified: remoteResult.history_verified, ...websocketCapabilityEvidence(remoteResult.websocket_remote_local, { attempted: false, connected: false, reason: "wan_batch_transport" }) } });
      return { restore, generated };
    } finally { rmSync(localWebm, { force: true }); }
  }
  async function stop() { requireSuccess(dependencies.ssh(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null", 60_000), "wan_unload_failed"); }
  return { ensureRestored, run, stop };
}

async function controllerJson(baseUrl: string, pathName: string, method = "GET", payload?: unknown) {
  const response = await fetch(`${baseUrl}${pathName}`, { method, headers: payload === undefined ? undefined : { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await response.text(); let parsed: unknown = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(-500) }; }
  if (!response.ok) throw new Error(`controller_${pathName.replace(/[^a-z]/g, "_")}_http_${response.status}:${JSON.stringify(parsed).slice(-700)}`);
  return parsed as Record<string, unknown>;
}

/** HTTP-only counterpart of the existing SSH transport.  The Clore proxy exposes
 * the controller; ComfyUI itself remains loopback-only inside the runtime. */
export function createHttpWanTransport(baseUrl: string) {
  let restored: Record<string, unknown> | null = null;
  async function ensureRestored() {
    if (!restored) restored = await controllerJson(baseUrl, "/restore", "POST", buildStage3OWanBundle());
    return restored;
  }
  async function run(task: WanTransportTask) {
    const restore = await ensureRestored(); let workflow = buildStage3OWanWorkflow(); if (task.prompt.trim()) workflow["6"].inputs.text = task.prompt.trim();
    const validation = validateStage3OWanWorkflow(workflow);
    const submitted = await controllerJson(baseUrl, "/prompt", "POST", { prompt: workflow, client_id: task.id });
    const promptId = String(submitted.prompt_id ?? ""); if (!promptId) throw new Error("controller_prompt_missing_prompt_id");
    const deadline = Date.now() + 90 * 60_000; let history: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      history = await controllerJson(baseUrl, `/history/${encodeURIComponent(promptId)}`);
      const item = history[promptId] as Record<string, unknown> | undefined;
      if (item?.status && (item.status as Record<string, unknown>).completed === true) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const outputs = ((history?.[promptId] as Record<string, unknown> | undefined)?.outputs ?? {}) as Record<string, { videos?: Array<Record<string, string>>; images?: Array<Record<string, string>> }>;
    const output = Object.values(outputs).flatMap((value) => value.videos ?? value.images ?? [])[0];
    if (!output?.filename) throw new Error("controller_history_missing_output");
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? "", type: output.type ?? "output" });
    const response = await fetch(`${baseUrl}/view?${query}`); if (!response.ok) throw new Error(`controller_view_http_${response.status}`);
    const dir = mkdtempSync(path.join(os.tmpdir(), "wan-http-")); const localWebm = path.join(dir, path.basename(output.filename)); writeFileSync(localWebm, Buffer.from(await response.arrayBuffer()));
    try { return { restore, generated: archiveStage3OWanVideo({ sourceWebm: localWebm, workflow, promptId, validation, oomFallbackUsed: false, jobId: task.id, seed: task.seed, runtimeEvidence: { controller_http: true } }) }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  async function stop() { await controllerJson(baseUrl, "/free", "POST", { unload_models: true, free_memory: true }); }
  return { ensureRestored, run, stop };
}
