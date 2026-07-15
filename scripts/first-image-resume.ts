import { nextFirstImageStage, readFirstImageState } from "./first-image-state";

const state = readFirstImageState();
console.log(JSON.stringify({ resumable: Boolean(state), provider: state?.provider ?? null, completed: state?.completed ?? [], next_stage: state ? nextFirstImageStage(state) : "candidate_selected", creates_order: false, does_not_repeat_verified_models_or_generated_images: true }, null, 2));
