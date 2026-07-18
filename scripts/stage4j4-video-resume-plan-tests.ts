import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const PROJECT_ID = "a6cbf8c1-f158-4583-8f40-fa524dddd9d1";
const SEGMENT_0_ID = "9e5f4d03-5233-4612-a375-01251c9c230a";
const SEGMENT_0_ATTEMPT = "b94faa26-e434-4c38-a67c-bacbb3bd51a6";
const SEGMENT_1_ID = "554adaa8-fc5f-40c3-a02b-331eabcd23c8";
const SEGMENT_1_JOB = "4aef1e01-ec3e-40cb-936d-5b6c1e29d68c";
const IMAGE_A = "d3573f65-1400-4a27-9bcf-4ff6f8f34273";
const IMAGE_B = "8cdc12f3-cc75-43dc-ae49-423071389f07";
const IMAGE_A_SHA = "c79c99476486fdcd83dbdc0cb7e90e2961ebdda85fe556a1c1a10be2558e6078";
const IMAGE_B_SHA = "d3b12a75c5b30086f2dec902d4d9e7e38f8418a8436c64cbca97d765623b32ac";
const SEGMENT_0_SHA = "4d72d09d12f2bf7a40e6ab49f29cc963e002bcab3d3ec2046126aef2307758d9";
const LAST_FRAME_SHA = "6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a";

function sha256(filePath: string) {
  assert.ok(existsSync(filePath), `missing durable media: ${path.basename(filePath)}`);
  assert.ok(statSync(filePath).size > 0, `empty durable media: ${path.basename(filePath)}`);
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const state = JSON.parse(readFileSync(path.join(process.cwd(), ".secrets", "long-video-state.json"), "utf8")) as { projects: Array<Record<string, unknown> & { id: string; status: string; nextSegmentIndex: number; segments: Array<Record<string, unknown> & { id: string; status: string; attemptsCount: number; attempts: Array<Record<string, unknown>>; inputFrameRef: string | null; generationJobId: string | null }> }> };
const batch = JSON.parse(readFileSync(path.join(process.cwd(), ".secrets", "stage4j1-batch.json"), "utf8")) as { batchId: string; imageJobs: string[]; longVideoProjectId: string; paidExecutionAuthorized: boolean };
const project = state.projects.find((candidate) => candidate.id === PROJECT_ID);
assert.ok(project);
assert.equal(project.status, "failed");
assert.equal(project.nextSegmentIndex, 1);
assert.equal(batch.batchId, "stage4j1-final-5090-20260718");
assert.deepEqual(batch.imageJobs, [IMAGE_A, IMAGE_B]);
assert.equal(batch.longVideoProjectId, PROJECT_ID);
assert.equal(batch.paidExecutionAuthorized, false);

const segment0 = project.segments[0];
const segment1 = project.segments[1];
assert.equal(segment0.id, SEGMENT_0_ID);
assert.equal(segment0.status, "accepted");
assert.equal(segment0.attemptsCount, 1);
assert.equal(segment0.attempts[0]?.id, SEGMENT_0_ATTEMPT);
assert.equal(segment1.id, SEGMENT_1_ID);
assert.equal(segment1.generationJobId, SEGMENT_1_JOB);
assert.equal(segment1.status, "ready");
assert.equal(segment1.attemptsCount, 0);
assert.deepEqual(segment1.attempts, []);
assert.equal(segment1.inputFrameRef, `segments/000/attempts/${SEGMENT_0_ATTEMPT}/last-frame.png`);

const imageRoot = "D:\\AI-Creative-Library\\2026-07-18";
const videoRoot = `D:\\AI-Video-Library\\2026-07-18\\${PROJECT_ID}\\segments\\000\\attempts\\${SEGMENT_0_ATTEMPT}`;
assert.equal(sha256(path.join(imageRoot, IMAGE_A, "output.png")), IMAGE_A_SHA);
assert.equal(sha256(path.join(imageRoot, IMAGE_B, "output.png")), IMAGE_B_SHA);
assert.equal(sha256(path.join(videoRoot, "output.mp4")), SEGMENT_0_SHA);
assert.equal(sha256(path.join(videoRoot, "last-frame.png")), LAST_FRAME_SHA);

const plan = readFileSync(path.join(process.cwd(), "docs", "post-launch-tests", "FINAL_VIDEO_RESUME_PLAN.md"), "utf8");
for (const flag of [
  "completed_rtx5090_images_reused=true",
  "image_jobs_to_generate=0",
  "image_model_restore_required=false",
  "segment_0_reused=true",
  "segment_0_inference_required=false",
  "segment_0_media_valid=true",
  "segment_0_last_frame_valid=true",
  "segment_1_attempts=0",
  "segment_1_inference_required=true",
  "wan_restore_required=true",
  "video_segments_to_generate=1",
  "short_video_tests=0",
  "expected_provider_orders=1",
  "paid_execution_authorized=false",
]) assert.ok(plan.includes(`\`${flag}\``), `missing plan flag ${flag}`);
assert.match(plan, /Hard proposed wallet-delta cap: `\$1\.25`/);
assert.match(plan, /Do not restore UltraReal/);
assert.match(plan, /Submit segment 1 once/);

console.log(JSON.stringify({
  ok: true,
  projectId: PROJECT_ID,
  image_jobs_to_generate: 0,
  segment_0_reused: true,
  segment_1_attempts: 0,
  video_segments_to_generate: 1,
  expected_provider_orders: 1,
  paid_execution_authorized: false,
  proposed_wallet_delta_cap_usd: 1.25,
}));
