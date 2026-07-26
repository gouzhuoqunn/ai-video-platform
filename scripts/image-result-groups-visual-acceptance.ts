import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { publishLocalImageArtifact } from "../src/lib/image-generation/local-image-artifacts";
import { mutateImageTasks, type LocalImageTask } from "../src/lib/image-generation/local-image-task-store";

const root = mkdtempSync(path.join(os.tmpdir(), "image-result-groups-visual-"));
process.env.AI_IMAGE_TASK_STORE_PATH = path.join(root, "tasks.json");
process.env.AI_IMAGE_LIBRARY_ROOT = path.join(root, "images");
process.env.LOCAL_LAB_ENABLED = "true";
process.env.NEXT_PUBLIC_APP_MODE = "local_lab";
const browserPath = process.env.SYSTEM_CHROMIUM_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function task(groupId: string, index: number, status: LocalImageTask["status"]): LocalImageTask { const now = new Date().toISOString(); return { id: randomUUID(), status, prompt: `group ${groupId}`, referenceImage: null, width: 768, height: 768, steps: 30, cfg: 4, loraStrength: 0.8, sampler: "FlowMatch", seed: index, mode: "text_generation", gpuClass: "rtx4090", modelStack: {}, attempts: 0, createdAt: now, updatedAt: now, groupId, groupIndex: index, groupRequestedCount: 5, groupCreatedAt: now, groupTitle: `组 ${groupId.slice(0, 6)}` }; }
async function completed(input: LocalImageTask) { const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: { r: 40, g: 80, b: 160 } } }).png().toBuffer(); return { ...input, status: "completed" as const, result: await publishLocalImageArtifact({ task: input as never, png, root: process.env.AI_IMAGE_LIBRARY_ROOT, remote: { generationDurationSeconds: 0, orderId: "fixture", gpuModel: "fixture", controllerPromptId: null } }) }; }
async function waitFor(url: string) { for (let index = 0; index < 100; index += 1) { try { if ((await fetch(url)).ok) return; } catch { /* wait */ } await new Promise((resolve) => setTimeout(resolve, 200)); } throw new Error("visual_server_timeout"); }

async function main() {
  const activeId = randomUUID(); const resultId = randomUUID(); const active = [task(activeId, 1, "waiting_for_gpu"), task(activeId, 2, "generating"), task(activeId, 3, "failed")]; const results = await Promise.all([1, 2, 3, 4, 5].map(async (index) => completed(task(resultId, index, "completed"))));
  mutateImageTasks(() => ({ tasks: [...active, ...results], value: null }));
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3101"], { cwd: process.cwd(), env: process.env, stdio: "ignore", windowsHide: true });
  try {
    await waitFor("http://127.0.0.1:3101"); const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); await page.goto("http://127.0.0.1:3101", { waitUntil: "networkidle" });
      const tabs = page.locator("nav button"); assert.equal(await tabs.count(), 2); assert.equal(await page.getByRole("button", { name: /活动任务组$/ }).count(), 1); const activeCard = page.getByRole("button", { name: /活动任务组$/ }); await activeCard.click(); assert.equal(await activeCard.getAttribute("aria-pressed"), "true"); assert.equal(await page.getByLabel("已选任务组详情").count(), 1);
      await tabs.nth(1).click(); const grid = page.locator("main > section > div.grid"); assert.equal(await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length), 9); const resultCard = grid.getByRole("button"); assert.equal(await resultCard.count(), 1); await resultCard.dblclick(); const dialog = page.getByRole("dialog"); assert.equal(await dialog.count(), 1); assert.equal(await dialog.locator("button").count() >= 7, true); await dialog.getByLabel("重新生成张数").fill("3"); const regeneration = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/local-lab/image-tasks")); await dialog.locator("button").last().click(); assert.ok((await regeneration).ok()); await page.waitForTimeout(250); assert.equal(await tabs.nth(0).getAttribute("aria-pressed"), "true"); const cards = page.getByRole("button", { name: /活动任务组$/ }); assert.equal(await cards.count(), 2); assert.equal(await cards.evaluateAll((nodes) => nodes.filter((node) => node.getAttribute("aria-pressed") === "true").length), 1); console.log("image-result-groups-visual-acceptance: ok");
    } finally { await browser.close(); }
  } finally { next.kill(); rmSync(root, { recursive: true, force: true }); }
}

main();
