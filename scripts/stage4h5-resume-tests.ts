import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLongVideoProject, processExpiredLongVideoReviews, reviewLongVideoSegment } from "../src/lib/long-video/store";
import { LongVideoExecutionCoordinator, type LongVideoProvider, type LongVideoProviderSession } from "../src/lib/long-video/execution";

const projectId = "8fff4d9f-39f6-4aee-a02a-d0a6376e4f8b";
const sourceRoot = "D:\\AI-Video-Library";
const sourceState = ".secrets/long-video-state.json";
const sourceProject = getLongVideoProject(projectId, sourceState);
if (!sourceProject) throw new Error("stage4h5_project_missing");
const verifiedProject = sourceProject;
const root = mkdtempSync(path.join(os.tmpdir(), "stage4h5-resume-"));
const statePath = path.join(root, "long-video-state.json");
const sessionPath = path.join(root, "long-video-execution.json");
const libraryDir = path.join(root, "library");
const sourceProjectDir = path.join(sourceRoot, verifiedProject.createdAt.slice(0, 10), projectId);
cpSync(sourceProjectDir, path.join(libraryDir, verifiedProject.createdAt.slice(0, 10), projectId), { recursive: true });
writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 1, projects: [verifiedProject] }, null, 2)}\n`, "utf8");
writeFileSync(sessionPath, `${JSON.stringify({ schemaVersion: 1, projectId, provider: "clore", authorizationId: "previous-auth", orderId: "previous-order", providerSessionId: "previous-session", serverId: "98682", gpuProfile: "rtx4090", runtimeState: "runtime_ready", restoreState: "completed", restoreRevision: "previous", currentSegmentIndex: 0, currentAttemptId: verifiedProject.segments[0].selectedAttemptId, draining: false, cleanupState: "completed", approximateSpendUsd: 0, active: false, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() }, null, 2)}\n`, "utf8");

class ResumeFakeProvider implements LongVideoProvider {
  orderCount = 0;
  active = 0;
  restoreCount = 0;
  inferenceIndexes: number[] = [];
  cancelCount = 0;
  private readonly session: LongVideoProviderSession = { sessionId: "resume-session", orderId: "resume-order", serverId: "98682", gpuProfile: "rtx4090", host: "127.0.0.1", port: 22 };
  async listCandidates() { return [{ serverId: "98682", gpuProfile: "rtx4090", hourlyUsd: 0.24, vramGb: 24 }]; }
  async activeOrderCount() { return this.active; }
  async createSession() { assert.equal(this.active, 0); this.active = 1; this.orderCount += 1; return this.session; }
  async waitForSsh() {}
  async prepareWorkspace() {}
  async bootstrapRuntime() {}
  async runCanary() {}
  async restoreWan() { this.restoreCount += 1; return { revision: "resume-wan-current", verifiedObjects: 5 }; }
  async generateSegment(input: Parameters<LongVideoProvider["generateSegment"]>[0]) {
    this.inferenceIndexes.push(input.sequenceIndex);
    const projectDir = path.join(libraryDir, verifiedProject.createdAt.slice(0, 10), projectId);
    const sourceVideo = path.join(root, `segment-${input.sequenceIndex}.webm`);
    copyFileSync(path.join(projectDir, "segments", "000", "attempts", verifiedProject.segments[0].selectedAttemptId!, "source.webm"), sourceVideo);
    const inputPath = path.join(projectDir, input.inputFrameRef);
    const inputSha256 = require("node:crypto").createHash("sha256").update(readFileSync(inputPath)).digest("hex");
    return { sourceVideo, inputFrameSha256: inputSha256, previousSegmentId: input.previousSegmentId, previousAttemptId: input.previousAttemptId, previousLastFrameSha256: input.previousLastFrameSha256 };
  }
  async awaitReview(input: { projectId: string; sequenceIndex: number; deadline: string }) {
    processExpiredLongVideoReviews(new Date(Date.parse(input.deadline) + 1), statePath);
    return "timeout_accept" as const;
  }
  async cancelSession() { this.active = 0; this.cancelCount += 1; }
}

void (async () => {
const provider = new ResumeFakeProvider();
const coordinator = new LongVideoExecutionCoordinator({ provider, statePath, sessionPath, libraryDir, policy: { maxSpendUsd: 0.9, maxSegmentsPerSession: 2, maxConsecutiveSegments: 2 } });
const plan = await coordinator.plan(projectId);
assert.equal(plan.real_project_plan_ready, true);
assert.equal(plan.resume_existing_project, true);
assert.equal(plan.resume_from_segment, 1);
assert.deepEqual(plan.accepted_segments, [0]);
assert.deepEqual(plan.segments_to_generate, [1, 2]);
assert.equal(plan.segment0_will_not_regenerate, true);
const authorization = { id: "resume-auth", projectId, provider: "clore" as const, gpuProfile: "rtx4090" as const, oneUse: true as const, expiresAt: new Date(Date.now() + 60_000).toISOString(), maxSpendUsd: 0.9, releaseHold: true, maxSegments: 2, wallClockMinutes: 125, drainingAtMinutes: 110, maxPreSshAttempts: 2 };
const session = await coordinator.execute(projectId, authorization, { resume: true });
const finalProject = getLongVideoProject(projectId, statePath)!;
assert.equal(session.active, false);
assert.equal(provider.orderCount, 1);
assert.equal(provider.restoreCount, 1);
assert.deepEqual(provider.inferenceIndexes, [1, 2]);
assert.equal(provider.cancelCount, 1);
assert.equal(finalProject.status, "awaiting_merge_confirmation");
assert.equal(finalProject.segments[0].attempts.length, 1);
assert.equal(finalProject.segments[1].attempts.length, 1);
assert.equal(finalProject.segments[2].attempts.length, 1);
assert.deepEqual(finalProject.segments.map((segment) => segment.status), ["accepted", "accepted", "accepted"]);
const staleAccepted = reviewLongVideoSegment({ projectId, sequenceIndex: 1, action: "accept", expectedProjectVersion: 1, expectedSegmentVersion: 1, statePath });
const staleTimeout = reviewLongVideoSegment({ projectId, sequenceIndex: 1, action: "timeout_accept", expectedProjectVersion: 1, expectedSegmentVersion: 1, statePath });
assert.equal(staleAccepted.version, finalProject.version);
assert.equal(staleTimeout.version, finalProject.version);
const poolPath = `${statePath}.pool.json`;
const pool = existsSync(poolPath) ? JSON.parse(readFileSync(poolPath, "utf8")) as { tasks?: Array<{ longVideoProjectId?: string }> } : { tasks: [] };
assert.equal((pool.tasks ?? []).filter((task) => task.longVideoProjectId === projectId).length, 0);
console.log(JSON.stringify({ ok: true, resumeFrom: 1, acceptedSegmentsReused: 1, generatedSegments: provider.inferenceIndexes, oneOrder: provider.orderCount, oneWanRestore: provider.restoreCount, idempotentManualAndTimeout: true, noDuplicateTasks: true }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
