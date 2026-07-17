import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3000";
const IMAGE_ID = "stage4a-final-image-ultrareal-20260717";
const VIDEO_ID = "stage4a-final-video-wan-remix-20260717";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DEBUG_PORT = 9334;
const PROFILE = path.join(process.cwd(), ".secrets", "stage4e-edge-profile");

type CdpResult = { result?: { value?: unknown }; exceptionDetails?: unknown };

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("stage4e_ui_wait_timeout");
}

async function main() {
  const imageListing = await fetch(`${BASE}/api/local-lab/image-results`).then((response) => response.json()) as { results: Array<{ sessionId: string; imageUrl: string }> };
  const videoListing = await fetch(`${BASE}/api/local-lab/results`).then((response) => response.json()) as { results: Array<{ jobId: string; videoUrl: string; thumbnailUrl: string; metadata: unknown }> };
  const image = imageListing.results.find((item) => item.sessionId === IMAGE_ID);
  const video = videoListing.results.find((item) => item.jobId === VIDEO_ID);
  assert.ok(image?.imageUrl);
  assert.ok(video?.videoUrl && video.thumbnailUrl);
  assert.doesNotMatch(JSON.stringify(video.metadata), /[A-Za-z]:[\\/]|\/(?:workspace|home|root|tmp)\//);

  const imageResponse = await fetch(`${BASE}${image.imageUrl}`);
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get("content-type") ?? "", /image\/png/);
  const thumbnailResponse = await fetch(`${BASE}${video.thumbnailUrl}`);
  assert.equal(thumbnailResponse.status, 200);
  assert.match(thumbnailResponse.headers.get("content-type") ?? "", /image\/jpeg/);
  const rangeResponse = await fetch(`${BASE}${video.videoUrl}`, { headers: { range: "bytes=0-1023" } });
  assert.equal(rangeResponse.status, 206);
  assert.equal((await rangeResponse.arrayBuffer()).byteLength, 1024);
  assert.match(rangeResponse.headers.get("content-range") ?? "", /^bytes 0-1023\/330600$/);
  assert.equal(rangeResponse.headers.get("accept-ranges"), "bytes");

  rmSync(PROFILE, { recursive: true, force: true });
  const browser = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return response.ok ? true : null;
    });
    const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${BASE}`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("stage4e_cdp_open_failed")), { once: true }); });
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: CdpResult) => void; reject: (error: Error) => void }>();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: CdpResult; error?: { message: string } };
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id)!; pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result ?? {});
    });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<CdpResult>((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string, userGesture = false) => {
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
      if (response.exceptionDetails) throw new Error(`stage4e_browser_evaluation_failed:${JSON.stringify(response.exceptionDetails)}`);
      return response.result?.value;
    };
    const reloadForMode = async (mode: "image" | "video") => {
      await evaluate(`localStorage.setItem("ai-video-platform:studio-mode",${JSON.stringify(mode)});true`);
      await send("Page.reload", { ignoreCache: false });
      await waitFor(async () => Boolean(await evaluate("document.readyState==='complete'")));
    };

    await send("Runtime.enable"); await send("Page.enable");
    await send("Page.navigate", { url: BASE });
    await waitFor(async () => Boolean(await evaluate(`location.origin===${JSON.stringify(BASE)}&&document.readyState==='complete'`)));
    await reloadForMode("image");
    await waitFor(async () => Boolean(await evaluate(`(()=>{const e=document.querySelector('img[alt="生成图片预览"]');return !!e&&e.complete&&e.naturalWidth===1024})()`)));
    const imageUi = await evaluate(`(()=>{const e=document.querySelector('img[alt="生成图片预览"]');return {src:e?.getAttribute('src'),width:e?.naturalWidth,height:e?.naturalHeight,legacy:document.body.innerText.includes('stage3o-image-flux-20260715')}})()`) as Record<string, unknown>;

    await reloadForMode("video");
    await waitFor(async () => Boolean(await evaluate("(()=>{const v=document.querySelector('video');return !!v&&v.readyState>=1&&v.duration>0})()")));
    await waitFor(async () => Boolean(await evaluate(`(()=>{const e=document.querySelector('img[alt="任务池视频缩略图"]');return !!e&&e.complete&&e.naturalWidth>0})()`)));
    const playback = await evaluate(`(async()=>{const v=document.querySelector('video');const start=v.currentTime;await v.play();await new Promise(r=>setTimeout(r,500));const advanced=v.currentTime>start;v.pause();v.currentTime=v.duration/2;await new Promise(r=>setTimeout(r,200));v.volume=.25;let entered=false;let fullscreenError=null;try{await v.requestFullscreen();entered=document.fullscreenElement===v;if(entered)await document.exitFullscreen()}catch(e){fullscreenError=String(e)}return {src:v.getAttribute('src'),duration:v.duration,width:v.videoWidth,height:v.videoHeight,advanced,paused:v.paused,seeked:v.currentTime>0,volume:v.volume,fullscreenSupported:typeof v.requestFullscreen==='function',fullscreenEntered:entered,fullscreenError,thumbnail:document.querySelector('img[alt="任务池视频缩略图"]')?.getAttribute('src')}})()`, true) as Record<string, unknown>;
    assert.equal(playback.advanced, true);
    assert.equal(playback.paused, true);
    assert.equal(playback.seeked, true);
    assert.equal(playback.volume, 0.25);
    assert.equal(playback.fullscreenSupported, true);
    assert.equal(playback.fullscreenEntered, true);
    assert.equal(playback.fullscreenError, null);

    await send("Page.reload", { ignoreCache: false });
    await waitFor(async () => Boolean(await evaluate("(()=>{const v=document.querySelector('video');return !!v&&v.readyState>=1})()")));
    const refreshed = await evaluate("(()=>{const v=document.querySelector('video');return {src:v.getAttribute('src'),duration:v.duration}})()") as Record<string, unknown>;
    socket.close();
    console.log(JSON.stringify({
      stage4e_ui_ready: true,
      image: imageUi,
      video: playback,
      refreshed,
      range: { status: 206, contentRange: rangeResponse.headers.get("content-range"), bytes: 1024 },
    }, null, 2));
  } finally {
    if (browser.pid) spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
