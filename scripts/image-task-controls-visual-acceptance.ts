import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import type { Locator } from "playwright";
import { mutateImageTasks, type LocalImageTask } from "../src/lib/image-generation/local-image-task-store";

const root = mkdtempSync(path.join(os.tmpdir(), "image-task-controls-"));
process.env.AI_IMAGE_TASK_STORE_PATH = path.join(root, "tasks.json");
process.env.AI_IMAGE_LIBRARY_ROOT = path.join(root, "images");
process.env.LOCAL_LAB_ENABLED = "true";
process.env.NEXT_PUBLIC_APP_MODE = "local_lab";
const browserPath = process.env.SYSTEM_CHROMIUM_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function fixture(status: LocalImageTask["status"], groupId: string, index: number, requested: number, prompt: string): LocalImageTask {
  const now = new Date().toISOString();
  return { id: randomUUID(), status, prompt, referenceImage: null, width: 768, height: 768, steps: 30, cfg: 4, loraStrength: 0.8, sampler: "FlowMatch", seed: 1000 + index, gpuClass: "rtx4090", mode: "text_generation", modelStack: {}, attempts: 0, createdAt: now, updatedAt: now, groupId, groupIndex: index, groupRequestedCount: requested, groupTitle: prompt.slice(0, 12), groupCreatedAt: now };
}

async function waitFor(url: string, logs: () => string) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch { /* wait */ } await new Promise((resolve) => setTimeout(resolve, 200)); } throw new Error(`local_ui_not_ready:${logs()}`); }

async function main() {
  const activeId = randomUUID(); const completedId = randomUUID(); const active = [fixture("pending_confirmation", activeId, 1, 2, "可交互活动组"), fixture("pending_confirmation", activeId, 2, 2, "可交互活动组")]; const completed = fixture("completed", completedId, 1, 1, "可重新生成成果组"); completed.result = { relativeDir: "fixture", pngSha256: "a".repeat(64), pngBytes: 1, width: 768, height: 768, completedAt: new Date().toISOString() };
  mutateImageTasks(() => ({ tasks: [...active, completed], value: null }));
  const output: string[] = [];
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3101"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  next.stdout?.on("data", (value) => output.push(String(value)));
  next.stderr?.on("data", (value) => output.push(String(value)));
  try {
    await waitFor("http://127.0.0.1:3101", () => output.join("").slice(-2_000));
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto("http://127.0.0.1:3101", { waitUntil: "networkidle" });
      const tabs = page.locator("nav button"); assert.equal(await tabs.count(), 2); assert.match(await tabs.nth(0).innerText(), /提示词/); assert.match(await tabs.nth(1).innerText(), /成果/);
      const activeCard = page.getByRole("button", { name: /活动任务组$/ }); await activeCard.click(); assert.equal(await activeCard.getAttribute("aria-pressed"), "true"); const detail = page.getByLabel("已选任务组详情"); assert.equal(await detail.count(), 1); assert.match(await detail.innerText(), /可交互活动组/); assert.match(await detail.innerText(), /待确认/);
      await page.waitForTimeout(5_300); assert.equal(await activeCard.getAttribute("aria-pressed"), "true"); assert.equal(await detail.count(), 1);
      const confirmation = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/local-lab/image-tasks")); await detail.getByRole("button", { name: "确认生成", exact: true }).click(); assert.ok((await confirmation).ok()); await expectText(detail, /等待显卡/);
      await page.getByRole("button", { name: "1024 × 1024", exact: true }).click(); await expectText(page.locator("section[aria-label=分辨率选择]"), /当前分辨率：1024 × 1024/);
      await page.getByLabel("自定义宽度", { exact: true }).fill("1536"); await page.getByLabel("自定义高度", { exact: true }).fill("1536"); await page.getByRole("button", { name: "应用自定义分辨率", exact: true }).click(); await expectText(page.locator("section[aria-label=分辨率选择]"), /需要 RTX 5090/); assert.equal(await page.getByRole("button", { name: /1536 × 1536/ }).isDisabled(), true);
      assert.equal(await page.getByLabel("本地程序").count(), 1); assert.equal(await page.getByLabel("云端显卡").count(), 1); await expectText(page.getByLabel("云端显卡"), /未租用/);
      await tabs.nth(1).click(); const resultCard = page.getByRole("button", { name: /成果组$/ }); assert.equal(await resultCard.count(), 1); await resultCard.dblclick(); const dialog = page.getByRole("dialog"); assert.equal(await dialog.count(), 1); await dialog.getByLabel("重新生成张数").fill("2"); const regenerate = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/local-lab/image-tasks")); await dialog.getByRole("button", { name: "确认", exact: true }).click(); assert.ok((await regenerate).ok()); await page.waitForTimeout(300); assert.equal(await page.getByRole("dialog").count(), 0); assert.equal(await tabs.nth(0).getAttribute("aria-pressed"), "true"); const regeneratedCard = page.getByRole("button", { name: /活动任务组$/ }).filter({ hasText: "可重新生成成果组" }); assert.equal(await regeneratedCard.count(), 1); assert.equal(await regeneratedCard.getAttribute("aria-pressed"), "true"); await page.getByLabel("已选任务组详情").getByRole("button", { name: "取消任务", exact: true }).click(); await page.waitForTimeout(300); assert.equal(await page.getByRole("button", { name: /活动任务组$/ }).filter({ hasText: "可重新生成成果组" }).count(), 0);
      console.log("image-task-controls-visual-acceptance: ok");
    } finally { await browser.close(); }
  } finally { next.kill(); rmSync(root, { recursive: true, force: true }); }
}

async function expectText(locator: Locator, pattern: RegExp) { await locator.waitFor({ state: "visible" }); assert.match(await locator.innerText(), pattern); }

main();
