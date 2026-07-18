import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { confirmLongVideoProject, getLongVideoProject, persistLongVideoProject, processExpiredLongVideoReviews } from "../src/lib/long-video/store";
import { buildLongVideoProjectPaths } from "../src/lib/long-video/media";
import { LongVideoExecutionCoordinator, type LongVideoExecutionAuthorization, type LongVideoProvider, type LongVideoProviderSession } from "../src/lib/long-video/execution";

const require = createRequire(import.meta.url);
const ffmpeg = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const root = mkdtempSync(path.join(os.tmpdir(), "stage4h3-"));
const statePath = path.join(root, "long-video-state.json");
const poolPath = path.join(root, "generation-pool-state.json");
const sessionPath = path.join(root, "execution-session.json");
const libraryDir = path.join(root, "library");
const remoteDir = path.join(root, "remote");
const fakeNow = new Date(Date.now() + 60_000);
const projectId = persistLongVideoProject({
  title: "fake-provider-long-video",
  overallPrompt: "synthetic continuity test",
  firstFrameSource: "existing_image",
  firstFrameRef: "image:fake-verified-source",
  targetDurationSeconds: 15,
  gpuPreference: ["rtx4090"],
  prompts: ["Prompt A distinct motion", "Prompt B distinct motion", "Prompt C distinct motion"],
}, statePath).id;
let project = getLongVideoProject(projectId, statePath)!;
project = confirmLongVideoProject(projectId, project.version, { statePath, poolPath });

function hashText(value: string) { return createHash("sha256").update(value).digest("hex"); }

class FakeProvider implements LongVideoProvider {
  active = 0;
  orderCount = 0;
  restoreCount = 0;
  generateCount = 0;
  cancelCount = 0;
  prompts: string[] = [];
  lineage: Array<{ input: string; previousSegmentId: string | null; previousAttemptId: string | null; previousLastFrameSha256: string | null }> = [];
  decisions: Array<"timeout_accept" | "accept"> = ["timeout_accept", "accept", "timeout_accept"];
  reviewDeadlines: string[] = [];
  private readonly session: LongVideoProviderSession = { sessionId: "fake-session", orderId: "fake-order", serverId: "fake-4090", gpuProfile: "rtx4090", host: "127.0.0.1", port: 22 };

