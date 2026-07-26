import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { mutateImageTasks, type LocalImageTask } from "../src/lib/image-generation/local-image-task-store";

const root = mkdtempSync(path.join(os.tmpdir(), "image-task-controls-"));
process.env.AI_IMAGE_TASK_STORE_PATH = path.join(root, "tasks.json"); process.env.AI_IMAGE_LIBRARY_ROOT = path.join(root, "images"); process.env.LOCAL_LAB_ENABLED = "true"; process.env.NEXT_PUBLIC_APP_MODE = "local_lab";
const browserPath = process.env.SYSTEM_CHROMIUM_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
function fixture(groupId: string, gpu: "rtx4090" | "rtx5090", prompt: string): LocalImageTask { const now = new Date().toISOString(); return { id: randomUUID(), status: "pending_confirmation", prompt, referenceImage: null, width: gpu === "rtx4090" ? 768 : 1536, height: gpu === "rtx4090" ? 768 : 1536, steps: 30, cfg: 4, loraStrength: .8, sampler: "FlowMatch", seed: 1, gpuClass: gpu, mode: "text_generation", modelStack: {}, attempts: 0, createdAt: now, updatedAt: now, groupId, groupIndex: 1, groupRequestedCount: 1, groupTitle: "旧短标题不应限制提示词", groupCreatedAt: now }; }
async function waitFor(url: string) { for (let i = 0; i < 150; i += 1) { try { if ((await fetch(url)).ok) return; } catch { /* wait */ } await new Promise((resolve) => setTimeout(resolve, 200)); } throw new Error("local_ui_not_ready"); }
async function main() {
  const firstId = randomUUID(); const secondId = randomUUID(); const longPrompt = "完整提示词标题会按活动任务卡片的可用宽度换行显示，而不会被旧的短标题规则截断"; mutateImageTasks(() => ({ tasks: [fixture(firstId, "rtx4090", longPrompt), fixture(secondId, "rtx5090", "第二个完整提示词标题")], value: null }));
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3101"], { cwd: process.cwd(), env: process.env, stdio: "ignore", windowsHide: true });
  try {
    await waitFor("http://127.0.0.1:3101"); const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); await page.goto("http://127.0.0.1:3101", { waitUntil: "networkidle" });
      assert.equal(await page.getByLabel("分辨率绘制网格").count(), 1); assert.equal(await page.getByRole("button", { name: "1024 × 1024", exact: true }).count(), 0); assert.equal(await page.getByLabel("连续生成张数").count(), 1);
      const grid = page.getByLabel("分辨率绘制网格"); await grid.getByRole("button", { name: "4 by 4 grid cell" }).click(); await page.waitForTimeout(100); assert.match(await grid.innerText(), /1024 × 1024/);
      const cards = page.locator('[role=button][aria-label$="活动任务组"]'); assert.equal(await cards.count(), 2); await cards.nth(0).click(); await cards.nth(1).click(); assert.equal(await cards.nth(0).getAttribute("aria-pressed"), "true"); assert.equal(await cards.nth(1).getAttribute("aria-pressed"), "true"); assert.match(await cards.nth(0).locator("p.line-clamp-2").innerText(), /完整提示词标题/); assert.equal(await page.getByLabel("已选任务组详情").count(), 0);
      assert.match(await page.getByLabel("显卡状态").innerText(), /RTX 4090 任务/); assert.match(await page.getByLabel("显卡状态").innerText(), /RTX 5090 任务/); assert.equal(await page.getByRole("button", { name: /确认生成 RTX 4090 任务/ }).count(), 1); assert.equal(await page.getByRole("button", { name: /确认生成 RTX 5090 任务/ }).count(), 1);
      const response = page.waitForResponse((value) => value.request().method() === "POST" && value.url().includes("/api/local-lab/image-tasks")); await cards.nth(0).getByRole("button", { name: "确认生成", exact: true }).click(); assert.ok((await response).ok()); assert.equal(await cards.nth(1).getAttribute("aria-pressed"), "true");
      await page.getByRole("button", { name: /确认生成（1）/ }).click(); await page.waitForTimeout(150); assert.match(await cards.nth(1).innerText(), /等待显卡/);
      console.log("image-task-controls-visual-acceptance: ok");
    } finally { await browser.close(); }
  } finally { next.kill(); rmSync(root, { recursive: true, force: true }); }
}
void main();
