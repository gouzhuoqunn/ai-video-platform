import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const BASE = process.env.STAGE4J4_BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("stage4j4_browser_wait_timeout");
}

async function main() {
  const port = 9494;
  const profile = path.join(process.cwd(), ".secrets", "stage4j4-edge");
  rmSync(profile, { recursive: true, force: true });
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok ? true : null);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("stage4j4_cdp_open_failed")), { once: true }); });
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
      if (response.exceptionDetails) throw new Error(`stage4j4_evaluation_failed:${JSON.stringify(response.exceptionDetails)}`);
      return response.result?.value as T;
    };
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("ai-video-platform:studio-mode","long_video");localStorage.setItem("ai-video-platform:video-submode","long_video")` });

    const results: Array<Record<string, unknown>> = [];
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: BASE });
      await waitFor(async () => await evaluate<boolean>("document.readyState==='complete'&&Boolean(document.querySelector('[data-testid=\"shared-task-gallery\"]'))") ? true : null);
      await waitFor(async () => await evaluate<boolean>("[...document.querySelector('[data-testid=\"shared-task-gallery\"]')?.children??[]].some(x=>x.textContent?.includes('长视频'))") ? true : null);
      await evaluate(`(()=>{const card=[...document.querySelector('[data-testid="shared-task-gallery"]').children].find(x=>x.textContent?.includes('长视频'));card?.querySelector('button')?.click()})()`);
      await waitFor(async () => await evaluate<boolean>("Boolean(document.querySelector('[data-testid=\"long-video-segment-strip\"]'))") ? true : null);
      const result = await evaluate<Record<string, unknown>>(`(()=>{
        const sidebar=document.querySelector('[data-testid="permanent-gpu-sidebar"]');
        const preview=document.querySelector('.studio-unified-preview > div');
        const gallery=document.querySelector('[data-testid="shared-task-gallery"]');
        const body=document.documentElement;
        return {
          sidebarVisible:Boolean(sidebar&&getComputedStyle(sidebar).display!=='none'&&sidebar.getBoundingClientRect().width>=300),
          sidebarWidth:sidebar?.getBoundingClientRect().width,
          sidebarOverflow:getComputedStyle(sidebar).overflowY,
          sidebarHeight:sidebar?.getBoundingClientRect().height,
          previewHeight:preview?.getBoundingClientRect().height,
          columns:getComputedStyle(gallery).gridTemplateColumns.split(' ').filter(Boolean).length,
          horizontalOverflow:body.scrollWidth>body.clientWidth,
          billing:document.querySelector('[data-testid="billing-toggle"]')?.textContent,
          hasLongCard:[...gallery.children].some(x=>x.textContent?.includes('长视频')),
          hasSegmentStrip:Boolean(document.querySelector('[data-testid="long-video-segment-strip"]')),
          autoCancel120:sidebar?.textContent?.includes('120 秒')
        }
      })()`);
      assert.equal(result.sidebarVisible, true);
      assert.equal(result.sidebarOverflow, "auto");
      assert.ok(Number(result.sidebarHeight) <= viewport.height);
      assert.ok(Number(result.previewHeight) <= 480 && Number(result.previewHeight) >= viewport.height * 0.38);
      assert.equal(result.columns, 8);
      assert.equal(result.horizontalOverflow, false);
      assert.equal(result.billing, "资费情况");
      assert.equal(result.hasLongCard, true);
      assert.equal(result.hasSegmentStrip, true);
      assert.equal(result.autoCancel120, true);
      results.push({ viewport, ...result });
    }

    await evaluate("document.querySelector('[data-testid=\"billing-toggle\"]')?.click()");
    await waitFor(async () => await evaluate<boolean>("Boolean(document.querySelector('section[aria-label=\"资费情况\"]'))") ? true : null);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"permanent-gpu-sidebar\"]'))"), true);
    await evaluate("document.querySelector('[data-testid=\"billing-toggle\"]')?.click()");
    await waitFor(async () => await evaluate<boolean>("!document.querySelector('section[aria-label=\"资费情况\"]')") ? true : null);
    const imageSwitch = await evaluate(`(()=>{const b=document.querySelector('button[data-mode="image"]');b?.click();return {found:Boolean(b),text:b?.textContent,mode:document.querySelector('main[data-studio-mode]')?.getAttribute('data-studio-mode')}})()`);
    assert.deepEqual(imageSwitch, { found: true, text: "图片", mode: "long_video" });
    await waitFor(async () => await evaluate<boolean>("document.querySelector('main[data-studio-mode]')?.getAttribute('data-studio-mode')==='image'") ? true : null);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"permanent-gpu-sidebar\"]'))"), true);
    assert.deepEqual(providerMutations, []);
    assert.deepEqual(consoleErrors.filter((value) => /hydration|recoverable|did not match/i.test(value)), []);
    socket.close();
    console.log(JSON.stringify({ ok: true, viewports: results, providerMutations: 0, hydrationErrors: 0 }));
  } finally {
    if (browser.pid) spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignored test profile */ }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
