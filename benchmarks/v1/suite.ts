export type BenchmarkAssetKind = "image" | "video";
export type BenchmarkSample = {
  id: string;
  blindSampleId: string;
  kind: BenchmarkAssetKind;
  category: string;
  prompt: string;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  inputAsset?: { path: string; source: string; sha256: string };
};

const NEGATIVE = "low resolution, distorted anatomy, duplicate limbs, unreadable text, watermark, logo, nudity, gore, violence";
const SYNTHETIC_ASSET = {
  path: "benchmarks/v1/assets/synthetic-checker.ppm",
  source: "repository-owned synthetic public-domain fixture",
  sha256: "f79c80e447c452651a19f0404baf5f162aa3498c10f2341ed381b0c13279205a",
};

export const BENCHMARK_SUITE_VERSION = "v1";

export const BENCHMARK_SAMPLES: BenchmarkSample[] = [
  { id: "image-cinematic-closeup", blindSampleId: "IMG-01", kind: "image", category: "cinematic single-person close-up", prompt: "A fictional adult explorer in a cinematic close-up, warm window light, detailed fabric, 50mm lens, calm expression", negativePrompt: NEGATIVE, seed: 4101, width: 768, height: 1024, frames: 1, fps: 1, steps: 4 },
  { id: "image-full-body-hands", blindSampleId: "IMG-02", kind: "image", category: "full body with complex hands", prompt: "A fictional adult craftsperson standing full body in a bright studio, both hands assembling a small wooden model, accurate fingers, documentary composition", negativePrompt: NEGATIVE, seed: 4102, width: 768, height: 1024, frames: 1, fps: 1, steps: 4 },
  { id: "image-two-people", blindSampleId: "IMG-03", kind: "image", category: "two people in one frame", prompt: "Two fictional adult friends sharing a table in a quiet cafe, natural interaction, balanced two-person composition", negativePrompt: NEGATIVE, seed: 4103, width: 1024, height: 768, frames: 1, fps: 1, steps: 4 },
  { id: "image-interior-light", blindSampleId: "IMG-04", kind: "image", category: "complex indoor lighting", prompt: "A compact library interior with warm lamps, cool daylight, reflective glass, layered shelves, cinematic exposure", negativePrompt: NEGATIVE, seed: 4104, width: 1024, height: 768, frames: 1, fps: 1, steps: 4 },
  { id: "image-exterior-wide", blindSampleId: "IMG-05", kind: "image", category: "outdoor wide angle", prompt: "A wide coastal boardwalk at sunrise, small distant figures, sea mist, architectural perspective, 24mm lens", negativePrompt: NEGATIVE, seed: 4105, width: 1280, height: 704, frames: 1, fps: 1, steps: 4 },
  { id: "image-identity-consistency", blindSampleId: "IMG-06", kind: "image", category: "same fictional identity across shots", prompt: "A fictional adult botanist with a mustard jacket in a greenhouse, recognizable facial features, medium shot", negativePrompt: NEGATIVE, seed: 4106, width: 768, height: 1024, frames: 1, fps: 1, steps: 4 },
  { id: "image-first-last-scene", blindSampleId: "IMG-07", kind: "image", category: "matching first and last scene", prompt: "A small paper sailboat on a calm indoor water table, front-facing composition, soft afternoon light", negativePrompt: NEGATIVE, seed: 4107, width: 1280, height: 704, frames: 1, fps: 1, steps: 4 },
  { id: "image-bilingual-complex", blindSampleId: "IMG-08", kind: "image", category: "Chinese and English prompt adherence", prompt: "一间安静的现代茶室，wood grain table, a blue ceramic cup, diffuse morning light, precise composition, no written words", negativePrompt: NEGATIVE, seed: 4108, width: 1024, height: 768, frames: 1, fps: 1, steps: 4 },
  { id: "video-subtle-motion", blindSampleId: "VID-01", kind: "video", category: "static person subtle motion", prompt: "A fictional adult musician seated beside a window, a subtle breath and small head turn, locked camera, gentle daylight", negativePrompt: NEGATIVE, seed: 5101, width: 854, height: 480, frames: 49, fps: 24, steps: 20, inputAsset: SYNTHETIC_ASSET },
  { id: "video-body-motion", blindSampleId: "VID-02", kind: "video", category: "clear body motion", prompt: "A fictional adult dancer takes three calm steps across an empty rehearsal room, full body, stable floor contact, fixed camera", negativePrompt: NEGATIVE, seed: 5102, width: 854, height: 480, frames: 49, fps: 24, steps: 20, inputAsset: SYNTHETIC_ASSET },
  { id: "video-pan", blindSampleId: "VID-03", kind: "video", category: "camera pan", prompt: "Slow horizontal camera pan across a quiet model village at golden hour, smooth motion, no sudden cuts", negativePrompt: NEGATIVE, seed: 5103, width: 854, height: 480, frames: 49, fps: 24, steps: 20, inputAsset: SYNTHETIC_ASSET },
  { id: "video-dolly", blindSampleId: "VID-04", kind: "video", category: "dolly in or out", prompt: "A gentle camera push toward a ceramic still life on a wooden table, shallow depth of field, stable geometry", negativePrompt: NEGATIVE, seed: 5104, width: 854, height: 480, frames: 49, fps: 24, steps: 20, inputAsset: SYNTHETIC_ASSET },
  { id: "video-i2v-single-frame", blindSampleId: "VID-05", kind: "video", category: "single first-frame I2V", prompt: "The synthetic scene gains a soft breeze and subtle parallax, preserve the first frame composition", negativePrompt: NEGATIVE, seed: 5105, width: 854, height: 480, frames: 49, fps: 24, steps: 20, inputAsset: SYNTHETIC_ASSET },
  { id: "video-flf2v-transition", blindSampleId: "VID-06", kind: "video", category: "first-last-frame transition candidate", prompt: "A calm transition from the first composition to a matching final composition, preserve object identity and smooth camera motion", negativePrompt: NEGATIVE, seed: 5106, width: 854, height: 480, frames: 49, fps: 24, steps: 20, inputAsset: SYNTHETIC_ASSET },
];
