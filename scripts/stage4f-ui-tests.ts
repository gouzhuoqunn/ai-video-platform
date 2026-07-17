import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

const studio = source("src/components/LocalCreationStudio.tsx");
const route = source("src/app/api/local-lab/generation-pool/route.ts");
const pool = source("src/lib/generation/task-pool.ts");
const pipeline = source("src/lib/generation/production-pipeline.ts");
const schedulerPolicy = source("src/lib/generation/scheduler-policy.ts");
const readiness = JSON.parse(source("comfy-runtime/production-readiness.json")) as Record<string, boolean>;

for (const label of [
  "图片", "视频", "可选负面提示词", "尺寸", "种子", "先生成图片", "选择已有图片",
  "创建待确认任务", "立即生成", "来源图片", "队列第", "重试失败步骤", "重新生成",
  "立即停止并退租", "完成当前任务后退租", "取消未开始任务",
]) {
  assert.ok(studio.includes(label), `Chinese daily-use control is missing: ${label}`);
}

for (const phase of [
  "pending_confirmation", "waiting_for_batch", "waiting_for_gpu", "provisioning", "restoring_image_model",
  "generating_image", "unloading_image_model", "restoring_video_model", "generating_video",
  "downloading_transcoding", "completed", "failed",
]) {
  assert.ok(studio.includes(phase), `Chinese status mapping is missing: ${phase}`);
}

assert.match(route, /createNormalJobSet/);
assert.match(route, /video_from_generated_image/);
assert.match(route, /video_from_existing_image/);
assert.match(route, /existingImageVerified/);
assert.match(route, /provider_authorization_created: false/);
assert.match(route, /credit_charged: false/);
assert.match(route, /requestSessionShutdown/);
assert.match(pool, /inputImageJobId: string \| null/);
assert.match(pool, /maximumWaitMinutes/);
assert.match(pool, /planSequentialProductionSession/);
assert.match(pool, /retryGenerationTasks/);
assert.match(pool, /regenerateGenerationTasks/);
assert.match(pool, /classifyProductionSessionRecovery/);
assert.match(pipeline, /creationFeeCaveat/);
assert.match(schedulerPolicy, /maximumActiveOrders: 1/);
assert.match(pipeline, /userLocalDownloadBytesExcluded: true/);

for (const normalSource of [route, pool]) {
  assert.doesNotMatch(normalSource, /stage4a|stage4e|final-production|20260715|29167/i);
}

assert.equal(readiness.model_cache_ready, true);
assert.equal(readiness.gpu_inference_verified, true);
assert.equal(readiness.normal_ui_pipeline_implemented, true);
assert.equal(readiness.normal_ui_pipeline_gpu_verified, false);
assert.equal(readiness.daily_use_release_candidate, true);
assert.equal(readiness.production_ready, false);

console.log("Stage 4F Chinese daily-use controls, queue actions, shutdown, normal identifiers, readiness semantics, and API safety tests passed.");