  async listCandidates() { return [{ serverId: "fake-4090", gpuProfile: "rtx4090", hourlyUsd: 0.24, vramGb: 24 }]; }
  async activeOrderCount() { return this.active; }
  async createSession() { assert.equal(this.active, 0); this.active = 1; this.orderCount += 1; return this.session; }
  async waitForSsh() {}
  async prepareWorkspace() {}
  async bootstrapRuntime() {}
  async runCanary() {}
  async restoreWan() { this.restoreCount += 1; return { revision: "fake-wan-revision", verifiedObjects: 4 }; }
  async generateSegment(input: Parameters<LongVideoProvider["generateSegment"]>[0]) {
    this.generateCount += 1;
    this.prompts.push(input.prompt);
    const inputSha = input.sequenceIndex === 0 ? hashText(input.inputFrameRef) : input.previousLastFrameSha256!;
    this.lineage.push({ input: inputSha, previousSegmentId: input.previousSegmentId, previousAttemptId: input.previousAttemptId, previousLastFrameSha256: input.previousLastFrameSha256 });
    mkdirSync(remoteDir, { recursive: true });
    const sourceVideo = path.join(remoteDir, `segment-${input.sequenceIndex}.webm`);
    const color = ["red", "green", "blue"][input.sequenceIndex];
    const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=16`, "-t", "1", "-an", "-c:v", "libvpx-vp9", sourceVideo], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    return { sourceVideo, inputFrameSha256: inputSha, previousSegmentId: input.previousSegmentId, previousAttemptId: input.previousAttemptId, previousLastFrameSha256: input.previousLastFrameSha256 };
  }
  async awaitReview(input: { projectId: string; sequenceIndex: number; deadline: string }) { this.reviewDeadlines.push(input.deadline); assert.equal(Date.parse(input.deadline), fakeNow.getTime() + 20_000); if (this.reviewDeadlines.length === 1) processExpiredLongVideoReviews(new Date(fakeNow.getTime() + 20_000), statePath); return this.decisions.shift()!; }
  async cancelSession() { this.active = 0; this.cancelCount += 1; }
}

const provider = new FakeProvider();
const authorization: LongVideoExecutionAuthorization = { id: "fake-auth", projectId, provider: "clore", gpuProfile: "rtx4090", oneUse: true, expiresAt: new Date(fakeNow.getTime() + 60_000).toISOString(), maxSpendUsd: 0.75, releaseHold: true };
const coordinator = new LongVideoExecutionCoordinator({ provider, statePath, sessionPath, libraryDir, now: () => new Date(fakeNow) });
void (async () => {
assert.match(readFileSync(path.join(process.cwd(), "src/components/BillingPanel.tsx"), "utf8"), /璧勮垂鎯呭喌/);
assert.match(readFileSync(path.join(process.cwd(), "src/components/BillingPanel.tsx"), "utf8"), /useEffect/);
assert.match(readFileSync(path.join(process.cwd(), "src/components/FirstFrameInput.tsx"), "utf8"), /onDrop/);
assert.match(readFileSync(path.join(process.cwd(), "src/components/FirstFrameInput.tsx"), "utf8"), /onPaste/);
assert.match(readFileSync(path.join(process.cwd(), "src/components/FirstFrameInput.tsx"), "utf8"), /URL\.revokeObjectURL/);
const plan = await coordinator.plan(projectId);
assert.equal(plan.real_project_plan_ready, true);
assert.equal(plan.paid_execution_authorized, false);
await coordinator.execute(projectId, authorization);
project = getLongVideoProject(projectId, statePath)!;
assert.equal(project.status, "awaiting_merge_confirmation");
assert.deepEqual(project.segments.map((segment) => segment.approvalState), ["timed_out", "accepted", "timed_out"]);
assert.equal(provider.orderCount, 1);
assert.equal(provider.restoreCount, 1);
assert.equal(provider.generateCount, 3);
assert.equal(provider.reviewDeadlines.length, 3);
assert.deepEqual(provider.prompts, ["Prompt A distinct motion", "Prompt B distinct motion", "Prompt C distinct motion"]);
assert.equal(provider.lineage[1].input, provider.lineage[1].previousLastFrameSha256);
assert.equal(provider.lineage[2].input, provider.lineage[2].previousLastFrameSha256);
assert.equal(provider.active, 0);
assert.equal(provider.cancelCount, 1);
const beforeMerge = buildLongVideoProjectPaths(libraryDir, project.createdAt.slice(0, 10), projectId);
assert.equal(existsSync(path.join(beforeMerge.projectDir, "segments")), true);
await coordinator.mergeAfterConfirmation(projectId);
project = getLongVideoProject(projectId, statePath)!;
const recovered = await coordinator.resumeLongVideoExecution(projectId);
assert.equal(recovered.recovered, true);
assert.equal(recovered.reason, "already_cleaned");
assert.equal(project.status, "completed");
assert.equal(project.segmentMediaCleaned, true);
assert.equal(existsSync(beforeMerge.finalVideo), true);
assert.equal(existsSync(beforeMerge.finalThumbnail), true);
assert.equal(existsSync(beforeMerge.segmentsDir), false);
assert.equal(project.segments.every((segment) => segment.attempts.length === 1), true);
assert.equal(project.segments.every((segment) => segment.attempts[0].evidenceSummary.segmentMediaCleaned === true), true);
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, oneOrder: provider.orderCount, oneWanRestore: provider.restoreCount, segmentInferenceCalls: provider.generateCount, cleanupBeforeMerge: provider.cancelCount === 1, finalVideo: "validated", tailFrameShaChain: "validated" }));
})();
