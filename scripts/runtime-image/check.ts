import { readFileSync } from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function checkRuntimeImageFiles() {
  const dockerfile = readFileSync(path.join(process.cwd(), "gpu-worker", "Dockerfile"), "utf8");
  const dockerignore = readFileSync(path.join(process.cwd(), "gpu-worker", ".dockerignore"), "utf8");
  const entrypoint = readFileSync(path.join(process.cwd(), "gpu-worker", "entrypoint.sh"), "utf8");
  const requirements = readFileSync(path.join(process.cwd(), "gpu-worker", "requirements.txt"), "utf8");

  assert(dockerfile.includes("nvidia/cuda:12.8.0"), "Dockerfile must use a CUDA 12.8 compatible base image.");
  assert(dockerfile.includes("python3.11"), "Dockerfile must install Python 3.11.");
  assert(dockerfile.includes("torch==2.7.1"), "Dockerfile must pin PyTorch 2.7.1.");
  assert(dockerfile.includes("https://download.pytorch.org/whl/cu128"), "PyTorch wheels must target cu128.");
  assert(dockerfile.includes("ffmpeg"), "Dockerfile must include ffmpeg.");
  assert(dockerfile.includes("git"), "Dockerfile must include git.");
  assert(dockerfile.includes("rclone"), "Dockerfile must include rclone or an S3-compatible sync tool.");
  assert(requirements.includes("huggingface_hub"), "Runtime requirements must include huggingface_hub.");
  assert(dockerfile.includes("Wan2.2"), "Dockerfile must install or prepare Wan2.2 runtime code.");
  assert(!/^EXPOSE\s/im.test(dockerfile), "Runtime image must not expose public ports.");
  assert(!dockerfile.includes("SUPABASE_SECRET_KEY"), "Runtime image must not reference Supabase Secret key.");
  assert(!dockerfile.includes("CLORE_API_KEY"), "Runtime image must not reference Clore API key.");
  assert(!dockerfile.includes("MODEL_CACHE_SECRET_ACCESS_KEY"), "Runtime image must not bake R2 credentials.");
  assert(entrypoint.includes("START_GPU_WORKER"), "Entrypoint must not auto-start the worker before bootstrap is ready.");
  assert(entrypoint.includes("tail -f /dev/null"), "Entrypoint must keep the container alive for SSH/bootstrap when worker env is absent.");
  assert(entrypoint.includes("has_worker_env"), "Entrypoint must gate worker startup on limited Worker credentials.");

  for (const ignored of [".env.local", ".secrets/", "models/", "*.safetensors", "*.ckpt", "*.pt", "*.pth", "*.bin", "*.gguf"]) {
    assert(dockerignore.includes(ignored), `.dockerignore must exclude ${ignored}.`);
  }

  return {
    runtime_image_ok: true,
    cuda: "12.8",
    python: "3.11",
    pytorch: "2.7.1+cu128",
    model_weights_in_image: false,
    public_ports_exposed: false,
  };
}

function main() {
  console.log(JSON.stringify(checkRuntimeImageFiles(), null, 2));
}

if (process.argv[1]?.endsWith("check.ts")) {
  main();
}
