import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CloreConfig } from "./types";

const CLORE_ENV_PATH = path.join(process.cwd(), ".secrets", "clore.env");
const CLORE_TEMP_EXCLUDED_SERVERS_PATH = path.join(process.cwd(), ".secrets", "clore-temp-excluded-servers.json");
export const PROJECT_TAG = "ai-video-platform-wan22";
export const DEFAULT_DOCKER_IMAGE = "nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04";

function parseEnvFile(filePath: string) {
  if (!existsSync(filePath)) {
    return new Map<string, string>();
  }

  const values = new Map<string, string>();
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }

  return values;
}

function readNumber(name: string, fallback: number, fileValues: Map<string, string>) {
  const raw = fileValues.get(name) ?? process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readString(name: string, fallback: string, fileValues: Map<string, string>) {
  return (fileValues.get(name) ?? process.env[name] ?? fallback).trim();
}

function readOptionalString(name: string, fileValues: Map<string, string>) {
  const value = readString(name, "", fileValues);
  return value.length > 0 ? value : undefined;
}

function readAllowedCountries(fileValues: Map<string, string>) {
  const raw = readString("CLORE_ALLOWED_COUNTRIES", "", fileValues);
  return raw
    .split(",")
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);
}

function readExcludedServerIds(fileValues: Map<string, string>) {
  const fromEnv = readString("CLORE_EXCLUDED_SERVER_IDS", "", fileValues)
    .split(",")
    .map((serverId) => serverId.trim())
    .filter((serverId) => /^\d+$/.test(serverId));
  if (!existsSync(CLORE_TEMP_EXCLUDED_SERVERS_PATH)) {
    return [...new Set(fromEnv)];
  }
  try {
    const parsed = JSON.parse(readFileSync(CLORE_TEMP_EXCLUDED_SERVERS_PATH, "utf8")) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown[] }).servers)
        ? (parsed as { servers: unknown[] }).servers
        : [];
    const fromFile = values
      .map((value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : ""))
      .filter((serverId) => /^\d+$/.test(serverId));
    return [...new Set([...fromEnv, ...fromFile])];
  } catch {
    return [...new Set(fromEnv)];
  }
}

export function loadCloreConfig(): CloreConfig {
  const fileValues = parseEnvFile(CLORE_ENV_PATH);
  const apiKey = readOptionalString("CLORE_API_KEY", fileValues);

  return {
    apiBaseUrl: "https://api.clore.ai/v1",
    apiKey,
    apiKeySource: apiKey ? ".secrets/clore.env" : undefined,
    maxGpuPricePerHour: readNumber("CLORE_MAX_GPU_PRICE_PER_HOUR", 0.7, fileValues),
    minReliability: readNumber("CLORE_MIN_RELIABILITY", 0.99, fileValues),
    minRating: readNumber("CLORE_MIN_RATING", 4.7, fileValues),
    minRatingCount: readNumber("CLORE_MIN_RATING_COUNT", 3, fileValues),
    minRamGb: readNumber("CLORE_MIN_RAM_GB", 64, fileValues),
    minCpuCores: readNumber("CLORE_MIN_CPU_CORES", 8, fileValues),
    minDiskGb: readNumber("CLORE_MIN_DISK_GB", 200, fileValues),
    minDownloadMbps: readNumber("CLORE_MIN_DOWNLOAD_MBPS", 300, fileValues),
    minUploadMbps: readNumber("CLORE_MIN_UPLOAD_MBPS", 100, fileValues),
    allowedCountries: readAllowedCountries(fileValues),
    rentalCurrency: readString("CLORE_RENTAL_CURRENCY", "USD-Blockchain", fileValues) || "USD-Blockchain",
    dockerImage: readString("CLORE_DOCKER_IMAGE", DEFAULT_DOCKER_IMAGE, fileValues) || DEFAULT_DOCKER_IMAGE,
    orderType: "on-demand",
    sshPublicKeyPath: readOptionalString("CLORE_SSH_PUBLIC_KEY_PATH", fileValues) ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".ssh", "clore_ai_video_worker_ed25519.pub"),
    projectTag: readString("CLORE_PROJECT_TAG", PROJECT_TAG, fileValues) || PROJECT_TAG,
    assumedMinimumRentalHours: readNumber("CLORE_MIN_RENTAL_HOURS", 6, fileValues),
    excludedServerIds: readExcludedServerIds(fileValues),
  };
}

export function assertCloreApiKey(config: CloreConfig) {
  if (!config.apiKey) {
    throw new Error(
      "Missing CLORE_API_KEY. Create .secrets/clore.env later when you are ready for real marketplace or wallet queries. Mock and dry-run commands do not need it.",
    );
  }
}

export function getCloreEnvPath() {
  return CLORE_ENV_PATH;
}
