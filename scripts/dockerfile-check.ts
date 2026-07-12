import { readFileSync } from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const dockerfile = readFileSync(path.join(process.cwd(), "gpu-worker", "Dockerfile"), "utf8");
  assert(dockerfile.includes("nvidia/cuda:12.8.0"), "Dockerfile must use CUDA 12.8 base image");
  assert(!/^EXPOSE\s/im.test(dockerfile), "Dockerfile must not expose public ports");
  assert(dockerfile.includes("torch==2.7.1"), "Dockerfile must pin PyTorch 2.7.1");
  assert(dockerfile.includes("ffmpeg"), "Dockerfile must install ffmpeg");
  assert(dockerfile.includes("rclone"), "Dockerfile must install rclone or S3-compatible sync tooling");
  assert(dockerfile.includes("HF_HUB_DISABLE_TELEMETRY=1"), "Dockerfile must disable HF telemetry");
  assert(!dockerfile.includes("SUPABASE_SECRET_KEY"), "Dockerfile must not reference Supabase Secret key");
  assert(!dockerfile.includes("CLORE_API_KEY"), "Dockerfile must not reference Clore API key");
  assert(!dockerfile.includes("MODEL_CACHE_SECRET_ACCESS_KEY"), "Dockerfile must not reference R2 secret key");
  assert(!dockerfile.includes("COPY models"), "Dockerfile must not copy model weights into the image");
  console.log("Dockerfile静态检查通过。");
}

void main();
