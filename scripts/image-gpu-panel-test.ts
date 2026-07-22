import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const studio = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
const route = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8");

assert.match(studio, /显卡状态/);
assert.match(studio, /lg:grid-cols-\[320px_minmax\(0,1fr\)_360px\]/);
assert.match(studio, /lg:hidden/);
assert.match(studio, /图像任务池/);
assert.match(studio, /最高时价/);
assert.match(studio, /开始 \{selectedBatch\.length\} 个任务并租用显卡/);
assert.match(studio, /复制错误/);
assert.match(studio, /查看详细配置/);
assert.match(studio, /task\.result/);
assert.match(route, /runner-session\.json/);
assert.match(route, /preferences\.json/);
assert.match(route, /executionReady: blocker === null/);
assert.match(route, /图像执行器尚未通过完整发布校验/);
assert.match(route, /mixed_gpu_classes_are_not_allowed/);
assert.match(route, /FLUX Kontext 执行器尚未完成/);
assert.doesNotMatch(studio, /LongVideoStudio|视频任务池/);

console.log("image GPU panel contract: ok");
