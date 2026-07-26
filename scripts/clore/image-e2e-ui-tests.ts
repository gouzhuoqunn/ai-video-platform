import assert from "node:assert/strict";
import sharp from "sharp";
import { LocalUiVerificationError, ensureLocalUi, validateImageResponse } from "./image-e2e-ui";

function response(bytes: Buffer, contentType: string, contentLength?: string) {
  const headers = new Headers({ "content-type": contentType });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Response(bytes, { status: 200, headers });
}

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof LocalUiVerificationError && error.code === code);
}

async function main() {
  let killed = false;
  const fake: any = () => ({ pid: 123, killed: false, stdout: { on: () => undefined }, stderr: { on: () => undefined }, kill() { killed = true; this.killed = true; } });
  const originalFetch = global.fetch; let checks = 0;
  global.fetch = (async () => ({ ok: ++checks > 1 })) as any;
  const handle = await ensureLocalUi({ baseUrl: "http://127.0.0.1:9", spawnImpl: fake, timeoutMs: 50 });
  handle.stop(); assert.equal(killed, true);
  global.fetch = originalFetch;
  const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#248" } }).png().toBuffer();
  const webp = await sharp(png).resize({ width: 512, height: 512 }).webp().toBuffer();
  const goodThumbnail = await validateImageResponse("thumbnail", response(webp, "image/webp"), 768, 768);
  const goodOutput = await validateImageResponse("output", response(png, "image/png", String(png.length)), 768, 768);
  assert.equal(goodThumbnail.actualBytes, webp.length, "a valid body must pass without Content-Length");
  assert.equal(goodOutput.actualBytes, png.length);
  await expectCode(() => validateImageResponse("thumbnail", response(webp, "image/webp", String(webp.length + 1)), 768, 768), "local_ui_content_length_mismatch");
  await expectCode(() => validateImageResponse("thumbnail", response(Buffer.alloc(0), "image/webp"), 768, 768), "local_ui_thumbnail_empty");
  await expectCode(() => validateImageResponse("thumbnail", response(webp, "image/png"), 768, 768), "local_ui_thumbnail_mime_invalid");
  await expectCode(() => validateImageResponse("thumbnail", response(Buffer.from("not-a-webp"), "image/webp"), 768, 768), "local_ui_thumbnail_decode_failed");
  const wrongPng = await sharp({ create: { width: 384, height: 384, channels: 3, background: "#248" } }).png().toBuffer();
  await expectCode(() => validateImageResponse("output", response(wrongPng, "image/png"), 768, 768), "local_ui_output_dimensions_invalid");
  console.log(JSON.stringify({ ok: true, ui_start_bounded: true, coordinator_child_only: true, body_without_content_length: true, content_length_consistency: true, empty_mime_decode_and_dimension_failures: true }));
}

void main();
