import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";

const taskId = "623e4567-e89b-42d3-a456-426614174000";
const root = mkdtempSync(path.join(os.tmpdir(), "local-image-route-"));
process.env.AI_IMAGE_LIBRARY_ROOT = path.join(root, "library");
process.env.LOCAL_LAB_ENABLED = "true";
process.env.NEXT_PUBLIC_APP_MODE = "local_lab";

async function main() {
  try {
    const { claimImageTask, finalizeImageTask } = await import("../../src/lib/image-generation/local-image-task-store");
    const { publishLocalImageArtifact, verifyPublishedLocalImageArtifact } = await import("../../src/lib/image-generation/local-image-artifacts");
    const { GET } = await import("../../src/app/api/local-images/[taskId]/[kind]/route");
    const taskPath = path.join(root, "tasks.json");
    process.env.AI_IMAGE_TASK_STORE_PATH = taskPath;
    const task = { id: taskId, status: "waiting_for_gpu", mode: "text_generation", referenceImage: null, prompt: "fixture", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 1, sampler: "Euler", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0 };
    writeFileSync(taskPath, JSON.stringify([task]), "utf8");
    const claim = claimImageTask(taskId, "route-test", 60_000, { taskPath, artifactRoot: process.env.AI_IMAGE_LIBRARY_ROOT });
    const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#248" } }).png().toBuffer();
    const artifact = await publishLocalImageArtifact({ task, png, remote: { generationDurationSeconds: 1, orderId: "fixture", gpuModel: "RTX 4090", controllerPromptId: null } });
    await finalizeImageTask(taskId, claim.claimToken, artifact, { taskPath, artifactRoot: process.env.AI_IMAGE_LIBRARY_ROOT });
    const request = new NextRequest(`http://127.0.0.1/api/local-images/${taskId}/output`, { headers: { host: "127.0.0.1" } });
    const output = await GET(request, { params: Promise.resolve({ taskId, kind: "output" }) });
    const outputBytes = Buffer.from(await output.arrayBuffer());
    assert.equal(output.status, 200); assert.equal(output.headers.get("content-type"), "image/png"); assert.equal(output.headers.get("content-length"), String(outputBytes.length)); assert.equal(outputBytes.length, png.length);
    const thumbnail = await GET(request, { params: Promise.resolve({ taskId, kind: "thumbnail" }) });
    const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
    const thumbnailMetadata = await sharp(thumbnailBytes).metadata();
    assert.equal(thumbnail.status, 200); assert.equal(thumbnail.headers.get("content-type"), "image/webp"); assert.equal(thumbnail.headers.get("content-length"), String(thumbnailBytes.length)); assert.equal(thumbnailMetadata.format, "webp"); assert.ok((thumbnailMetadata.width ?? 0) > 0 && (thumbnailMetadata.width ?? 513) <= 512); assert.ok((thumbnailMetadata.height ?? 0) > 0 && (thumbnailMetadata.height ?? 513) <= 512);
    await verifyPublishedLocalImageArtifact({ taskId, artifact, root: process.env.AI_IMAGE_LIBRARY_ROOT });
    const traversal = await GET(request, { params: Promise.resolve({ taskId: "../../etc/passwd", kind: "output" }) });
    assert.equal(traversal.status, 404);
    console.log(JSON.stringify({ ok: true, local_only_route: true, exact_content_length: true, verified_png_and_webp_served: true, traversal_blocked: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

void main();
