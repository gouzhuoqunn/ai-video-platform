import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const root = mkdtempSync(path.join(os.tmpdir(), "stage4g-api-"));
process.env.LOCAL_LAB_ENABLED = "true";
const statePath = path.join(root, "long-video.json");
const poolPath = path.join(root, "pool.json");
const uploadDir = path.join(root, "uploads");
const libraryDir = path.join(root, "library");
process.env.LONG_VIDEO_STATE_PATH = statePath;
process.env.GENERATION_POOL_STATE_PATH = poolPath;
process.env.LONG_VIDEO_UPLOAD_DIR = uploadDir;
process.env.LOCAL_VIDEO_LIBRARY_DIR = libraryDir;

function request(url: string, init: { method?: string; headers?: HeadersInit; body?: BodyInit | null } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost:3000");
  headers.set("origin", "http://localhost:3000");
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method, body: init.body, headers });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(response: Response) { return await response.json() as Record<string, any>; }
function countFiles(directory: string): number { return existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total + (entry.isDirectory() ? countFiles(path.join(directory, entry.name)) : 1), 0) : 0; }

async function main() {
try {
  const uploadRoute = await import("../src/app/api/local-lab/long-video/uploads/route");
  const projectRoute = await import("../src/app/api/local-lab/long-video/route");
  const projectDetailRoute = await import("../src/app/api/local-lab/long-video/[projectId]/route");
  const { readGenerationPool } = await import("../src/lib/generation/task-pool");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0)]);
  const form = new FormData();
  form.set("file", new Blob([png], { type: "image/png" }), "first-frame.png");
  const uploaded = await json(await uploadRoute.POST(request("/api/local-lab/long-video/uploads", { method: "POST", body: form })));
  assert.match(uploaded.ref, /^upload:[a-f0-9-]{36}$/);

  const created = await json(await projectRoute.POST(request("/api/local-lab/long-video", { method: "POST", body: JSON.stringify({ action: "create", title: "上传首帧 15 秒", overallPrompt: "A continuous safe scene.", firstFrameSource: "upload", firstFrameRef: uploaded.ref, targetDurationSeconds: 15, prompts: ["Part one", "Part two", "Part three"] }) })));
  assert.equal(created.provider_authorization_created, false);
  assert.equal(created.credit_charged, false);
  assert.equal(created.create_order_called, false);
  assert.equal(created.project.totalSegments, 3);
  assert.equal(created.project.firstFrameRef, "upload:ready");
  const confirmed = await json(await projectDetailRoute.PATCH(request(`/api/local-lab/long-video/${created.project.id}`, { method: "PATCH", body: JSON.stringify({ action: "confirm", expectedProjectVersion: created.project.version }) }), { params: Promise.resolve({ projectId: created.project.id }) }));
  assert.equal(confirmed.project.status, "waiting_for_gpu");
  assert.equal(readGenerationPool().tasks.filter((task) => task.longVideoProjectId === created.project.id).length, 1);

  const pure = await json(await projectRoute.POST(request("/api/local-lab/long-video", { method: "POST", body: JSON.stringify({ action: "create", title: "纯提示词 10 秒", overallPrompt: "A safe independent first frame.", firstFrameSource: "pure_prompt", targetDurationSeconds: 10, prompts: ["Move gently", "Continue smoothly"] }) })));
  assert.equal(pure.project.totalSegments, 2);
  const pureConfirmed = await json(await projectDetailRoute.PATCH(request(`/api/local-lab/long-video/${pure.project.id}`, { method: "PATCH", body: JSON.stringify({ action: "confirm", expectedProjectVersion: pure.project.version }) }), { params: Promise.resolve({ projectId: pure.project.id }) }));
  assert.equal(readGenerationPool().tasks.filter((task) => task.longVideoProjectId === pure.project.id && task.generationType === "image").length, 1);
  assert.equal(pureConfirmed.provider_authorization_created, false);

  const deletedUploaded = await json(await projectDetailRoute.DELETE(request(`/api/local-lab/long-video/${created.project.id}?version=${confirmed.project.version}`, { method: "DELETE" }), { params: Promise.resolve({ projectId: created.project.id }) }));
  assert.equal(deletedUploaded.deleted, true);
  const deletedPure = await json(await projectDetailRoute.DELETE(request(`/api/local-lab/long-video/${pure.project.id}?version=${pureConfirmed.project.version}`, { method: "DELETE" }), { params: Promise.resolve({ projectId: pure.project.id }) }));
  assert.equal(deletedPure.deleted, true);
  assert.equal(existsSync(statePath), false);
  assert.equal(readGenerationPool().tasks.length, 0);
  assert.equal(existsSync(uploadDir), false);
  assert.equal(countFiles(libraryDir), 0);
  console.log(JSON.stringify({ ok: true, uploadedFirstFrame15s: true, purePrompt10s: true, providerAuthorization: false, creditCharged: false, fixtureResidue: false }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
}

void main();
