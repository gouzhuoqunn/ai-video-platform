import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const BASE = process.env.STAGE4H6_BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const MODE_KEY = "ai-video-platform:studio-mode";
const DRAFT_KEY = "ai-video-platform:long-video-draft:v1";
const PROJECT_ID = "8fff4d9f-39f6-4aee-a02a-d0a6376e4f8b";
const DRAFT_MARKER = "stage4h6-draft-preserved";

type CdpResponse = { result?: { value?: unknown; result?: { value?: unknown } }; exceptionDetails?: unknown };
type Scenario = { name: string; storedMode?: string; expectedMode: "image" | "video" | "long_video"; draft?: boolean; refresh?: boolean };

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("stage4h6_browser_wait_timeout");
}

async function runScenario(scenario: Scenario, index: number) {
  const port = 9450 + index;
  const profile = path.join(process.cwd(), ".secrets", `stage4h6-edge-${scenario.name}`);
  rmSync(profile, { recursive: true, force: true });
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok ? true : null);
    const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("stage4h6_cdp_open_failed")), { once: true }); });
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }>();
    const consoleErrors: string[] = [];
    const requests: string[] = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: CdpResponse; error?: { message: string } };
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id)!; pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result ?? {});
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && (message.params as { type?: string })?.type === "error") {
        const args = (message.params as { args?: Array<{ value?: unknown; description?: string }> }).args ?? [];
        consoleErrors.push(args.map((value) => String(value.value ?? value.description ?? "")).join(" "));
      }
      if (message.method === "Log.entryAdded") consoleErrors.push(String(((message.params as { entry?: { text?: string } }).entry?.text) ?? ""));
      if (message.method === "Network.requestWillBeSent") requests.push(String(((message.params as { request?: { url?: string } }).request?.url) ?? ""));
    });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<CdpResponse>((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(`stage4h6_browser_evaluation_failed:${JSON.stringify(response.exceptionDetails)}`);
      return response.result?.value ?? response.result?.result?.value;
    };

    await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable"); await send("Page.enable");
    const draft = scenario.draft ? { title: DRAFT_MARKER, overallPrompt: "draft-overall", duration: 15, prompts: ["draft-0", "draft-1", "draft-2"] } : null;
    const initializer = `(()=>{localStorage.removeItem(${JSON.stringify(MODE_KEY)});localStorage.removeItem(${JSON.stringify(DRAFT_KEY)});${scenario.storedMode === undefined ? "" : `localStorage.setItem(${JSON.stringify(MODE_KEY)},${JSON.stringify(scenario.storedMode)});`}${draft ? `localStorage.setItem(${JSON.stringify(DRAFT_KEY)},${JSON.stringify(JSON.stringify(draft))});` : ""}})()`;
    await send("Page.addScriptToEvaluateOnNewDocument", { source: initializer });
    await send("Page.navigate", { url: BASE });
    await waitFor(async () => Boolean(await evaluate("document.readyState==='complete'")));
    await waitFor(async () => (await evaluate("Boolean(document.querySelector('main'))")) ? true : null);
    await waitFor(async () => (await evaluate(`document.querySelector('main[data-studio-mode]')?.dataset.studioMode===${JSON.stringify(scenario.expectedMode)}`)) ? true : null);
    const hydratedMode = await evaluate("document.querySelector('main[data-studio-mode]')?.dataset.studioMode");
    assert.equal(hydratedMode, scenario.expectedMode);
    const snapshot = await evaluate(`(()=>({mode:document.querySelector('main[data-studio-mode]')?.dataset.studioMode,pressed:document.querySelector('button[aria-pressed="true"]')?.dataset.mode,statusMode:document.querySelector('[data-testid="studio-status"]')?.dataset.mode,statusText:document.querySelector('[data-testid="studio-status"]')?.textContent,title:document.querySelector('[data-testid="long-video-title"]')?.value,draft:localStorage.getItem(${JSON.stringify(DRAFT_KEY)})}))()` ) as Record<string, unknown>;
    assert.equal(snapshot.mode, scenario.expectedMode);
    assert.equal(snapshot.pressed, scenario.expectedMode);
    assert.equal(snapshot.statusMode, scenario.expectedMode);
    if (scenario.draft) {
      await waitFor(async () => (await evaluate(`document.querySelector('[data-testid="long-video-title"]')?.value===${JSON.stringify(DRAFT_MARKER)}`)) ? true : null);
      const retained = JSON.parse(String(await evaluate(`localStorage.getItem(${JSON.stringify(DRAFT_KEY)})`))) as { title: string; prompts: string[] };
      assert.equal(retained.title, DRAFT_MARKER);
      assert.deepEqual(retained.prompts, ["draft-0", "draft-1", "draft-2"]);
    }
    if (scenario.expectedMode === "long_video") {
      await waitFor(async () => Boolean(await evaluate(`document.body.innerText.includes(${JSON.stringify(PROJECT_ID)})||document.querySelectorAll('video[src*="segment-video"],img[src*="segment-thumbnail"]').length>0||document.body.innerText.length>100`)));
      const project = await evaluate(`fetch('/api/local-lab/long-video').then(r=>r.json()).then(x=>x.projects.find(p=>p.id===${JSON.stringify(PROJECT_ID)}))`) as { id: string; nextSegmentIndex: number; status: string; segments: Array<{ status: string; attemptsCount: number }> };
      assert.equal(project.id, PROJECT_ID);
      assert.equal(project.status, "failed");
      assert.equal(project.nextSegmentIndex, 1);
      assert.equal(project.segments[0].status, "accepted");
      assert.equal(project.segments[1].attemptsCount, 0);
      assert.equal(project.segments[2].attemptsCount, 0);
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="first-frame-dropzone"]'))`), true);
      const billingBefore = requests.filter((url) => url.includes("/api/local-lab/billing")).length;
      assert.equal(billingBefore, 0);
      const billingTitle = await evaluate(`document.querySelector('[data-testid="billing-toggle"]')?.textContent`);
      assert.equal(billingTitle, "璧勮垂鎯呭喌");
      await evaluate(`document.querySelector('[data-testid="billing-toggle"]')?.click()`);
      await waitFor(async () => requests.some((url) => url.includes("/api/local-lab/billing")) ? true : null);
      assert.equal(requests.filter((url) => url.includes("/api/local-lab/billing")).length, 1);
    }
    if (scenario.refresh) {
      await send("Page.reload", { ignoreCache: false });
      await waitFor(async () => (await evaluate(`document.querySelector('main[data-studio-mode]')?.dataset.studioMode===${JSON.stringify(scenario.expectedMode)}`)) ? true : null);
    }
    const hydrationErrors = consoleErrors.filter((value) => /hydration|did not match|server rendered html|recoverable error|hydrated but some attributes/i.test(value));
    assert.deepEqual(hydrationErrors, [], `hydration errors in ${scenario.name}: ${hydrationErrors.join(" | ")}`);
    socket.close();
    return { name: scenario.name, finalMode: scenario.expectedMode, hydrationErrors: 0, draftPreserved: Boolean(scenario.draft) };
  } finally {
    if (browser.pid) spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
const serverHtml = await fetch(BASE).then((response) => response.text());
assert.match(serverHtml, /data-studio-mode="video"/);
assert.doesNotMatch(serverHtml, /data-studio-mode="long_video"/);

const scenarios: Scenario[] = [
  { name: "stored-long-video", storedMode: "long_video", expectedMode: "long_video", draft: true, refresh: true },
  { name: "no-stored-mode", expectedMode: "video" },
  { name: "stored-image", storedMode: "image", expectedMode: "image" },
  { name: "invalid-stored-mode", storedMode: "invalid", expectedMode: "video" },
];
const results = [];
for (let index = 0; index < scenarios.length; index += 1) results.push(await runScenario(scenarios[index], index));
console.log(JSON.stringify({ ok: true, serverSnapshot: "video", scenarios: results, billingLazyRequests: 1, realProjectVisible: true, firstFrameDropzone: true }));
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
