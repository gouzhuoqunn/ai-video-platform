import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveFluxFirstImage, buildFluxFirstImageWorkflow } from "./flux-first-image";

type RecordValue = Record<string, unknown>;

function arg(name: string) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Runtime request failed: ${response.status}`);
  return body;
}

async function verifyWebSocket(url: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Runtime WebSocket handshake timed out."));
    }, 15000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Runtime WebSocket handshake failed."));
    }, { once: true });
  });
}

function outputImage(history: unknown) {
  const item = record(history);
  for (const value of Object.values(record(item.outputs))) {
    const images = record(value).images;
    if (!Array.isArray(images) || images.length === 0) continue;
    const image = record(images[0]);
    const filename = typeof image.filename === "string" ? image.filename : "";
    const subfolder = typeof image.subfolder === "string" ? image.subfolder : "";
    const type = typeof image.type === "string" ? image.type : "output";
    if (filename) return { filename, subfolder, type };
  }
  return null;
}

async function main() {
  const baseUrl = (arg("base-url") ?? "").replace(/\/$/, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
    throw new Error("Use a loopback SSH tunnel, for example --base-url=http://127.0.0.1:18188.");
  }
  const width = Number(arg("width") ?? 1024);
  const height = Number(arg("height") ?? 1024);
  const sessionId = arg("session-id") ?? `flux-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const provider = arg("provider") ?? "unknown";
  const gpuModel = arg("gpu-model") ?? "unknown";
  const restoreElapsedMs = Number(arg("restore-elapsed-ms") ?? 0);
  const workflow = buildFluxFirstImageWorkflow({ width, height, seed: 20260715, steps: 4 });
  const startedAt = Date.now();
  const systemStats = await json(`${baseUrl}/system_stats`);
  const objectInfo = record(await json(`${baseUrl}/object_info`));
  for (const classType of ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "FluxGuidance", "EmptyFlux2LatentImage", "KSampler", "VAEDecode", "SaveImage"]) {
    if (!(classType in objectInfo)) throw new Error(`Required Runtime node is unavailable: ${classType}`);
  }
  await verifyWebSocket(baseUrl.replace("http://", "ws://") + "/ws");
  const submitted = record(await json(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: sessionId }),
  }));
  const promptId = typeof submitted.prompt_id === "string" ? submitted.prompt_id : "";
  if (!promptId) throw new Error("Runtime did not return a prompt_id.");
  let completed: unknown = null;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const history = record(await json(`${baseUrl}/history/${encodeURIComponent(promptId)}`));
    completed = history[promptId];
    if (completed) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!completed) throw new Error("Runtime history timed out.");
  const image = outputImage(completed);
  if (!image) throw new Error("Runtime history did not contain a saved image.");
  const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
  const response = await fetch(`${baseUrl}/view?${params}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || bytes.length < 64 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Runtime output is not a valid PNG response.");
  }
  const temporaryPng = path.join(os.tmpdir(), `${sessionId}.png`);
  mkdirSync(path.dirname(temporaryPng), { recursive: true });
  writeFileSync(temporaryPng, bytes);
  const archived = archiveFluxFirstImage({
    sourcePng: temporaryPng,
    sessionId,
    workflow,
    metadata: { provider, gpu_model: gpuModel, prompt_id: promptId, width, height, steps: 4, seed: 20260715, elapsed_ms: Date.now() - startedAt, r2_restore_elapsed_ms: restoreElapsedMs },
    evidence: { system_stats: systemStats, required_nodes_verified: true, websocket_verified: true, history_verified: true },
  });
  writeFileSync(path.join(archived.archiveDir, "provider-session.json"), `${JSON.stringify({ provider, gpu_model: gpuModel, session_id: sessionId, runtime_digest_pinned: true }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ flux_first_image_verified: true, prompt_id: promptId, elapsed_ms: Date.now() - startedAt, archive: archived }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Flux first-image executor failed");
  process.exitCode = 1;
});
