import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const browserPath = process.env.SYSTEM_CHROMIUM_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const persistDefaultRegistry = process.argv.includes("--persist-default-registry");
const sourceCases = [
  {
    name: "解决男人女器官LoRA",
    sourceUrl: "https://civitai.red/models/1988828/better-penis-for-flux-z-imageb-klein-9b",
    modelId: 1_988_828,
    strength: 0.85,
  },
  {
    name: "MilkyTiger / MilkyBot / Hu Ku Lior Fursona LoRA",
    sourceUrl: "https://civitai.red/models/371317/milkytiger-and-milkybot-and-hu-ku-lior-fursona",
    modelId: 371_317,
    strength: 0.75,
  },
] as const;

type JsonRecord = Record<string, unknown>;

function boundedOutput(value: string, addition: Buffer | string) {
  const next = value + addition.toString();
  return next.length > 32_000 ? next.slice(-32_000) : next;
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("live_ui_test_port_unavailable"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`live_ui_next_exited_${child.exitCode}\n${output()}`);
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Compilation and startup are still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`live_ui_next_start_timeout\n${output()}`);
}

async function stopProcessTree(child: ChildProcess | null) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  await new Promise<void>((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { timeout: 5_000, windowsHide: true },
      () => resolve(),
    );
  });
}

function idleTaskResponse() {
  return {
    tasks: [],
    runner: { state: "idle", stage: "当前未租用显卡", frozenTaskIds: [], host: null },
    executionReadiness: {
      rtx4090: { ready: false, blocker: "LoRA 页面验收不运行任务" },
      rtx5090: { ready: false, blocker: "LoRA 页面验收不运行任务" },
    },
    executableBatches: {
      rtx4090: { plannedTaskIds: [], executableCount: 0, excludedInconsistentTaskIds: [] },
      rtx5090: { plannedTaskIds: [], executableCount: 0, excludedInconsistentTaskIds: [] },
    },
    maxHourlyPrice: 0.3,
  };
}

async function addThroughPage(page: Page, testCase: typeof sourceCases[number]) {
  const panel = page.locator('section[aria-label="LoRA 管理"]');
  await panel.getByRole("button", { name: "添加新的LoRA", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加新的 LoRA" });
  await dialog.getByLabel("显示名称").fill(testCase.name);
  await dialog.getByLabel("Civitai 或 HuggingFace 链接").fill(testCase.sourceUrl);
  await dialog.locator('input[type="range"]').fill(String(testCase.strength));
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/local-lab/image-loras");
  await dialog.getByRole("button", { name: "校验并注册", exact: true }).click();
  const response = await responsePromise;
  const body = await response.json() as JsonRecord;
  assert.equal(response.status(), 200, `${testCase.name} must register through the real page/API`);
  assert.equal((body.item as JsonRecord | undefined)?.availability, "registered");
  assert.ok(Array.isArray(body.items));
  assert.equal(JSON.stringify(body).includes("registrationSource"), false, "raw registration source field must stay server-side");
  assert.equal(JSON.stringify(body).includes(testCase.sourceUrl), false, "raw registration URL must not be reflected to the browser");
  await dialog.waitFor({ state: "detached" });
  const card = panel.getByText(testCase.name, { exact: true }).locator("xpath=ancestor::article");
  await card.waitFor({ state: "visible" });
  assert.match(await card.innerText(), /已注册，生成时下载并校验/);
  assert.equal(await card.getByLabel(`启用 ${testCase.name}`).isEnabled(), true);
  assert.equal(
    Number(await card.getByLabel(`${testCase.name} 强度`).inputValue()),
    testCase.strength,
  );
}

async function main() {
  const temporaryRoot = persistDefaultRegistry
    ? null
    : mkdtempSync(path.join(tmpdir(), "image-lora-live-ui-"));
  const registryFile = temporaryRoot
    ? path.join(temporaryRoot, "loras.json")
    : path.join(process.cwd(), ".secrets", "image-studio", "loras.json");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  let next: ChildProcess | null = null;
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    next = spawn(
      process.execPath,
      ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(temporaryRoot ? { AI_IMAGE_LORA_REGISTRY_PATH: registryFile } : {}),
          CLORE_ORDER_EXECUTION_ENABLED: "false",
          LOCAL_LAB_ENABLED: "true",
          NEXT_PUBLIC_APP_MODE: "local_lab",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    next.stdout?.on("data", (chunk) => { output = boundedOutput(output, chunk); });
    next.stderr?.on("data", (chunk) => { output = boundedOutput(output, chunk); });
    await waitForServer(baseUrl, next, () => output);

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    let taskPosts = 0;
    let cloreRequests = 0;
    await page.route("**/api/local-lab/image-tasks*", async (route) => {
      if (route.request().method() !== "GET") {
        taskPosts += 1;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "live_ui_acceptance_forbids_task_mutation" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(idleTaskResponse()),
      });
    });
    await page.route("**/api/local-lab/clore/**", async (route) => {
      cloreRequests += 1;
      await route.abort("blockedbyclient");
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator('section[aria-label="LoRA 管理"]').waitFor({ state: "visible" });
    for (const testCase of sourceCases) await addThroughPage(page, testCase);

    assert.equal(taskPosts, 0, "LoRA registration acceptance must never create or mutate a task");
    assert.equal(cloreRequests, 0, "LoRA registration acceptance must never call a Clore route");
    const publicRegistry = await page.evaluate(async () => {
      const response = await fetch("/api/local-lab/image-loras", { cache: "no-store" });
      return { status: response.status, body: await response.json() as unknown };
    });
    assert.equal(publicRegistry.status, 200);
    assert.equal(JSON.stringify(publicRegistry.body).includes("registrationSource"), false);
    for (const testCase of sourceCases) {
      assert.equal(JSON.stringify(publicRegistry.body).includes(testCase.sourceUrl), false);
    }
    const registry = JSON.parse(readFileSync(registryFile, "utf8")) as { items?: JsonRecord[] };
    assert.ok(Array.isArray(registry.items));
    for (const testCase of sourceCases) {
      const registered = registry.items.find((item) => item.name === testCase.name);
      assert.ok(registered, `${testCase.name} must be persisted by the real API`);
      assert.equal(registered.availability, "registered");
      assert.equal(registered.defaultStrength, testCase.strength);
      const registrationSource = registered.registrationSource as JsonRecord | undefined;
      assert.equal(registrationSource?.originalUrl, testCase.sourceUrl);
      assert.equal(registrationSource?.modelId, testCase.modelId);
    }
    await context.close();
    console.log(`image-lora-live-ui-acceptance: PASS (2/2 real page registrations, task POST 0, Clore calls 0, registry=${persistDefaultRegistry ? "default" : "temporary"})`);
  } finally {
    await browser.close();
    await stopProcessTree(next);
    if (temporaryRoot) {
      const resolvedTemporaryRoot = path.resolve(temporaryRoot);
      const resolvedTempBase = `${path.resolve(tmpdir())}${path.sep}`;
      if (!resolvedTemporaryRoot.startsWith(resolvedTempBase)) {
        throw new Error("refusing_to_remove_non_temp_live_ui_fixture");
      }
      rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}

void main();
