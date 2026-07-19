import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const BASE = process.env.STAGE4J9_BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("stage4j9_browser_wait_timeout");
}

async function main() {
  const port = 9499;
  const profile = path.join(process.cwd(), ".secrets", "stage4j9-edge");
  rmSync(profile, { recursive: true, force: true });
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok ? true : null);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("stage4j9_cdp_open_failed")), { once: true }); });
    let id = 0;
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    const consoleErrors: string[] = [];
    const providerMutations: string[] = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result ?? {});
      } else if (message.method === "Runtime.consoleAPICalled" && (message.params as { type?: string })?.type === "error") {
        consoleErrors.push(JSON.stringify(message.params));
      } else if (message.method === "Network.requestWillBeSent") {
        const request = (message.params as { request?: { url?: string; method?: string } }).request;
        if (request?.method !== "GET" && /\/api\/local-lab\/(?:clore|runpod)\//.test(request?.url ?? "")) providerMutations.push(`${request?.method} ${request?.url}`);
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async <T>(expression: string) => {
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }) as { result?: { value?: T }; exceptionDetails?: unknown };
      if (response.exceptionDetails) throw new Error(`stage4j9_evaluation_failed:${JSON.stringify(response.exceptionDetails)}`);
      return response.result?.value as T;
    };
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `if(!sessionStorage.getItem("stage4j9-initialized")){localStorage.setItem("ai-video-platform:studio-mode","image");localStorage.removeItem("ai-video-platform:execution-queue:v1");sessionStorage.setItem("stage4j9-initialized","1")}` });
    await send("Page.navigate", { url: `${BASE}/?gpu_fixture=base` });
    await waitFor(async () => await evaluate<boolean>("Boolean(document.querySelector('[data-testid=\"execution-queue-rtx5090\"]'))") ? true : null);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await evaluate("document.querySelector('button[data-mode=\"image\"]')?.click()");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const selectedMode = await evaluate<Record<string, string>>(`({mode:document.querySelector('main[data-studio-mode]')?.getAttribute('data-studio-mode')??'',url:location.href,text:document.body.innerText.slice(0,500)})`);
    assert.equal(selectedMode.mode, "image", `mode did not change; state=${JSON.stringify(selectedMode)}; console=${consoleErrors.join(' | ')}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const loadedQueueText = await evaluate<string>("document.querySelector('[data-testid=\"execution-queue-rtx4090\"]')?.textContent??''");
    assert.match(loadedQueueText, /图片待处理/);

    const imageState = await evaluate<Record<string, unknown>>(`(()=>{
      const blue=document.querySelector('[data-testid="execution-queue-rtx4090"]');
      const green=document.querySelector('[data-testid="execution-queue-rtx5090"]');
      const cards=[...document.querySelectorAll('article[data-gpu-class]')];
      return {blue:blue?.textContent,green:green?.textContent,blueDisabled:blue?.disabled,greenDisabled:green?.disabled,selectable:cards.filter(x=>x.querySelector('input[type=checkbox]:not(:disabled)')).length};
    })()`);
    assert.match(String(imageState.blue), /1 个图片待处理/);
    assert.match(String(imageState.green), /1 个图片待处理/);
    assert.equal(imageState.blueDisabled, false);
    assert.equal(imageState.greenDisabled, false);
    assert.ok(Number(imageState.selectable) >= 2);

    await evaluate("document.querySelector('[data-testid=\"execution-queue-rtx4090\"]')?.click()");
    assert.equal(await evaluate("document.querySelector('[data-testid=\"execution-queue-rtx4090\"]')?.getAttribute('aria-pressed')"), "true");
    const mutedGreen = await evaluate("document.querySelector('[data-testid=\"execution-queue-rtx5090\"]')?.className.includes('bg-stone-100')");
    assert.equal(mutedGreen, true);
    await evaluate("document.querySelector('[data-testid=\"execution-queue-rtx5090\"]')?.click()");
    assert.equal(await evaluate("document.querySelector('[data-testid=\"execution-queue-rtx5090\"]')?.getAttribute('aria-pressed')"), "true");
    await send("Page.reload", { ignoreCache: false });
    await waitFor(async () => await evaluate<boolean>("document.querySelector('[data-testid=\"execution-queue-rtx5090\"]')?.getAttribute('aria-pressed')==='true'") ? true : null);

    await evaluate("document.querySelector('button[data-mode=\"video\"]')?.click()");
    await waitFor(async () => await evaluate<boolean>("document.querySelector('main[data-studio-mode]')?.getAttribute('data-studio-mode')==='video'") ? true : null);
    await waitFor(async () => await evaluate<boolean>("document.querySelector('[data-testid=\"execution-queue-rtx4090\"]')?.textContent?.includes('2 个视频待处理')===true") ? true : null);
    assert.match(String(await evaluate("document.querySelector('[data-testid=\"execution-queue-rtx5090\"]')?.textContent")), /1 个视频待处理/);

    await send("Page.navigate", { url: `${BASE}/?gpu_fixture=rental_success` });
    await waitFor(async () => await evaluate<boolean>("document.body.innerText.includes('租用成功')&&document.body.innerText.includes('已租用 RTX 5090，正在部署图片模型')") ? true : null);
    await send("Page.navigate", { url: `${BASE}/?gpu_fixture=stopped_image` });
    await waitFor(async () => await evaluate<boolean>("document.body.innerText.includes('当前GPU：RTX 5090')&&document.body.innerText.includes('GPU空闲，将在')") ? true : null);
    await send("Page.navigate", { url: `${BASE}/?gpu_fixture=rented_image` });
    await waitFor(async () => await evaluate<boolean>("document.body.innerText.includes('GPU当前运行图片模型')") ? true : null);

    const layout = await evaluate<Record<string, unknown>>(`(()=>{const sidebar=document.querySelector('[data-testid="permanent-gpu-sidebar"]');return {width:sidebar?.getBoundingClientRect().width,overflow:getComputedStyle(sidebar).overflowY,horizontal:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()`);
    assert.equal(layout.width, 320);
    assert.equal(layout.overflow, "auto");
    assert.equal(layout.horizontal, false);
    assert.deepEqual(providerMutations, []);
    assert.deepEqual(consoleErrors.filter((value) => /hydration|recoverable|did not match/i.test(value)), []);
    socket.close();
    console.log(JSON.stringify({ ok: true, imageCounts: "1/1", videoCounts: "2/1", queueSelectionRecovered: true, rentalNotice: true, idleCountdown: true, incompatibleFamilyNotice: true, sidebarWidth: 320, providerMutations: 0, hydrationErrors: 0 }));
  } finally {
    if (browser.pid) spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
