import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(file: string) { return readFileSync(file, "utf8"); }

const studio = source("src/components/LocalCreationStudio.tsx");
const longStudio = source("src/components/LongVideoStudio.tsx");
const projectRoute = source("src/app/api/local-lab/long-video/[projectId]/route.ts");
const mediaRoute = source("src/app/api/local-lab/long-video/[projectId]/media/[kind]/route.ts");
const readiness = JSON.parse(source("comfy-runtime/production-readiness.json")) as Record<string, boolean>;

for (const label of ["长视频", "上传首帧图片", "选择已验证图片", "纯提示词生成首帧", "segmentLabel", "确认并继续", "重新生成本段", "暂停长视频", "确认合并长视频", "上一段", "下一段", "复制上一段", "清空"]) {
  assert.ok(longStudio.includes(label) || studio.includes(label), `missing long-video Chinese control: ${label}`);
}
assert.match(longStudio, /approvalDeadline/);
assert.match(longStudio, /setInterval\(\(\) => setNow/);
assert.match(longStudio, /expectedProjectVersion/);
assert.match(longStudio, /segment-video/);
assert.match(projectRoute, /toPublicLongVideoProject/);
assert.match(projectRoute, /provider_authorization_created: false/);
assert.match(projectRoute, /deleteLongVideoProjectTasks/);
assert.match(mediaRoute, /content-range/);
assert.match(mediaRoute, /status: 206/);
assert.match(mediaRoute, /segment-last-frame/);
assert.equal(readiness.long_video_pipeline_implemented, true);
assert.equal(readiness.long_video_pipeline_gpu_verified, false);
assert.equal(readiness.production_ready, false);

console.log("Stage 4G Chinese long-video UI, server deadline controls, media Range safety, additive API state, and readiness semantics passed.");
