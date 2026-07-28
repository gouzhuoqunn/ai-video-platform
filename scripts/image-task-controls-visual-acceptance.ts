import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import type { RegisteredLora } from "../src/lib/image-generation/image-loras";
import type { LocalImageTask } from "../src/lib/image-generation/local-image-task-store";

const browserPath = process.env.SYSTEM_CHROMIUM_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function fixture(groupId: string, gpu: "rtx4090" | "rtx5090", prompt: string): LocalImageTask {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status: "pending_confirmation",
    prompt,
    referenceImage: null,
    width: gpu === "rtx4090" ? 768 : 1536,
    height: gpu === "rtx4090" ? 768 : 1536,
    steps: 30,
    cfg: 4,
    loraStrength: .8,
    sampler: "FlowMatch",
    seed: 1,
    gpuClass: gpu,
    mode: "text_generation",
    modelStack: {},
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    groupId,
    groupIndex: 1,
    groupRequestedCount: 1,
    groupTitle: "旧短标题不应限制提示词",
    groupCreatedAt: now,
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
  throw new Error("local_ui_not_ready");
}

async function main() {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const addedLoraId = randomUUID();
  const longPrompt = "完整提示词标题会按活动任务卡片的可用宽度换行显示，而不会被旧的短标题规则截断";
  let tasks = [fixture(firstId, "rtx4090", longPrompt), fixture(secondId, "rtx5090", "第二个完整提示词标题")];
  const loraTimestamp = "2026-07-29T00:00:00.000Z";
  let registeredLoras: RegisteredLora[] = [
    {
      id: "builtin-aidma-nsfw-unlock",
      name: "画裸体LoRA",
      filename: "aidmaNSFWunlock-FLUX-V0.2.safetensors",
      defaultStrength: .8,
      defaultEnabled: true,
      availability: "ready",
      sha256: "1".repeat(64),
      sizeBytes: 19_268_648,
      source: { provider: "civitai", modelId: 1, versionId: 11, fileId: 111 },
      builtIn: true,
      createdAt: loraTimestamp,
      updatedAt: loraTimestamp,
    },
    {
      id: "builtin-male-anatomy-correction",
      name: "解决男人女器官LoRA",
      filename: "male-anatomy-correction.safetensors",
      defaultStrength: .85,
      defaultEnabled: false,
      availability: "ready",
      sha256: "2".repeat(64),
      sizeBytes: 20_000_000,
      source: { provider: "civitai", modelId: 2, versionId: 22, fileId: 222 },
      builtIn: true,
      createdAt: loraTimestamp,
      updatedAt: loraTimestamp,
    },
    {
      id: "builtin-masculine-muscle",
      name: "大肌肉阳刚LoRA",
      filename: "masculine-muscle.safetensors",
      defaultStrength: .75,
      defaultEnabled: false,
      availability: "ready",
      sha256: "3".repeat(64),
      sizeBytes: 21_000_000,
      source: { provider: "huggingface", repository: "fixture/loras", revision: "a".repeat(40), path: "masculine-muscle.safetensors" },
      builtIn: true,
      createdAt: loraTimestamp,
      updatedAt: loraTimestamp,
    },
  ];
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

  const responsePayload = () => {
    const waiting4090 = tasks.filter((task) => task.status === "waiting_for_gpu" && task.gpuClass === "rtx4090").map((task) => task.id);
    const waiting5090 = tasks.filter((task) => task.status === "waiting_for_gpu" && task.gpuClass === "rtx5090").map((task) => task.id);
    return {
      tasks,
      runner: { state: "idle", stage: "当前未租用显卡", frozenTaskIds: [], host: null },
      executionReadiness: { rtx4090: { ready: true, blocker: null }, rtx5090: { ready: false, blocker: "测试夹具未发布 RTX 5090" } },
      executableBatches: {
        rtx4090: { plannedTaskIds: waiting4090, executableCount: waiting4090.length, excludedInconsistentTaskIds: [] },
        rtx5090: { plannedTaskIds: waiting5090, executableCount: waiting5090.length, excludedInconsistentTaskIds: [] },
      },
      maxHourlyPrice: .3,
    };
  };

  let createPosts = 0;
  const createPayloads: Record<string, unknown>[] = [];
  let createGate: Promise<void> | null = null;
  let releaseCreate: (() => void) | null = null;
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    await page.route("**/api/local-lab/image-loras*", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: registeredLoras }) });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.action !== "add") {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unexpected_lora_fixture_mutation" }) });
        return;
      }
      if (String(body.sourceUrl).includes("invalid")) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "测试 LoRA 链接无效，没有保存任何文件。", code: "unsupported_lora_source_url" }) });
        return;
      }
      const item: RegisteredLora = {
        id: addedLoraId,
        name: String(body.name),
        filename: "newly-added.safetensors",
        defaultStrength: Number(body.defaultStrength),
        defaultEnabled: false,
        availability: "ready",
        sha256: "4".repeat(64),
        sizeBytes: 22_000_000,
        source: { provider: "huggingface", repository: "fixture/loras", revision: "b".repeat(40), path: "newly-added.safetensors" },
        builtIn: false,
        createdAt: loraTimestamp,
        updatedAt: loraTimestamp,
      };
      registeredLoras = [...registeredLoras, item];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ item, items: registeredLoras, message: "fixture_registered" }) });
    });
    await page.route("**/api/local-lab/image-tasks*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.searchParams.get("view") === "logs") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ logs: { filename: "image-studio-fixture.log", generatedAt: "2026-07-28T00:00:00.000Z", text: "stage=health\nstatus=ready", lineCount: 2, truncated: false, sanitized: true, sourceLabels: ["fixture"] } }) });
        return;
      }
      if (request.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responsePayload()) });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.action === "confirm_group") {
        const updatedAt = new Date().toISOString();
        tasks = tasks.map((task) => task.groupId === body.groupId && task.status === "pending_confirmation" ? { ...task, status: "waiting_for_gpu", updatedAt } : task);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...responsePayload(), groupAction: { confirmed: 1 } }) });
        return;
      }
      if (body.action === "create_group") {
        createPosts += 1;
        createPayloads.push(body);
        if (createGate) await createGate;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...responsePayload(), groupId: "fixture-created-group" }) });
        return;
      }
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unexpected_fixture_mutation" }) });
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const loraPanel = page.locator('section[aria-label="LoRA 管理"]');
    await loraPanel.getByText("画裸体LoRA", { exact: true }).waitFor();
    await loraPanel.getByRole("button", { name: "添加新的LoRA", exact: true }).click();
    const addLoraDialog = page.getByRole("dialog", { name: "添加新的 LoRA" });
    await addLoraDialog.getByLabel("显示名称").fill("测试新增LoRA");
    await addLoraDialog.getByLabel("Civitai 或 HuggingFace 链接").fill("https://civitai.com/models/invalid");
    await addLoraDialog.getByRole("button", { name: "校验并注册" }).click();
    const modalError = addLoraDialog.getByRole("alert");
    await modalError.waitFor({ state: "visible" });
    assert.match(await modalError.innerText(), /测试 LoRA 链接无效/);
    assert.equal(await loraPanel.locator(':scope > [role="alert"]').count(), 0, "open modal must not duplicate its error beneath the overlay");
    await addLoraDialog.getByLabel("Civitai 或 HuggingFace 链接").fill("https://huggingface.co/fixture/loras/blob/main/newly-added.safetensors");
    await addLoraDialog.getByRole("button", { name: "校验并注册" }).click();
    await addLoraDialog.waitFor({ state: "detached" });
    await loraPanel.getByText("测试新增LoRA", { exact: true }).waitFor({ state: "visible" });
    await loraPanel.getByLabel("启用 解决男人女器官LoRA").check();

    const promptTab = page.getByRole("button", { name: /^提示词/ });
    const restingStyle = await promptTab.evaluate((node) => ({ filter: getComputedStyle(node).filter, shadow: getComputedStyle(node).boxShadow }));
    await promptTab.hover();
    const hoverStyle = await promptTab.evaluate((node) => ({ filter: getComputedStyle(node).filter, shadow: getComputedStyle(node).boxShadow }));
    assert.notDeepEqual(hoverStyle, restingStyle);
    const box = await promptTab.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    assert.notEqual(await promptTab.evaluate((node) => getComputedStyle(node).transform), "none");
    await page.mouse.up();
    await promptTab.evaluate((node) => node.blur());
    await page.keyboard.press("Tab");
    const keyboardFocus = await page.evaluate(() => {
      const node = document.activeElement;
      return { tag: node?.tagName, outline: node ? getComputedStyle(node).outlineStyle : "none" };
    });
    assert.equal(keyboardFocus.tag, "BUTTON");
    assert.notEqual(keyboardFocus.outline, "none");

    assert.equal(await page.getByLabel("分辨率绘制网格").count(), 1);
    assert.equal(await page.getByRole("button", { name: "1024 × 1024", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("连续生成张数").count(), 1);
    const grid = page.getByLabel("分辨率绘制网格");
    await grid.getByRole("button", { name: "4 by 4 grid cell" }).click();
    await page.waitForTimeout(100);
    assert.match(await grid.innerText(), /1024 × 1024/);

    const cards = page.locator('[role=button][aria-label$="活动任务组"]');
    assert.equal(await cards.count(), 2);
    await cards.nth(0).click({ position: { x: 8, y: 8 } });
    await cards.nth(1).click({ position: { x: 8, y: 8 } });
    assert.equal(await cards.nth(0).getAttribute("aria-pressed"), "true");
    assert.equal(await cards.nth(1).getAttribute("aria-pressed"), "true");
    assert.match(await cards.nth(0).locator("p.line-clamp-2").innerText(), /完整提示词标题/);
    await cards.nth(1).focus();
    await page.keyboard.press("Enter");
    assert.equal(await cards.nth(1).getAttribute("aria-pressed"), "false");
    await page.keyboard.press("Space");
    assert.equal(await cards.nth(1).getAttribute("aria-pressed"), "true");

    assert.match(await page.getByLabel("显卡状态").innerText(), /RTX 4090 任务/);
    assert.match(await page.getByLabel("显卡状态").innerText(), /RTX 5090 任务/);
    const confirmation = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/local-lab/image-tasks"));
    await cards.nth(0).getByRole("button", { name: "确认生成", exact: true }).click();
    assert.ok((await confirmation).ok());
    assert.equal(await cards.nth(1).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: /确认生成（1）/ }).click();
    await page.waitForTimeout(150);
    assert.match(await cards.nth(1).innerText(), /等待显卡/);

    await page.getByRole("button", { name: "查看当下日志" }).click();
    const logDialog = page.getByRole("dialog", { name: "当下日志" });
    assert.equal(await logDialog.count(), 1);
    assert.match(await logDialog.locator("pre").innerText(), /stage=health/);
    await logDialog.getByRole("button", { name: "复制", exact: true }).click();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), "stage=health\nstatus=ready");
    const downloadEvent = page.waitForEvent("download");
    await logDialog.getByRole("button", { name: "下载", exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), "image-studio-fixture.log");
    const downloadedPath = await download.path();
    assert.ok(downloadedPath);
    assert.equal(readFileSync(downloadedPath, "utf8").replace(/\r\n/g, "\n"), "stage=health\nstatus=ready");
    await page.keyboard.press("Escape");
    assert.equal(await logDialog.count(), 0);

    createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const promptInput = page.getByRole("textbox", { name: "提示词", exact: true });
    const negativePromptInput = page.getByRole("textbox", { name: "负面提示词", exact: true });
    await promptInput.fill("第一次提交的提示词");
    await negativePromptInput.fill("测试负面提示词");
    const createButton = promptInput.locator("xpath=ancestor::section[1]").locator("button").last();
    await createButton.evaluate((node) => { node.click(); node.click(); });
    await page.waitForTimeout(100);
    assert.equal(createPosts, 1);
    assert.equal(createPayloads.length, 1);
    assert.equal(createPayloads[0].negativePrompt, "测试负面提示词");
    const submittedLoras = createPayloads[0].loras as Array<{ id: string; enabled: boolean }>;
    assert.deepEqual(submittedLoras.map((item) => item.id), [
      "builtin-aidma-nsfw-unlock",
      "builtin-male-anatomy-correction",
      "builtin-masculine-muscle",
      addedLoraId,
    ]);
    assert.deepEqual(
      submittedLoras.map((item) => item.enabled),
      [true, true, false, false],
      "the task snapshot must preserve disabled LoRAs while runtime filtering remains downstream",
    );
    assert.equal(await createButton.getAttribute("aria-busy"), "true");
    assert.equal(await createButton.isDisabled(), true);
    assert.equal(await page.getByText("正在处理，请勿重复点击…").count(), 1);
    await promptInput.fill("等待期间新输入的提示词");
    assert.ok(releaseCreate);
    releaseCreate();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    assert.equal(await promptInput.inputValue(), "等待期间新输入的提示词");
    await context.close();
    console.log("image-task-controls-visual-acceptance: ok");
  } finally {
    await browser.close();
    next?.kill();
  }
}

void main();
