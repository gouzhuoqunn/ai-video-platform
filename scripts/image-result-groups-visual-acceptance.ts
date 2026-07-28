import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";
import type { LocalImageTask } from "../src/lib/image-generation/local-image-task-store";

const browserPath = process.env.SYSTEM_CHROMIUM_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function task(groupId: string, index: number, status: LocalImageTask["status"]): LocalImageTask {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status,
    prompt: `group ${groupId}`,
    referenceImage: null,
    width: 768,
    height: 768,
    steps: 30,
    cfg: 4,
    loraStrength: .8,
    sampler: "FlowMatch",
    seed: index,
    mode: "text_generation",
    gpuClass: "rtx4090",
    modelStack: {},
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    groupId,
    groupIndex: index,
    groupRequestedCount: 5,
    groupCreatedAt: now,
    groupTitle: `组 ${groupId.slice(0, 6)}`,
  };
}

function completed(input: LocalImageTask): LocalImageTask {
  return {
    ...input,
    status: "completed",
    result: {
      relativeDir: "fixture",
      pngSha256: "a".repeat(64),
      pngBytes: 128,
      width: 768,
      height: 768,
      completedAt: new Date().toISOString(),
    },
  };
}

async function isReady(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string) {
  for (let index = 0; index < 150; index += 1) {
    if (await isReady(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("visual_server_timeout");
}

async function main() {
  const activeId = randomUUID();
  const resultId = randomUUID();
  const active = [task(activeId, 1, "waiting_for_gpu"), task(activeId, 2, "generating"), task(activeId, 3, "failed")];
  const results = [1, 2, 3, 4, 5].map((index) => completed(task(resultId, index, "completed")));
  let tasks = [...active, ...results];
  const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: { r: 40, g: 80, b: 160 } } }).png().toBuffer();
  const thumbnail = await sharp(png).resize(256, 256).webp().toBuffer();
  let next: ChildProcess | null = null;
  let baseUrl = process.env.IMAGE_STUDIO_TEST_URL ?? "http://127.0.0.1:3000";
  if (!(await isReady(baseUrl))) {
    baseUrl = "http://127.0.0.1:3101";
    next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3101"], {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_LAB_ENABLED: "true", NEXT_PUBLIC_APP_MODE: "local_lab" },
      stdio: "ignore",
      windowsHide: true,
    });
    await waitFor(baseUrl);
  }

  const responsePayload = () => ({
    tasks,
    runner: { state: "idle", stage: "当前未租用显卡", frozenTaskIds: [], host: null },
    executionReadiness: { rtx4090: { ready: true, blocker: null }, rtx5090: { ready: false, blocker: "测试夹具未发布 RTX 5090" } },
    executableBatches: {
      rtx4090: { plannedTaskIds: active.filter((item) => item.status === "waiting_for_gpu").map((item) => item.id), executableCount: 1, excludedInconsistentTaskIds: [] },
      rtx5090: { plannedTaskIds: [], executableCount: 0, excludedInconsistentTaskIds: [] },
    },
    maxHourlyPrice: .3,
  });

  let regenerationPosts = 0;
  let regenerationBody: Record<string, unknown> | null = null;
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.route("**/api/local-images/**", async (route) => {
      const output = route.request().url().endsWith("/output");
      await route.fulfill({ status: 200, contentType: output ? "image/png" : "image/webp", body: output ? png : thumbnail });
    });
    await page.route("**/api/local-lab/image-tasks*", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responsePayload()) });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.action !== "regenerate_group") {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unexpected_fixture_mutation" }) });
        return;
      }
      regenerationPosts += 1;
      regenerationBody = body;
      const requestedCount = Number(body.requestedCount);
      const prompt = String(body.prompt);
      const now = new Date().toISOString();
      const children = Array.from({ length: requestedCount }, (_, offset) => ({
        ...task(resultId, 6 + offset, "pending_confirmation"),
        prompt,
        groupRequestedCount: 5 + requestedCount,
        createdAt: now,
        updatedAt: now,
      }));
      tasks = [...children, ...tasks];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...responsePayload(), groupId: resultId, createdTaskIds: children.map((child) => child.id) }) });
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const tabs = page.locator("nav button");
    assert.equal(await tabs.count(), 2);
    assert.equal(await page.getByRole("button", { name: /活动任务组$/ }).count(), 1);
    await tabs.nth(1).click();
    const grid = page.locator("main > section > div.grid");
    assert.equal(await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length), 9);
    const resultCard = grid.getByRole("button");
    assert.equal(await resultCard.count(), 1);
    assert.equal(await resultCard.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth > 0), true);

    await resultCard.click();
    const dialog = page.getByRole("dialog", { name: "图像成果详情" });
    assert.equal(await dialog.count(), 1);
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.equal(await dialog.locator("button").count() >= 7, true);
    assert.equal(await dialog.locator('img[alt="原始成果图像"]').evaluate((image: HTMLImageElement) => image.naturalWidth > 0), true);
    const prompt = dialog.getByLabel("重新生成提示词");
    assert.match(await prompt.inputValue(), new RegExp(resultId));
    await prompt.fill("修改后用于重新生成的提示词");
    await page.waitForTimeout(100);
    assert.equal(regenerationPosts, 0);
    await dialog.getByLabel("重新生成张数").fill("3");
    const regeneration = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/local-lab/image-tasks"));
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    assert.ok((await regeneration).ok());
    assert.equal(regenerationPosts, 1);
    assert.deepEqual(regenerationBody, { action: "regenerate_group", groupId: resultId, requestedCount: 3, prompt: "修改后用于重新生成的提示词" });
    await page.waitForTimeout(250);
    assert.equal(await tabs.nth(0).getAttribute("aria-pressed"), "true");
    const cards = page.getByRole("button", { name: /活动任务组$/ });
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.evaluateAll((nodes) => nodes.filter((node) => node.getAttribute("aria-pressed") === "true").length), 1);
    console.log("image-result-groups-visual-acceptance: ok");
  } finally {
    await browser.close();
    next?.kill();
  }
}

void main();
