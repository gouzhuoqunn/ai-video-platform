import { spawnSync } from "node:child_process";
import path from "node:path";
import { RunPodProvider } from "./gpu-providers/runpod";
import { sleep } from "./gpu-providers/common";

const intervalMs = 2 * 60_000;
const maxDurationMs = 20 * 60_000;
const execute = process.argv.includes("--execute");
const once = process.argv.includes("--once");

async function main() {
  const started = Date.now();
  let round = 0;
  while (Date.now() - started <= maxDurationMs) {
    round += 1;
    const candidates = await new RunPodProvider().listCandidates();
    const candidate = candidates.find((item) => item.id === "NVIDIA GeForce RTX 4090" || item.id === "NVIDIA GeForce RTX 5090");
    console.log(JSON.stringify({ provider: "runpod", event: "candidate_watch", round, checked_at: new Date().toISOString(), candidate_found: Boolean(candidate), creates_pod: execute && Boolean(candidate) }));
    if (candidate) {
      if (!execute) {
        console.log(JSON.stringify({ candidate_found: true, gpuTypeId: candidate.id, cloudType: candidate.cloudType, computeHourly: candidate.hourlyUsd, next_command: "npm run runpod:candidate:watch -- --execute", automatic_create: false }));
        return;
      }
      const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      const sessionId = `candidate-watch-${Date.now()}`;
      const result = spawnSync(process.execPath, [tsxCli, "scripts/gpu-first-image.ts", "--provider=runpod", "--execute", `--session-id=${sessionId}`, `--gpu-type=${candidate.id}`, `--cloud-type=${candidate.cloudType ?? "SECURE"}`], { cwd: process.cwd(), encoding: "utf8", stdio: "inherit" });
      if (result.status !== 0) throw new Error("runpod_candidate_watch_first_image_failed");
      return;
    }
    if (once) return;
    await sleep(intervalMs);
  }
  console.log(JSON.stringify({ provider: "runpod", event: "candidate_watch_complete", candidate_found: false, elapsed_minutes: 20, creates_pod: false }));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "RunPod candidate watch failed"); process.exitCode = 1; });
