import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const BASE = process.env.STAGE4J3_BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROJECT_ID = "a6cbf8c1-f158-4583-8f40-fa524dddd9d1";
const ATTEMPT_ID = "b94faa26-e434-4c38-a67c-bacbb3bd51a6";
const IMAGE_A = "d3573f65-1400-4a27-9bcf-4ff6f8f34273";
const IMAGE_B = "8cdc12f3-cc75-43dc-ae49-423071389f07";

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("stage4j3_browser_wait_timeout");
}

async function main() {
  const port = 9493;
  const profile = path.join(process.cwd(), ".secrets", "stage4j3-edge-final");
  rmSync(profile, { recursive: true, force: true });
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok ? true : null);
    const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("stage4j3_cdp_open_failed")), { once: true }); });
    let nextId = 0;
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
        const args = (message.params as { args?: Array<{ value?: unknown; description?: string }> }).args ?? [];
        consoleErrors.push(args.map((value) => String(value.value ?? value.description ?? "")).join(" "));
      } else if (message.method === "Log.entryAdded") {
        consoleErrors.push(String((message.params as { entry?: { text?: string } })?.entry?.text ?? ""));
      } else if (message.method === "Network.requestWillBeSent") {
        const request = (message.params as { request?: { url?: string; method?: string } })?.request;
        if (request?.method !== "GET" && request?.url?.includes("/api/local-lab/clore/")) providerMutations.push(`${request.method} ${request.url}`);
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async <T>(expression: string) => {
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }) as { result?: { value?: T }; exceptionDetails?: unknown };
      if (response.exceptionDetails) throw new Error(`stage4j3_browser_evaluation_failed:${JSON.stringify(response.exceptionDetails)}`);
      return response.result?.value as T;
    };

    await send("Runtime.enable");
    await send("Log.enable");
    await send("Network.enable");
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("ai-video-platform:studio-mode","long_video")` });
    await send("Page.navigate", { url: BASE });
    await waitFor(async () => await evaluate<boolean>("document.readyState==='complete'") ? true : null);
    await waitFor(async () => await evaluate<boolean>("Boolean(document.querySelector('main'))") ? true : null);
    assert.equal(await evaluate("document.querySelector('[data-testid=\"billing-toggle\"]')?.textContent"), "资费情况");
    assert.equal(await evaluate("document.querySelector('[data-testid=\"billing-toggle\"]')?.getAttribute('aria-label')"), "资费情况");
    assert.equal(await evaluate("(()=>{const e=document.querySelector('aside');return Boolean(e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0)})()"), true);
    await evaluate("document.querySelector('[data-testid=\"billing-toggle\"]')?.click()");
    await waitFor(async () => await evaluate<boolean>("document.querySelector('section[aria-label=\"资费情况\"] h2')?.textContent==='资费情况'") ? true : null);

    const api = await evaluate<Record<string, unknown>>(`(async()=>{const images=await fetch('/api/local-lab/image-results').then(r=>r.json());const projects=await fetch('/api/local-lab/long-video').then(r=>r.json());const project=projects.projects.find(p=>p.id===${JSON.stringify(PROJECT_ID)});const range=await fetch('/api/local-lab/long-video/${PROJECT_ID}/media/segment-video?sequence=0&attempt=${ATTEMPT_ID}',{headers:{range:'bytes=0-1023'}});const thumb=await fetch('/api/local-lab/long-video/${PROJECT_ID}/media/segment-thumbnail?sequence=0&attempt=${ATTEMPT_ID}');const finalVideo=await fetch('/api/local-lab/long-video/${PROJECT_ID}/media/video');return {images:images.results.filter(x=>[${JSON.stringify(IMAGE_A)},${JSON.stringify(IMAGE_B)}].includes(x.sessionId)).map(x=>({id:x.sessionId,width:x.metadata.width,height:x.metadata.height,quality:x.metadata.quality})),project:{status:project.status,next:project.nextSegmentIndex,segment0:project.segments[0].status,segment0Attempts:project.segments[0].attemptsCount,segment1Attempts:project.segments[1].attemptsCount},rangeStatus:range.status,contentRange:range.headers.get('content-range'),thumbStatus:thumb.status,finalVideoStatus:finalVideo.status}})()`);
    assert.deepEqual(api.images, [
      { id: IMAGE_B, width: 2048, height: 2048, quality: "high" },
      { id: IMAGE_A, width: 1536, height: 1024, quality: "medium" },
    ]);
    assert.deepEqual(api.project, { status: "failed", next: 1, segment0: "accepted", segment0Attempts: 1, segment1Attempts: 0 });
    assert.equal(api.rangeStatus, 206);
    assert.match(String(api.contentRange), /^bytes 0-1023\//);
    assert.equal(api.thumbStatus, 200);
    assert.equal(api.finalVideoStatus, 404);

    const seek = await evaluate<{ duration: number; currentTime: number }>(`new Promise((resolve,reject)=>{const v=document.createElement('video');v.preload='auto';v.src='/api/local-lab/long-video/${PROJECT_ID}/media/segment-video?sequence=0&attempt=${ATTEMPT_ID}';v.onloadedmetadata=()=>{v.onseeked=()=>resolve({duration:v.duration,currentTime:v.currentTime});v.onerror=()=>reject(new Error('video_seek_failed'));v.currentTime=2};v.onerror=()=>reject(new Error('video_load_failed'));document.body.appendChild(v)})`);
    assert.ok(seek.duration > 5 && seek.duration < 5.2);
    assert.ok(seek.currentTime >= 1.9);

    await send("Page.reload", { ignoreCache: false });
    await waitFor(async () => await evaluate<boolean>("document.readyState==='complete'") ? true : null);
    assert.equal(await evaluate(`fetch('/api/local-lab/long-video').then(r=>r.json()).then(x=>x.projects.find(p=>p.id===${JSON.stringify(PROJECT_ID)})?.segments[0].attemptsCount)`), 1);
    const hydrationErrors = consoleErrors.filter((value) => /hydration|did not match|server rendered html|recoverable error|hydrated but some attributes/i.test(value));
    assert.deepEqual(hydrationErrors, []);
    assert.deepEqual(providerMutations, []);
    socket.close();
    console.log(JSON.stringify({ ok: true, billingTitle: "资费情况", images: api.images, project: api.project, range: api.rangeStatus, seek, rightSidebarVisible: true, refreshPreserved: true, providerMutations: 0, hydrationErrors: 0 }));
  } finally {
    if (browser.pid) spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 750));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Edge can release its profile after process exit; ignored local state is safe to remove later. */ }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
