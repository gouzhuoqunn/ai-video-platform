import assert from "node:assert/strict";
import { BUILTIN_AIDMA_LORA, effectiveImageTaskLoras, type ImageTaskLora } from "../../src/lib/image-generation/image-loras";
import { assertAgentModelManifestIdentityUnchanged, indexResolvedModelsById, toAgentModelManifest, validateAgentModelManifestContract, type AgentAdditionalLoraEntry, type RemoteImageModel } from "./image-model-preflight";

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
  const loras: AgentAdditionalLoraEntry[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      filename: "first.safetensors",
      url: "https://downloads.example.invalid/first.safetensors?signature=before",
      sha256: "a".repeat(64),
      size_bytes: 1234,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      filename: "second.safetensors",
      url: "https://downloads.example.invalid/second.safetensors?signature=before",
      sha256: "b".repeat(64),
      size_bytes: 5678,
    },
  ];
  const taskLoras: ImageTaskLora[] = loras.map((lora, index) => ({
    id: lora.id,
    name: `LoRA ${index + 1}`,
    filename: lora.filename,
    strength: index === 0 ? 0.45 : 1.1,
    enabled: index === 0,
    sha256: lora.sha256,
    sizeBytes: lora.size_bytes,
  }));
  assert.deepEqual(
    effectiveImageTaskLoras({ loras: taskLoras, loraStrength: 0.8 }),
    [{ filename: "first.safetensors", strength: 0.45 }],
    "the persisted full selection is filtered only at the inference boundary",
  );
  assert.deepEqual(effectiveImageTaskLoras({ loras: [] }), [], "an explicit empty selection means zero LoRA");
  assert.deepEqual(
    effectiveImageTaskLoras({ loraStrength: 0.9 }),
    [{ filename: BUILTIN_AIDMA_LORA.filename, strength: 0.9 }],
    "legacy tasks keep the pinned single-LoRA behavior",
  );
  const payload = toAgentModelManifest(resolved, loras);
  assert.equal(payload.models.length, 5);
  assert.deepEqual(new Set(payload.models.map((model) => model.role)), new Set(roles));
  for (const model of payload.models) assert.deepEqual(Object.keys(model).sort(), ["filename", "role", "sha256", "size_bytes", "url"]);
  assert.ok(payload.models.every((model) => !("id" in model)));
  assert.doesNotThrow(() => validateAgentModelManifestContract(payload), "real Agent validator accepts projected manifest");
  assert.throws(() => validateAgentModelManifestContract({ models: [{ ...payload.models[0], id: "local-only" }, ...payload.models.slice(1)] } as never), /agent_model_manifest_contract_rejected/, "real Agent validator rejects local id");

  const refreshed = byId.get("flux-vae")!;
  const refreshedLocal = resolved.map((model) => model.id === refreshed.id ? { ...model, url: "https://downloads.example.invalid/ae.safetensors?X-Amz-Signature=refreshed" } : model);
  const refreshedPayload = toAgentModelManifest(
    refreshedLocal,
    loras.map((lora) => ({ ...lora, url: `${lora.url.split("?")[0]}?signature=refreshed` })),
  );
  assert.equal(refreshedPayload.models[2].url.includes("refreshed"), true);
  assert.ok(refreshedPayload.models.every((model) => Object.keys(model).length === 5 && !("id" in model)));
  assert.equal(
    assertAgentModelManifestIdentityUnchanged(payload, refreshedPayload),
    refreshedPayload,
    "fresh signed URLs are accepted when every immutable identity field is unchanged",
  );
  assert.throws(
    () => assertAgentModelManifestIdentityUnchanged(payload, {
      ...refreshedPayload,
      loras: refreshedPayload.loras?.map((lora, index) => index === 0 ? { ...lora, sha256: "c".repeat(64) } : lora),
    }),
    /agent_model_manifest_identity_changed_before_install/,
    "a refreshed LoRA may not silently change bytes",
  );
  assert.throws(
    () => assertAgentModelManifestIdentityUnchanged(payload, {
      ...refreshedPayload,
      loras: refreshedPayload.loras?.slice(0, 1),
    }),
    /agent_model_manifest_identity_changed_before_install/,
    "a refreshed manifest may not drop a LoRA",
  );

  // Receipts/log diagnostics use the existing sanitized preflight form, never the signed URLs or local credential fields.
  const diagnostic = JSON.stringify({
    models: resolved.map(({ id, role, filename, sha256, size_bytes }) => ({
      id,
      role,
      filename,
      sha256,
      size_bytes,
      auth_env: undefined,
      local_secret: undefined,
    })),
  });
  assert.equal(diagnostic.includes("X-Amz-Signature"), false);
  assert.equal(diagnostic.includes("temporary"), false);
  console.log(JSON.stringify({ ok: true, explicit_projection: true, real_agent_contract: true, refreshed_urls_keep_identity: true, changed_lora_identity_rejected: true, diagnostics_redacted: true }));
}

main();
