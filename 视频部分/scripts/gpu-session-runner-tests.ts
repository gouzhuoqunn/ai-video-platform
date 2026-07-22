import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorizeManualSilent4090Batch, createGenerationTask, createManualSilent4090Batch, readGenerationPool, updateManualGpuBatch, upsertGenerationTasks } from "../src/lib/generation/task-pool";
import { executeFrozenWanBatch, runGpuSessionRunnerTick } from "./gpu-session-runner";

const root = mkdtempSync(path.join(os.tmpdir(), "gpu-session-runner-"));
const poolPath = path.join(root, "pool.json");
const task = (id: string) => createGenerationTask({ id, generationType: "video", mediaType: "video", videoSubtype: "short_video", prompt: `fixture ${id}`, modelProfile: "wan22-remix-14b-i2v-fp8", modelKey: "video_wan_silent", soundMode: "silent", audioOrigin: "none", requiredGpuClass: "rtx4090", gpuPreference: ["rtx4090"], status: "waiting_for_gpu", confirmedAt: "2026-07-21T00:00:00.000Z", createdAt: "2026-07-21T00:00:00.000Z", modelRevision: "fixture", width: 1280, height: 720, frames: 81, fps: 16, contentMode: "production", jobForm: "video_from_existing_image", inputImageVerified: true, inputImageJobId: "fixture-image" });

async function main() {
  try {
    upsertGenerationTasks([task("first"), task("second")], poolPath);
    const frozen = createManualSilent4090Batch(poolPath);
    const authorized = authorizeManualSilent4090Batch(poolPath);
    assert.equal(authorized.batch.taskIds.length, 2);
    const selected = await runGpuSessionRunnerTick(async () => ({ selected: { server_id: "cheap-4090", base_usd_per_hour: 0.5, effective_usd_per_hour: 0.525, gpu: "NVIDIA GeForce RTX 4090" } }), poolPath);
    assert.equal(selected.action, "candidate_selected");
    const afterCandidate = readGenerationPool(poolPath).scheduler.manualBatch!;
    assert.equal(afterCandidate.id, frozen.batch.id);
    assert.equal(afterCandidate.startIntent?.status, "candidate_selected");
    const disabled = await runGpuSessionRunnerTick(async () => { throw new Error("market must not be reread while mutation is disabled"); }, poolPath);
    assert.equal(disabled.action, "mutation_disabled");
    assert.equal(readGenerationPool(poolPath).scheduler.manualBatch?.providerOrderId, null);
    updateManualGpuBatch({ status: "provisioning", providerOrderId: "fake-order" }, poolPath);
    const calls: string[] = [];
    const result = await executeFrozenWanBatch({
      target: { provider: "clore", host: "fake-host", port: 22, username: "root", sshKeyPath: "fake", gpuProfile: "rtx4090", runtimeDigest: "sha256:fake" },
      poolPath,
      transport: {
        async ensureRestored() { calls.push("restore"); },
        async run(current) { calls.push(current.id); return { generated: { outputPath: `fake/${current.id}.mp4`, thumbnailPath: `fake/${current.id}.jpg` } }; },
        async stop() { calls.push("stop"); },
      },
    });
    assert.deepEqual(calls, ["restore", "first", "second", "stop"]);
    assert.deepEqual(result.completedTaskIds, ["first", "second"]);
    assert.equal(readGenerationPool(poolPath).scheduler.manualBatch?.status, "completed");
    console.log(JSON.stringify({ ok: true, frozenTaskIds: frozen.batch.taskIds, fakeProviderOrders: 1, fakeSshSessions: 1, runnerAction: "batch_completed", transportCalls: calls }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
