/** Idempotent, local-only seed for the first two-task RTX 4090 batch. */
import { mutateImageTasks, type LocalImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { FLUX_IMAGE_STACK } from "../../src/lib/image-generation/flux-stack";

type Seed = Pick<LocalImageTask, "id" | "status" | "updatedAt"> & Record<string, unknown>;
const seededAt = "2026-07-26T00:00:00.000Z";
const seeds: readonly Seed[] = [
  { id: "66d42c71-61e3-49f4-a867-2b2745bc0102", status: "waiting_for_gpu", priority: "urgent", mode: "text_generation", referenceImage: null, prompt: "Photorealistic traditional Chinese courtyard after summer rain, wet stone reflecting warm window light, subtle mist, cinematic natural lighting, highly detailed", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 271828, sampler: "Euler", attempts: 0, gpuClass: "rtx4090", badge: "low", modelStack: FLUX_IMAGE_STACK, createdAt: seededAt, updatedAt: seededAt },
  { id: "1c77684f-5632-4aec-9d86-3f3ee0380101", status: "waiting_for_gpu", priority: "normal", mode: "text_generation", referenceImage: null, prompt: "Cinematic alpine observatory at blue hour beneath dramatic clouds, realistic architecture, natural volumetric light, highly detailed photography", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 314159, sampler: "Euler", attempts: 0, gpuClass: "rtx4090", badge: "low", modelStack: FLUX_IMAGE_STACK, createdAt: seededAt, updatedAt: seededAt },
] as const;

function sameSeed(current: LocalImageTask, expected: Seed) {
  return JSON.stringify(current) === JSON.stringify(expected);
}

const result = mutateImageTasks((tasks) => {
  const next = [...tasks];
  for (const seed of seeds) {
    const existing = next.find((task) => task.id === seed.id);
    if (existing && !sameSeed(existing, seed)) throw new Error(`image_session_seed_conflict:${seed.id}`);
    if (!existing) next.push(structuredClone(seed) as LocalImageTask);
  }
  return { tasks: next, value: seeds.map(({ id, status, priority, mode, referenceImage, width, height, steps, cfg, loraStrength, seed, sampler, attempts }) => ({ id, status, priority, mode, referenceImage, width, height, steps, cfg, loraStrength, seed, sampler, attempts })) };
});

// Prompts intentionally never enter the command output or receipts.
console.log(JSON.stringify({ providerMutationCount: 0, tasks: result }, null, 2));
