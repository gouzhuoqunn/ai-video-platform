import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyFiveImageModelSources } from "./image-model-preflight";

const identities = [
  ["fluxed-up-10.2", "fluxedUpFluxNSFW_102BF16.safetensors", 101],
  ["aidma-lora", "aidmaNSFWunlock-FLUX-V0.2.safetensors", 102],
  ["flux-vae", "ae.safetensors", 103],
  ["flux-clip-l", "clip_l.safetensors", 104],
  ["flux-t5xxl-fp8", "t5xxl_fp8_e4m3fn_scaled.safetensors", 105],
] as const;

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "image-model-preflight-"));
  try {
    const manifestPath = path.join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ schema: 1, family: "fluxed-up-10.2-rtx4090-text", mode: "text_generation", artifacts: [
      ...identities.map(([id, filename, size], index) => ({ id, source: index < 2 ? "civitai" : "huggingface", model_id: index < 2 ? index + 1 : undefined, version_id: index < 2 ? index + 10 : undefined, file_id: index < 2 ? index + 100 : undefined, repository: index < 2 ? undefined : "owner/repo", revision: index < 2 ? undefined : "a".repeat(40), filename, runtime_path: `models/${filename}`, r2_prefix: index < 2 ? (index ? "aidma-lora" : "fluxed-up-10.2") : "shared-flux-components", auth: index < 2 ? "civitai_token" : index === 2 ? "huggingface_token" : "public", auth_env: index < 2 ? "CIVITAI_API_TOKEN" : index === 2 ? "HF_TOKEN" : undefined, size_bytes: size, sha256: String(index).padStart(64, "0") })),
      { id: "flux-tokenizer-config", source: "huggingface", repository: "owner/repo", revision: "b".repeat(40), filename: "tokenizer_config.json", runtime_path: "tokenizer_config.json", r2_prefix: "shared-flux-components", auth: "huggingface_token", auth_env: "HF_TOKEN", metadata_only: true },
    ] }), "utf8");
    const fetchImpl: typeof fetch = async (url, init) => {
      const value = String(url);
      if (value.includes("civitai.com") || value.includes("huggingface.co")) return new Response(null, { status: 302, headers: { location: `https://signed.example/${value.split("/").at(-1)}` } });
      const key = value.endsWith("/10") ? 101 : value.endsWith("/11") ? 102 : value.includes("ae.") ? 103 : value.includes("clip") ? 104 : 105;
      return new Response("x", { status: 206, headers: { "content-range": `bytes 0-0/${key}` } });
    };
    const result = await verifyFiveImageModelSources({ manifestPath, fetchImpl, tokenProvider: () => "local-test-token" });
    assert.equal(result.models.length, 5);
    assert.equal(result.models[0].url, "https://signed.example/10");
    assert.equal(result.checked.every((entry) => entry.status === 206), true);
    await assert.rejects(() => verifyFiveImageModelSources({ manifestPath, fetchImpl, tokenProvider: () => "" }), /missing_local_civitai_download_capability/);
    console.log(JSON.stringify({ ok: true, exact_five_models: true, signed_civitai_url_without_token_leak: true, expected_size_checked: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
void main();
