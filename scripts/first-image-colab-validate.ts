import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FLUX_MODEL_FILES } from "./flux-first-image";

const notebookPath = path.join(process.cwd(), "notebooks", "flux-first-image-colab.ipynb");
const notebookText = readFileSync(notebookPath, "utf8");
const notebook = JSON.parse(notebookText) as { nbformat: number; cells: Array<{ cell_type: string; source: string[] }> };
assert.equal(notebook.nbformat, 4);
assert.ok(notebook.cells.some((cell) => cell.cell_type === "code"));
for (const marker of ["nvidia-smi", "da2608926eaf68fd532bba4e1ace3402c5d21399", "flux-first-image-colab-bundle.json", "/prompt", "output.png", "files.download"]) assert.ok(notebookText.includes(marker), marker);
for (const forbidden of ["R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "BEGIN OPENSSH PRIVATE KEY", "CLORE_API_KEY", "RUNPOD_API_KEY"]) assert.ok(!notebookText.includes(forbidden), forbidden);

const bundlePath = path.join(process.cwd(), ".secrets", "flux-first-image-colab-bundle.json");
if (existsSync(bundlePath)) {
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as { expires_at: string; files: Array<{ relative_path: string; size_bytes: number; sha256: string; download_url: string }> };
  assert.equal(bundle.files.length, 3);
  assert.ok(Date.parse(bundle.expires_at) > Date.now());
  for (const [index, file] of bundle.files.entries()) {
    assert.equal(file.size_bytes, FLUX_MODEL_FILES[index].size);
    assert.equal(file.sha256, FLUX_MODEL_FILES[index].sha256);
    const url = new URL(file.download_url);
    assert.equal(url.protocol, "https:");
    assert.ok(Number(url.searchParams.get("X-Amz-Expires")) <= 7200);
  }
}
console.log("Colab emergency notebook structure, fixed source, bundle metadata, expiry, and secret boundary tests passed.");
