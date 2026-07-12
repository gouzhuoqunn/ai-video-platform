import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MODEL_CACHE_ENV_PATH = path.join(process.cwd(), ".secrets", "model-cache.env");

export type ModelCacheConfig = {
  provider: "r2" | "none";
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
  readOnly: boolean;
  localDir: string;
  volumeDir: string;
  r2Enabled: boolean;
  hfFallbackEnabled: boolean;
  officialRepo: string;
  expectedSizeGb: number;
};

function parseEnvFile(filePath: string) {
  const values = new Map<string, string>();
  if (!existsSync(filePath)) {
    return values;
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (match) {
      values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
    }
  }

  return values;
}

function readString(values: Map<string, string>, name: string, fallback: string) {
  return (values.get(name) ?? process.env[name] ?? fallback).trim();
}

function readBool(values: Map<string, string>, name: string, fallback: boolean) {
  const raw = readString(values, name, fallback ? "true" : "false").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function loadModelCacheConfig(): ModelCacheConfig {
  const fileValues = parseEnvFile(MODEL_CACHE_ENV_PATH);
  const provider = readString(fileValues, "MODEL_CACHE_PROVIDER", "r2") === "r2" ? "r2" : "none";

  return {
    provider,
    bucket: readString(fileValues, "MODEL_CACHE_BUCKET", ""),
    prefix: readString(fileValues, "MODEL_CACHE_PREFIX", "wan22-ti2v-5b"),
    endpoint: readString(fileValues, "MODEL_CACHE_ENDPOINT", ""),
    region: readString(fileValues, "MODEL_CACHE_REGION", "auto"),
    readOnly: readBool(fileValues, "MODEL_CACHE_READ_ONLY", true),
    localDir: readString(fileValues, "MODEL_CACHE_LOCAL_DIR", "/workspace/models/Wan2.2-TI2V-5B"),
    volumeDir: readString(fileValues, "MODEL_CACHE_VOLUME_DIR", "/workspace/model-cache/Wan2.2-TI2V-5B"),
    r2Enabled: readBool(fileValues, "MODEL_CACHE_R2_ENABLED", true),
    hfFallbackEnabled: readBool(fileValues, "MODEL_CACHE_HF_FALLBACK_ENABLED", true),
    officialRepo: readString(fileValues, "WAN_MODEL_REPO", "Wan-AI/Wan2.2-TI2V-5B"),
    expectedSizeGb: 34.2,
  };
}

export function getModelCacheEnvPath() {
  return MODEL_CACHE_ENV_PATH;
}
