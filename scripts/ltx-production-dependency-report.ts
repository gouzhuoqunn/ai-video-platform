import { readFileSync } from "node:fs";
import path from "node:path";

export function checkLtxProductionDependencies() {
  const root = path.join(process.cwd(), "ltx-runtime", "python");
  const runtime = readFileSync(path.join(root, "requirements-runtime.lock"), "utf8");
  const source = readFileSync(path.join(root, "requirements-source.lock"), "utf8");
  const revision = "9377758131b1ffde4b7f766804590a6617bf2ab9";
  const required = ["torch==2.7.1+cu128", "torchaudio==2.7.1+cu128", "torchvision==0.22.1+cu128", "av==15.0.0", "transformers==4.52.4", "safetensors==0.5.3"];
  const missing = required.filter((entry) => !runtime.includes(entry));
  const sourceEntries = source.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith("#"));
  const sourcePinned = sourceEntries.length === 2 && sourceEntries.every((entry) => entry.includes(`@${revision}`) && !entry.includes("@main"));
  if (missing.length || !sourcePinned) throw new Error(`ltx_dependency_lock_invalid:${[...missing, sourcePinned ? "" : "source_revision"].filter(Boolean).join(",")}`);
  return { ok: true, python: "3.12+", torchCuda: "2.7.1+cu128", officialSourceRevision: revision, flashAttention: "not claimed", modelDownloads: 0 };
}
if (process.argv[1]?.endsWith("ltx-production-dependency-report.ts")) console.log(JSON.stringify(checkLtxProductionDependencies()));
