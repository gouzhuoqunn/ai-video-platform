import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCreateOrderBody, assertCreateOrderBodySafe } from "./order-execution";
import { CLORE_LIGHT_BOOTSTRAP_IMAGE, CLORE_LIGHT_BOOTSTRAP_PROFILE, verifyCloreLightBootstrapImage } from "./public-image";
import { buildRuntimeOverlay } from "../runtime-overlay";
import { syntheticEd25519PublicKey } from "./ssh-test-fixture";

const body = buildCreateOrderBody({ serverId: "12345", image: CLORE_LIGHT_BOOTSTRAP_IMAGE, currency: "USD-Blockchain", sshPublicKey: syntheticEd25519PublicKey("stage3m"), maxPriceUsdPerHour: 0.5, requiredPriceForApi: 12, bootstrapProfile: CLORE_LIGHT_BOOTSTRAP_PROFILE });
assertCreateOrderBodySafe(body);
assert.equal(body.type, "on-demand");
assert.equal(body.autossh_entrypoint, true);
assert.deepEqual(body.ports, { "22": "tcp" });
assert.equal(body.ports["8188"], undefined);
assert.match(body.command, /while sleep 3600/);
assert.ok(!/KEY|TOKEN|SECRET|PASSWORD/.test(JSON.stringify(body.env)));

const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("https://auth.docker.io/")) return new Response(JSON.stringify({ token: "test-token" }), { status: 200 });
  return new Response(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: `sha256:${"b".repeat(64)}`, platform: { os: "linux", architecture: "amd64" } }] }), { status: 200, headers: { "docker-content-digest": `sha256:${"a".repeat(64)}` } });
};
async function main() {
  const manifest = await verifyCloreLightBootstrapImage(fakeFetch);
  assert.equal(manifest.public, true);
  assert.equal(manifest.linuxAmd64, true);

  const overlay = buildRuntimeOverlay();
  assert.equal(overlay.manifest.permanent_image_rebuilt, false);
  assert.ok(overlay.manifest.size_bytes < 2 * 1024 * 1024);
  const supervisor = readFileSync("comfy-runtime/supervisor.py", "utf8");
  assert.match(supervisor, /ampere_image_gpu/);
  assert.match(supervisor, /capability < \(8, 0\)/);
  assert.match(supervisor, /vram_gb < 20/);
  assert.match(supervisor, /COMFY_FORCE_FP16/);
  assert.match(supervisor, /COMFY_CPU_OFFLOAD_REQUIRED/);
  console.log("Stage 3M Clore light bootstrap and Ampere overlay tests passed.");
}

void main();
