import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createNormalJobSet, armSpecificGenerationBatch, upsertGenerationTasks, readGenerationPool } from "../src/lib/generation/task-pool";
import { persistLongVideoProject, confirmLongVideoProject, getLongVideoProject, listLongVideoProjects } from "../src/lib/long-video/store";
import { readDeploymentResolution, validateDeploymentResolution } from "./clore/deployment-resolution";

const BATCH_ID = "stage4j1-final-5090-20260718";
const PROMPTS_PATH = path.join(process.cwd(), "docs", "post-launch-tests", "TEST_PROMPTS.md");
const STATE_PATH = path.join(process.cwd(), ".secrets", "long-video-state.json");
const OUTPUT_PATH = path.join(process.cwd(), ".secrets", "stage4j1-batch.json");
const MEDIUM_PROMPT = "An adult woman landscape photographer in a rust-red jacket stands beside a quiet alpine lake at sunrise, wind moving loose hair and jacket fabric, slow natural breathing, cinematic documentary still, detailed water reflections, soft golden rim light, coherent hands and face, synthetic subject, no logos or brands.";
const HIGH_PROMPT = "The same adult woman landscape photographer adjusts a vintage tripod on a misty mountain ridge, scarf and hair moving in a clear breeze, focused expression, square editorial portrait, realistic fabric and skin texture, natural sunrise color, synthetic subject, no logos or brands.";
const VIDEO_OVERALL = "The same adult woman landscape photographer beside an alpine lake at sunrise, rust-red jacket, tripod visible, calm reflective water, synthetic subject, no brands.";
const SEGMENT_PROMPTS = ["She raises the camera, turns slightly toward the lake, and the breeze moves her hair and jacket while the tripod remains fixed; slow gentle dolly-in, preserve face and clothing continuity.", "Continue from the exact pose and lake composition; she takes one photograph, lowers the camera, and smiles subtly as mist drifts left; match the previous segment tail frame and lighting."];
const NEGATIVE = "child, teen, minor, celebrity, copyrighted character, logo, watermark, text, flicker, hard cuts, identity drift, extra fingers, malformed hands, unstable exposure";

function writeJson(value: unknown) { writeFileSync(OUTPUT_PATH, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }

if (!existsSync(PROMPTS_PATH) || !readFileSync(PROMPTS_PATH, "utf8").includes("50901001") || !readFileSync(PROMPTS_PATH, "utf8").includes("50902001")) throw new Error("acceptance_prompt_package_missing_or_malformed");
const resolution = readDeploymentResolution();
const checked = validateDeploymentResolution(resolution, BATCH_ID, resolution?.resolutionNonce);
if (!checked.valid || !resolution) throw new Error(`historical_pause_not_resolved:${checked.blockers.join(",")}`);
const existingTasks = readGenerationPool().tasks;
const imageA = existingTasks.find((task) => task.seed === 50901001 && task.generationType === "image") ?? createNormalJobSet({ jobForm: "image_only", prompt: MEDIUM_PROMPT, negativePrompt: NEGATIVE, seed: 50901001, sizePreset: "medium_image_5090", gpuPreference: ["rtx5090"], status: "waiting_for_batch" })[0];
const imageB = existingTasks.find((task) => task.seed === 50901002 && task.generationType === "image") ?? createNormalJobSet({ jobForm: "image_only", prompt: HIGH_PROMPT, negativePrompt: NEGATIVE, seed: 50901002, sizePreset: "high_image_5090", gpuPreference: ["rtx5090"], status: "waiting_for_batch" })[0];
upsertGenerationTasks([imageA, imageB]);
const prior = listLongVideoProjects().find((candidate) => candidate.title === "Stage 4J.1 RTX5090 10-second acceptance");
const project = prior ?? persistLongVideoProject({
  title: "Stage 4J.1 RTX5090 10-second acceptance",
  overallPrompt: VIDEO_OVERALL,
  firstFrameSource: "existing_image",
  firstFrameRef: `image:${imageA.id}`,
  targetDurationSeconds: 10,
  segments: SEGMENT_PROMPTS.map((prompt, sequenceIndex) => ({ sequenceIndex, startSecond: sequenceIndex * 5, endSecond: (sequenceIndex + 1) * 5, prompt })),
  gpuPreference: ["rtx5090"],
});
let prepared = project.status === "pending_confirmation" ? confirmLongVideoProject(project.id, project.version) : project;
const segmentTaskId = prepared.segments[0].generationJobId;
if (!segmentTaskId) throw new Error("long_video_boundary_task_missing");
const armed = armSpecificGenerationBatch([imageA.id, imageB.id, segmentTaskId], BATCH_ID);
prepared = getLongVideoProject(project.id)!;
const record = {
  schemaVersion: 1, batchId: BATCH_ID, resolutionNonce: resolution.resolutionNonce,
  imageJobs: [imageA.id, imageB.id], longVideoProjectId: project.id, videoSegmentCount: prepared.totalSegments,
  videoBoundaryTaskId: segmentTaskId, gpuClass: "rtx5090", imageA: { width: imageA.width, height: imageA.height, seed: imageA.seed, quality: "medium", performance: "faster" },
  imageB: { width: imageB.width, height: imageB.height, seed: imageB.seed, quality: "high", finalization: "upscale_or_refinement_expected" },
  video: { generationWidth: 1280, generationHeight: 720, finalWidth: 1920, finalHeight: 1080, frames: 81, fps: 16, seed: 50902001, audio: false, segmentPrompts: SEGMENT_PROMPTS, negativePrompt: NEGATIVE, firstFrameRef: `image:${imageA.id}` },
  tasksSelected: armed.scheduler.selectedTaskIds, preparedAt: new Date().toISOString(), paidExecutionAuthorized: false,
};
writeJson(record);
console.log(JSON.stringify({ final_5090_plan_ready: true, historical_pause_resolved: true, operator_resolution_recorded: true, prepared_image_jobs: 2, prepared_long_video_projects: 1, prepared_video_segments: prepared.totalSegments, short_video_tests: 0, gpu_class: "RTX5090", expected_provider_orders: 1, expected_image_model_restores: 1, expected_video_model_restores: 1, expected_image_outputs: 2, expected_720p_long_video_outputs: 1, expected_1080p_final_outputs: 1, native_1080p_expected: false, paid_execution_authorized: false, batch_id: BATCH_ID, image_job_ids: [imageA.id, imageB.id], long_video_project_id: prepared.id, selected_task_ids: armed.scheduler.selectedTaskIds }, null, 2));
