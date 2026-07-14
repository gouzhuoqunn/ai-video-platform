import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BENCHMARK_SAMPLES } from "../benchmarks/v1/suite";

type PromptCase = {
  id: string;
  prompt: string;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  frames: number;
  fps: number;
  inputAsset: null | { path: string; source: string; sha256: string };
  evaluationDimensions: string[];
  timeoutSeconds: number;
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), relativePath), "utf8")) as T;
}

function validateCase(item: PromptCase) {
  assert.ok(item.id && item.prompt && item.negativePrompt);
  assert.ok(Number.isInteger(item.seed));
  assert.ok(item.width > 0 && item.height > 0 && item.steps > 0 && item.frames > 0 && item.fps > 0);
  assert.ok(item.evaluationDimensions.length > 0);
  assert.ok(item.timeoutSeconds > 0);
  assert.ok(!/nudity|gore|violence/i.test(item.prompt), `${item.id} prompt must not include unsafe benchmark content`);
  if (item.inputAsset) {
    const sha256 = createHash("sha256").update(readFileSync(item.inputAsset.path)).digest("hex");
    assert.equal(sha256, item.inputAsset.sha256);
    assert.match(item.inputAsset.source, /synthetic|public-domain/i);
  }
}

function main() {
  const image = readJson<{ schemaVersion: 1; suiteVersion: "v1"; cases: PromptCase[] }>("benchmark/image-prompts.json");
  const video = readJson<{ schemaVersion: 1; suiteVersion: "v1"; cases: PromptCase[] }>("benchmark/video-prompts.json");
  const workflows = readJson<{ cases: Array<{ workflowKey: string; task: string; sampleIds: string[] }> }>("benchmark/workflow-cases.json");
  const scoring = readJson<{ promotionBySoftware: boolean; blindReviewRequired: boolean; manualImageScores: string[]; manualVideoScores: string[] }>("benchmark/scoring-schema.json");
  const schema = readJson<{ required: string[]; properties: Record<string, unknown> }>("benchmark/benchmark-plan.schema.json");

  assert.equal(image.schemaVersion, 1);
  assert.equal(video.schemaVersion, 1);
  assert.equal(image.cases.length, 8);
  assert.equal(video.cases.length, 8);
  for (const item of [...image.cases, ...video.cases]) validateCase(item);

  const jsonIds = new Set([...image.cases, ...video.cases].map((item) => item.id));
  const suiteIds = new Set(BENCHMARK_SAMPLES.map((item) => item.id));
  assert.deepEqual(jsonIds, suiteIds);
  assert.ok([...jsonIds].some((id) => id.includes("two-person")));
  assert.ok([...jsonIds].some((id) => id.includes("object-motion")));
  assert.ok(workflows.cases.some((item) => item.task === "I2V"));
  assert.ok(workflows.cases.some((item) => item.task === "FLF2V"));
  assert.equal(scoring.promotionBySoftware, false);
  assert.equal(scoring.blindReviewRequired, true);
  assert.ok(scoring.manualImageScores.includes("anatomy"));
  assert.ok(scoring.manualVideoScores.includes("camera_motion_quality"));
  assert.ok(schema.required.includes("candidateKey"));
  assert.ok(schema.required.includes("timeoutSeconds"));

  console.log("benchmark schema tests passed");
}

main();
