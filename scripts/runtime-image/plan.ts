import { assertNoSecretOutput } from "../clore/client";

function main() {
  const plan = {
    dry_run: true,
    image: "ghcr.io/<user>/wan22-runtime:<immutable-version>",
    source: "gpu-worker/Dockerfile",
    platform: "linux/amd64",
    publishes_image_now: false,
    embeds_model_weights: false,
    embeds_secrets: false,
    required_future_steps: [
      "Choose the GitHub owner and immutable version tag.",
      "Build on a runner with Docker Buildx.",
      "Push to GHCR only after user confirmation.",
      "Keep Wan2.2 weights in local/volume/R2/Hugging Face cache, not in the image.",
    ],
  };
  const output = JSON.stringify(plan, null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

void main();
