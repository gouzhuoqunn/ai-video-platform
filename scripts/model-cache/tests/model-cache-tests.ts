import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateVolumeBreakEven, DEFAULT_SESSION_COST_INPUT } from "../../cost/session-cost";
import { generateManifest, writeManifest } from "../manifest";
import { verifyModelCache } from "../verify";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "model-cache-test-"));
  try {
    writeFileSync(path.join(tmp, "config.json"), "{\"mock\":true}\n", "utf8");
    const manifest = await generateManifest(tmp, 34.2);
    writeManifest(tmp, manifest);

    const ok = await verifyModelCache(tmp);
    assert(ok.ok, `manifest should verify: ${ok.errors.join(", ")}`);
    assert(ok.checkedFiles === 1, "one mock model file should be checked.");
    assert(manifest.model === "Wan-AI/Wan2.2-TI2V-5B", "manifest must lock the TI2V-5B model id.");
    assert(manifest.files[0].sha256.length === 64, "manifest files need SHA-256.");

    const badManifest = { ...manifest, files: [{ ...manifest.files[0], sha256: "0".repeat(64) }] };
    writeFileSync(path.join(tmp, "model-cache-manifest.json"), `${JSON.stringify(badManifest, null, 2)}\n`, "utf8");
    const bad = await verifyModelCache(tmp);
    assert(!bad.ok && bad.errors.some((error) => error.includes("sha256 mismatch")), "hash mismatch must block model use.");

    const breakEven = calculateVolumeBreakEven(DEFAULT_SESSION_COST_INPUT);
    assert(breakEven === 0.23, "volume break-even should remain about 0.23 USD/month.");

    console.log("Model cache tests passed.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

void main();
