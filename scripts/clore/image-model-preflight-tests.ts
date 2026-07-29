import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyFiveImageModelSources } from "./image-model-preflight";

const identities = [
  ["fluxed-up-10.2", "fluxedUpFluxNSFW_102BF16.safetensors", 101], ["aidma-lora", "aidmaNSFWunlock-FLUX-V0.2.safetensors", 102], ["flux-vae", "ae.safetensors", 103], ["flux-clip-l", "clip_l.safetensors", 104], ["flux-t5xxl-fp8", "t5xxl_fp8_e4m3fn_scaled.safetensors", 105],
] as const;

function response(status: number, headers: Record<string, string>, cancelled: { count: number }) {
  return { status, headers: new Headers(headers), url: "", body: { cancel: async () => { cancelled.count += 1; } } } as unknown as Response;
}
async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "image-model-preflight-"));
  try {
    const manifestPath = path.join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ schema: 1, family: "fluxed-up-10.2-rtx4090-text", mode: "text_generation", artifacts: [...identities.map(([id, filename, size], index) => ({ id, source: index < 2 ? "civitai" : "huggingface", model_id: index < 2 ? index + 1 : undefined, version_id: index < 2 ? index + 10 : undefined, file_id: index < 2 ? index + 100 : undefined, repository: index < 2 ? undefined : "owner/repo", revision: index < 2 ? undefined : "a".repeat(40), filename, runtime_path: `models/${filename}`, r2_prefix: index < 2 ? (index ? "aidma-lora" : "fluxed-up-10.2") : "shared-flux-components", auth: index < 2 ? "civitai_token" : index === 2 ? "huggingface_token" : "public", auth_env: index < 2 ? "CIVITAI_API_TOKEN" : index === 2 ? "HF_TOKEN" : undefined, size_bytes: size, sha256: String(index).padStart(64, "0") })), { id: "flux-tokenizer-config", source: "huggingface", repository: "owner/repo", revision: "b".repeat(40), filename: "tokenizer_config.json", runtime_path: "tokenizer_config.json", r2_prefix: "shared-flux-components", auth: "huggingface_token", auth_env: "HF_TOKEN", metadata_only: true }] }), "utf8");
    const calls: Array<{ url: string; method: string | undefined; auth: string | null; ua: string | null; accept: string | null }> = []; const cancelled = { count: 0 };
    const fetchImpl: typeof fetch = async (url, init) => {
      const value = String(url); const headers = new Headers(init?.headers); calls.push({ url: value, method: init?.method, auth: headers.get("authorization"), ua: headers.get("user-agent"), accept: headers.get("accept") });
      if (value.includes("civitai.com")) return response(302, { location: `https://signed.example/civitai-${value.split("/").at(-1)}` }, cancelled);
      if (value.includes("huggingface.co")) return response(302, { location: `https://cdn.example/hf-${value.split("/").at(-1)}` }, cancelled);
      const key = value.endsWith("/10") || value.endsWith("civitai-10") ? 101 : value.endsWith("/11") || value.endsWith("civitai-11") ? 102 : value.includes("ae.") ? 103 : value.includes("clip") ? 104 : 105;
      return response(206, { "content-range": `bytes 0-0/${key}` }, cancelled);
    };
    const result = await verifyFiveImageModelSources({ manifestPath, fetchImpl, tokenProvider: (name) => `${name}-local-only` });
    assert.equal(result.models.length, 5); assert.equal(result.checked.every((entry) => entry.validatedMethod === "GET" && entry.status === 206 && entry.contentLength > 0), true);
    assert.equal(calls.every((call) => call.method === "GET" && call.ua === "ai-video-platform-model-preflight/1" && call.accept === "application/octet-stream"), true);
    assert.equal(cancelled.count, calls.length, "every headers-only GET disposes its body");
    const civitai = calls.filter((call) => call.url.includes("civitai.com")); const signed = calls.filter((call) => call.url.includes("signed.example")); const hf = calls.filter((call) => call.url.includes("huggingface.co")); const cdn = calls.filter((call) => call.url.includes("cdn.example"));
    assert.ok(civitai.every((call) => call.auth === "Bearer CIVITAI_API_TOKEN-local-only")); assert.ok(signed.every((call) => call.auth === null), "Civitai bearer never follows redirect"); assert.ok(hf.some((call) => call.auth === "Bearer HF_TOKEN-local-only")); assert.ok(cdn.every((call) => call.auth === null), "HF bearer never follows redirect");
    assert.equal(result.checked[0].finalHostname, "signed.example"); assert.equal(result.checked[2].finalHostname, "cdn.example"); assert.ok(result.checked[2].redirectCount >= 1);
    const get403: typeof fetch = async (_url, init) => { assert.equal(init?.method, "GET", "HEAD-only access is not accepted"); return response(403, {}, { count: 0 }); };
    await assert.rejects(() => verifyFiveImageModelSources({ manifestPath, fetchImpl: get403, tokenProvider: () => "local" }), /civitai_source_http_403/);
    await assert.rejects(() => verifyFiveImageModelSources({ manifestPath, fetchImpl, tokenProvider: () => "" }), /missing_local_civitai_download_capability/);

    const tokenBoundHuggingFace: typeof fetch = async (url, init) => {
      const value = String(url);
      const headers = new Headers(init?.headers);
      if (value.includes("civitai.com")) return response(302, { location: `https://signed.example/civitai-${value.split("/").at(-1)}` }, { count: 0 });
      if (value.includes("signed.example")) {
        const size = value.endsWith("10") ? 101 : 102;
        return response(206, { "content-range": `bytes 0-0/${size}` }, { count: 0 });
      }
      if (value.includes("ae.safetensors") && !headers.has("authorization")) {
        return response(401, {}, { count: 0 });
      }
      const size = value.includes("ae.") ? 103 : value.includes("clip") ? 104 : 105;
      return response(206, { "content-range": `bytes 0-0/${size}` }, { count: 0 });
    };
    await assert.rejects(
      () => verifyFiveImageModelSources({ manifestPath, fetchImpl: tokenBoundHuggingFace, tokenProvider: (name) => `${name}-local-only` }),
      /huggingface_remote_delivery_requires_local_token:flux-vae/,
      "the remote Agent must never depend on a local HuggingFace bearer token",
    );

    let stalledSignal: AbortSignal | null = null;
    let firstRequest = true;
    const stalledCancelFetch: typeof fetch = async (url, init) => {
      if (firstRequest) {
        firstRequest = false;
        stalledSignal = init?.signal ?? null;
        return {
          status: 302,
          headers: new Headers({ location: `https://signed.example/civitai-${String(url).split("/").at(-1)}` }),
          url: "",
          body: { cancel: () => new Promise<void>(() => undefined) },
        } as unknown as Response;
      }
      return await fetchImpl(url, init);
    };
    const stalledStarted = Date.now();
    await verifyFiveImageModelSources({ manifestPath, fetchImpl: stalledCancelFetch, tokenProvider: (name) => `${name}-local-only` });
    assert.ok(stalledSignal);
    assert.equal(stalledSignal.aborted, true, "a body cancel that never settles must abort its request");
    assert.ok(Date.now() - stalledStarted < 2_000, "a stalled response-body cancel must remain bounded");
    const productionSource = readFileSync("scripts/clore/image-model-preflight.ts", "utf8");
    assert.match(productionSource, /systemProxyAwareProviderFetch\(\)/);
    assert.doesNotMatch(productionSource, /powershell\.exe|AI_IMAGE_PREFLIGHT_URL/,
      "production model network preflight must use the shared bounded provider fetch instead of an opaque child process");

    console.log(JSON.stringify({ ok: true, method: "GET", redirected_credentials_local_only: true, tokenless_remote_delivery_required: true, response_bodies_cancelled: true, stalled_cancel_bounded: true, shared_proxy_aware_fetch: true, exact_content_length_or_range_checked: true, head_success_cannot_pass: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
void main();
