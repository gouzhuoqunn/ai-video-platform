import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const studio = readFileSync("src/components/LocalCreationStudio.tsx", "utf8");
for (const text of ["生成队列", "待确认", "等待凑批", "等待显卡", "正在部署", "正在生成", "已完成", "失败", "确认生成", "立即生成", "取消", "删除", "重新生成", "预计最高会话费用", "市场监控"]) assert.ok(studio.includes(text), `missing Chinese queue text: ${text}`);
assert.ok(!studio.includes("Queue scheduler"));
console.log("Chinese image/video queue UI text tests passed.");
