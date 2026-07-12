import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getCloreEnvPath, loadCloreConfig } from "./config";
import { inspectSshPublicKey } from "./ssh";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const root = process.cwd();
  const packageJson = readFileSync(path.join(root, "package.json"), "utf8");
  const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
  const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  const dockerignore = readFileSync(path.join(root, "gpu-worker", ".dockerignore"), "utf8");
  const config = loadCloreConfig();
  const cloreEnvPath = getCloreEnvPath();
  const sshPublicKey = inspectSshPublicKey(config.sshPublicKeyPath ?? "");
  const sshPrivateKeyPath = sshPublicKey.path.endsWith(".pub") ? sshPublicKey.path.slice(0, -4) : "";

  assert(!packageJson.includes("vast:"), "package.json must not expose Vast npm commands.");
  assert(packageJson.includes("clore:find"), "package.json must expose clore:find.");
  assert(packageJson.includes("clore:create\""), "package.json must expose separate clore:create.");
  assert(packageJson.includes("check:clore-prep"), "package.json must expose check:clore-prep.");
  assert(!envExample.includes("VAST_API_KEY"), ".env.example must not contain VAST_API_KEY.");
  assert(envExample.includes("CLORE_API_KEY"), ".env.example must include CLORE_API_KEY placeholder.");
  assert(gitignore.includes(".secrets/"), ".secrets must be ignored.");
  assert(gitignore.includes(".secrets/clore-active-order.json"), "active Clore order state must be ignored explicitly.");
  assert(gitignore.includes(".secrets/clore-order-plan.json"), "Clore dry-run order plan must be ignored explicitly.");
  assert(gitignore.includes(".secrets/clore-session-state.json"), "Clore session state must be ignored explicitly.");
  assert(gitignore.includes(".secrets/model-cache.env"), "model cache credentials must be ignored explicitly.");
  assert(existsSync(path.join(root, "scripts", "clore", "mock-marketplace.json")), "mock marketplace is required.");
  assert(existsSync(path.join(root, "scripts", "clore", "session-orchestrator.ts")), "Clore session orchestrator is required.");
  assert(existsSync(path.join(root, "scripts", "model-cache", "plan-sync.ts")), "model cache plan script is required.");
  assert(existsSync(path.join(root, "docs", "CLORE_DEPLOYMENT.md")), "Clore deployment doc is required.");
  assert(existsSync(cloreEnvPath), ".secrets/clore.env must exist for live read-only Clore checks.");
  assert(Boolean(config.apiKey), "CLORE_API_KEY must be readable from .secrets/clore.env.");
  assert(dockerignore.includes(".secrets/"), "Docker build context must exclude .secrets.");
  assert(sshPublicKey.exists, "Clore SSH public key must exist.");
  assert(sshPublicKey.formatValid, "Clore SSH public key must be a valid ssh-ed25519 public key.");
  assert(sshPrivateKeyPath.length > 0 && existsSync(sshPrivateKeyPath), "Clore SSH private key must exist locally.");
  assert(!path.resolve(sshPrivateKeyPath).startsWith(root), "SSH private key must not be inside the project directory.");

  const uploadScript = readFileSync(path.join(root, "scripts", "clore", "upload-worker.ps1"), "utf8");
  assert(!uploadScript.includes(".env.local"), "upload script must not upload .env.local.");
  assert(!/id_rsa|\.pem/i.test(uploadScript), "upload script must not reference SSH private keys.");
  assert(uploadScript.includes(".secrets/gpu-worker.env"), "upload script should upload only limited Worker credentials.");
  console.log("Clore准备检查通过。");
}

void main();
