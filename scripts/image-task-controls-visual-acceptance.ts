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
function fixture(status: LocalImageTask["status"], groupId: string, index: number, count: number, prompt: string): LocalImageTask { const now = new Date().toISOString(); return { id: randomUUID(), status, prompt, referenceImage: null, width: 768, height: 768, steps: 30, cfg: 4, loraStrength: .8, sampler: "FlowMatch", seed: index, gpuClass: "rtx4090", mode: "text_generation", modelStack: {}, attempts: 0, createdAt: now, updatedAt: now, groupId, groupIndex: index, groupRequestedCount: count, groupTitle: prompt, groupCreatedAt: now }; }
async function waitFor(url: string) { for (let i = 0; i < 150; i += 1) { try { if ((await fetch(url)).ok) return; } catch { /* wait */ } await new Promise((resolve) => setTimeout(resolve, 200)); } throw new Error("local_ui_not_ready"); }
async function main() {
  const groupId = randomUUID(); const doneId = randomUUID(); const active = [fixture("pending_confirmation", groupId, 1, 2, "紧凑活动任务标题"), fixture("pending_confirmation", groupId, 2, 2, "紧凑活动任务标题")]; const result = fixture("completed", doneId, 1, 1, "成果组"); result.result = { relativeDir: "fixture", pngSha256: "a".repeat(64), pngBytes: 1, width: 768, height: 768, completedAt: new Date().toISOString() };
  mutateImageTasks(() => ({ tasks: [...active, result], value: null }));
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3101"], { cwd: process.cwd(), env: process.env, stdio: "ignore", windowsHide: true });
  try {
    await waitFor("http://127.0.0.1:3101"); const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); await page.goto("http://127.0.0.1:3101", { waitUntil: "networkidle" });
      const tabs = page.locator("nav button"); assert.equal(await tabs.count(), 2); assert.match(await tabs.nth(0).innerText(), /提示词/); assert.match(await tabs.nth(1).innerText(), /成果/);
      assert.equal(await page.getByLabel("分辨率绘制网格").count(), 1); assert.equal(await page.getByRole("button", { name: "1024 × 1024", exact: true }).count(), 0); assert.equal(await page.getByLabel("自定义宽度").count(), 0); assert.equal(await page.getByLabel("连续生成张数").count(), 1);
      const grid = page.getByLabel("分辨率绘制网格"); await grid.getByRole("button", { name: "4 by 4 grid cell" }).click(); await page.waitForTimeout(100); assert.match(await grid.innerText(), /1024 × 1024/);
      const card = page.getByRole("button", { name: /紧凑活动任务标题 活动任务组/ }); assert.equal(await card.locator("button").count(), 0); await card.click(); assert.equal(await card.getAttribute("aria-pressed"), "true"); const detail = page.getByLabel("已选任务组详情"); assert.equal(await detail.count(), 1); assert.match(await detail.innerText(), /紧凑活动任务标题/); assert.equal(await detail.getByRole("button", { name: "确认生成", exact: true }).count(), 1); const positions = await Promise.all([detail.boundingBox(), card.boundingBox()]); assert.ok((positions[0]?.x ?? 999) < (positions[1]?.x ?? 0));
      await page.waitForTimeout(5_300); assert.equal(await card.getAttribute("aria-pressed"), "true"); const confirmation = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/local-lab/image-tasks")); await detail.getByRole("button", { name: "确认生成", exact: true }).click(); assert.ok((await confirmation).ok()); assert.match(await detail.innerText(), /等待显卡/);
      await tabs.nth(1).click(); assert.equal(await page.getByLabel("成果图库").count(), 1); assert.equal(await page.getByRole("button", { name: /成果组 成果组/ }).count(), 1);
      console.log("image-task-controls-visual-acceptance: ok");
    } finally { await browser.close(); }
  } finally { next.kill(); rmSync(root, { recursive: true, force: true }); }
}
void main();
