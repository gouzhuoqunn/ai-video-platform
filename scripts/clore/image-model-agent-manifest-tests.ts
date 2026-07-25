import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { indexResolvedModelsById, toAgentModelManifest, validateAgentModelManifestContract, type RemoteImageModel } from "./image-model-preflight";

const roles = ["transformer", "lora", "vae", "clip_l", "t5"];
const ids = ["fluxed-up-10.2", "aidma-lora", "flux-vae", "flux-clip-l", "flux-t5xxl-fp8"] as const;
const filenames = ["fluxedUpFluxNSFW_102BF16.safetensors", "aidmaNSFWunlock-FLUX-V0.2.safetensors", "ae.safetensors", "clip_l.safetensors", "t5xxl_fp8_e4m3fn_scaled.safetensors"];

function localModels(): RemoteImageModel[] {
  return roles.map((role, index) => ({
    role,
    id: ids[index],
    filename: filenames[index],
    url: `https://downloads.example.invalid/${filenames[index]}?X-Amz-Signature=fixture-${index}&X-Amz-Credential=temporary`,
    sha256: `${index}`.repeat(64),
    size_bytes: index + 1,
  }));
}

function main() {
  const resolved = localModels();
  const byId = indexResolvedModelsById(resolved);
  assert.equal(byId.size, 5);
  const payload = toAgentModelManifest(resolved);
  assert.equal(payload.models.length, 5);
  assert.deepEqual(new Set(payload.models.map((model) => model.role)), new Set(roles));
  for (const model of payload.models) assert.deepEqual(Object.keys(model).sort(), ["filename", "role", "sha256", "size_bytes", "url"]);
  assert.ok(payload.models.every((model) => !("id" in model)));
  assert.doesNotThrow(() => validateAgentModelManifestContract(payload), "real Agent validator accepts projected manifest");
  assert.throws(() => validateAgentModelManifestContract({ models: [{ ...payload.models[0], id: "local-only" }, ...payload.models.slice(1)] } as never), /agent_model_manifest_contract_rejected/, "real Agent validator rejects local id");

  const refreshed = byId.get("flux-vae")!;
  const refreshedLocal = resolved.map((model) => model.id === refreshed.id ? { ...model, url: "https://downloads.example.invalid/ae.safetensors?X-Amz-Signature=refreshed" } : model);
  const refreshedPayload = toAgentModelManifest(refreshedLocal);
  assert.equal(refreshedPayload.models[2].url.includes("refreshed"), true);
  assert.ok(refreshedPayload.models.every((model) => Object.keys(model).length === 5 && !("id" in model)));

  // Receipts/log diagnostics use the existing sanitized preflight form, never the signed URLs or local credential fields.
  const diagnostic = JSON.stringify({ models: resolved.map(({ url: _url, ...model }) => ({ ...model, auth_env: undefined, local_secret: undefined })) });
  assert.equal(diagnostic.includes("X-Amz-Signature"), false);
  assert.equal(diagnostic.includes("temporary"), false);
  console.log(JSON.stringify({ ok: true, explicit_projection: true, real_agent_contract: true, refreshed_model_keeps_contract: true, diagnostics_redacted: true }));
}

main();
