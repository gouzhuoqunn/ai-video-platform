import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readSourceAcquisitionManifest, readValidatedRestoreManifest, type SourceAcquisitionManifest, type ValidatedRestoreManifest } from "./manifests";

export const IMAGE_RUNNER_PRECHECK_STAGE = "preflight";
export const RESTORE_OR_BOOTSTRAP_BLOCKER =
  "未找到已验证的 FLUX 模型恢复清单，且首次模型下载配置尚未完成。";
export const EXECUTOR_FLAG_BLOCKER =
  "图像执行器尚未通过完整发布校验：等待 Runtime digest、模型清单、取消保护和结果保存测试全部通过。";
export const STALE_RUNNER_NO_ORDER_MESSAGE =
  "图像执行进程已意外退出，未创建显卡订单。";

export type ImageExecutorReadiness =
  | { ready: true; mode: "restore_manifest"; blocker: null; restoreManifest: ValidatedRestoreManifest }
  | { ready: true; mode: "first_run_bootstrap"; blocker: null; sourceManifest: SourceAcquisitionManifest }
  | { ready: false; mode: "not_ready"; blocker: string; code: string };

export type ImageExecutorPaths = {
  restoreManifestPath: string;
  sourceManifestPath: string;
};

function parseEnvFile(filePath: string) {
  const values = new Map<string, string>();
  if (!existsSync(filePath)) return values;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (match) values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

function secretValue(fileName: string, name: string) {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  return parseEnvFile(path.join(process.cwd(), ".secrets", fileName)).get(name)?.trim() ?? "";
}

function hasR2Credentials(fileName: string) {
  const values = parseEnvFile(path.join(process.cwd(), ".secrets", fileName));
  const access = values.get("MODEL_CACHE_ACCESS_KEY_ID") || values.get("R2_ACCESS_KEY_ID") || values.get("R2_READONLY_ACCESS_KEY_ID") || process.env.MODEL_CACHE_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || process.env.R2_READONLY_ACCESS_KEY_ID;
  const secret = values.get("MODEL_CACHE_SECRET_ACCESS_KEY") || values.get("R2_SECRET_ACCESS_KEY") || values.get("R2_READONLY_SECRET_ACCESS_KEY") || process.env.MODEL_CACHE_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || process.env.R2_READONLY_SECRET_ACCESS_KEY;
  const bucket = values.get("MODEL_CACHE_BUCKET") || values.get("R2_BUCKET_NAME") || process.env.MODEL_CACHE_BUCKET || process.env.R2_BUCKET_NAME;
  return Boolean(access?.trim() && secret?.trim() && bucket?.trim());
}

export function validateFirstRunBootstrapConfig(sourceManifestPath: string) {
  const sourceManifest = readSourceAcquisitionManifest(sourceManifestPath);
  for (const artifact of sourceManifest.artifacts) {
    if (artifact.metadata_only) continue;
    if (!artifact.size_bytes || !artifact.sha256) throw new Error(`bootstrap_artifact_missing_identity:${artifact.id}`);
    if (artifact.auth === "civitai_token" && !secretValue("civitai.env", "CIVITAI_API_TOKEN")) throw new Error("missing_bootstrap_secret:CIVITAI_API_TOKEN");
    if (artifact.auth === "huggingface_token" && !secretValue("huggingface.env", "HF_TOKEN")) throw new Error("missing_bootstrap_secret:HF_TOKEN");
  }
  if (!hasR2Credentials("model-cache-admin.env")) throw new Error("missing_bootstrap_r2_admin_credentials");
  if (!hasR2Credentials("model-cache-readonly.env")) throw new Error("missing_bootstrap_r2_readonly_credentials");
  return sourceManifest;
}

export function imageExecutorReadiness(paths: ImageExecutorPaths): ImageExecutorReadiness {
  if (process.env.IMAGE_4090_EXECUTOR_READY !== "true") {
    return { ready: false, mode: "not_ready", blocker: EXECUTOR_FLAG_BLOCKER, code: "executor_flag_disabled" };
  }
  try {
    if (existsSync(paths.restoreManifestPath)) {
      return { ready: true, mode: "restore_manifest", blocker: null, restoreManifest: readValidatedRestoreManifest(paths.restoreManifestPath) };
    }
  } catch (error) {
    return { ready: false, mode: "not_ready", blocker: error instanceof Error ? error.message : String(error), code: "invalid_restore_manifest" };
  }
  try {
    return { ready: true, mode: "first_run_bootstrap", blocker: null, sourceManifest: validateFirstRunBootstrapConfig(paths.sourceManifestPath) };
  } catch {
    return { ready: false, mode: "not_ready", blocker: RESTORE_OR_BOOTSTRAP_BLOCKER, code: "restore_manifest_missing_and_bootstrap_incomplete" };
  }
}

export function assertImageExecutorReady(paths: ImageExecutorPaths) {
  const readiness = imageExecutorReadiness(paths);
  if (!readiness.ready) throw new Error(readiness.code === "restore_manifest_missing_and_bootstrap_incomplete" ? RESTORE_OR_BOOTSTRAP_BLOCKER : readiness.blocker);
  return readiness;
}

export function processExists(pid: number | null | undefined) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeRunnerLog(text: string) {
  return text
    .replace(/X-Amz-[A-Za-z0-9_-]+=[^&\s"]+/g, "X-Amz-REDACTED=REDACTED")
    .replace(/([?&](?:token|api_key|key|signature|password|access_token)=)[^&\s"]+/gi, "$1REDACTED")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1REDACTED")
    .replace(/((?:CIVITAI_API_TOKEN|HF_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*)[^\s"]+/gi, "$1REDACTED");
}

export function finalSanitizedLogLines(text: string, count = 8) {
  return sanitizeRunnerLog(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-count);
}
