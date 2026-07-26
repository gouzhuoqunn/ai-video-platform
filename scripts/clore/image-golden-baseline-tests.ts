import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readImageTask } from "../../src/lib/image-generation/local-image-task-store";

const baseline = JSON.parse(readFileSync("docs/IMAGE_E2E_GOLDEN_BASELINE.json", "utf8"));
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
assert.equal(baseline.productBaselineCommit, "c9d0a3392cd1dbbaacb7b3d01cdf906c509d6aaf");
assert.equal(hash("scripts/clore/diagnostic-agent.py"), baseline.runtime.agentSha256);
assert.equal(hash("comfy-runtime/controller.py"), baseline.runtime.controllerSha256);
assert.equal(hash("comfy-runtime/image_workflow.py"), baseline.runtime.workflowSha256);
assert.equal(baseline.models.length, 5); assert.deepEqual(baseline.models.map((model: { role: string }) => model.role), ["transformer", "lora", "vae", "clip_l", "t5"]);
assert.equal(baseline.task.inferencePosts, 1); assert.equal(baseline.task.finalStatus, "completed"); assert.equal(baseline.task.attempts, 3); assert.deepEqual(baseline.png, { width: 768, height: 768, bytes: 677412, sha256: "b87fb7e844105473d30f6817c07372878cbaca4ce464954b485ff46ef7d16752" }); assert.deepEqual(baseline.thumbnail, { width: 512, height: 512, bytes: 13498 }); assert.equal(baseline.browserVerified, true); assert.equal(baseline.activeOrderCount, 0);
assert.equal(JSON.stringify(baseline).match(/(prompt|token|credential|signature|endpoint)/i), null);
const task = readImageTask(baseline.task.id); assert.ok(task, "golden local task must exist"); assert.equal(task.status, "completed"); assert.equal(task.attempts, 3); assert.equal(Boolean(task.localClaim), false); assert.equal(Boolean(task.error), false); assert.equal(task.result?.pngSha256, baseline.png.sha256); assert.equal(task.result?.pngBytes, baseline.png.bytes); assert.equal(task.result?.relativeDir, baseline.task.artifactRelativeDir);
console.log(JSON.stringify({ ok: true, golden_runtime_hashes_immutable: true, golden_png_evidence_immutable: true, golden_completed_task_unchanged: true, credentials_absent: true }));
