import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isManualCandidateDisplayPriceAllowed, LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR } from "../src/lib/local-lab/gpu-price-filter";

const studio = readFileSync("src/components/LocalCreationStudio.tsx", "utf8");
const execution = readFileSync("src/lib/generation/gpu-execution-state.ts", "utf8");
const cloreConsole = readFileSync("src/lib/local-lab/clore-console.ts", "utf8");
const source = `${studio}\n${execution}`;
for (const text of ["生成队列", "待确认", "等待显卡", "正在准备主机", "恢复图片模型", "生成图片", "恢复视频模型", "生成视频", "下载并转码", "已完成", "失败", "确认生成", "开始任务并租用显卡", "取消", "删除", "重新生成", "预计会话", "预计计算费", "任务池视频缩略图", "重启应用后仍可播放本地 MP4"]) assert.ok(source.includes(text), `missing Chinese queue text: ${text}`);
assert.ok(!studio.includes("立即生成"), "the removed immediate-generation action must not return");
assert.ok(!studio.includes("Queue scheduler"));
assert.equal(LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR, 5, "the sidebar GPU price ceiling must be $5/hour");
assert.ok(isManualCandidateDisplayPriceAllowed(5), "the sidebar must include the $5 ceiling");
assert.ok(!isManualCandidateDisplayPriceAllowed(5.01), "the sidebar must reject candidates above the $5 ceiling");
assert.ok(studio.includes("isManualCandidateDisplayPriceAllowed"), "the sidebar must validate against the shared display ceiling");
assert.ok(cloreConsole.includes("manualCandidateBasePriceCeiling"), "read-only candidates must use the shared effective-price ceiling");
console.log("Chinese image/video queue UI text tests passed.");
