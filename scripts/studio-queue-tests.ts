import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const studio = readFileSync("src/components/LocalCreationStudio.tsx", "utf8");
for (const text of ["生成队列", "待确认", "等待凑批", "等待显卡", "正在准备主机", "恢复图片模型", "生成图片", "恢复视频模型", "生成视频", "下载并转码", "已完成", "失败", "确认生成", "立即生成", "取消", "删除", "重新生成", "预计会话", "预计计算费", "市场监控", "任务池视频缩略图", "重启应用后仍可播放本地 MP4"]) assert.ok(studio.includes(text), `missing Chinese queue text: ${text}`);
assert.ok(!studio.includes("Queue scheduler"));
console.log("Chinese image/video queue UI text tests passed.");
