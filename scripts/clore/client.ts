import type { CloreApiResponse, CloreConfig } from "./types";

const SECRET_PATTERNS = [
  /CLORE_API_KEY\s*=/i,
  /VAST_API_KEY\s*=/i,
  /SUPABASE_SECRET_KEY\s*=/i,
  /SUPABASE_SERVICE_ROLE_KEY\s*=/i,
  /GPU_WORKER_PASSWORD\s*=/i,
  /hf_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];

export function assertNoSecretOutput(value: string) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("Refusing to print secret-like output.");
  }
}

export function createCloreHeaders(apiKey: string) {
  return {
    auth: apiKey,
    "content-type": "application/json",
  };
}

export function buildCloreUrl(config: CloreConfig, endpoint: string) {
  if (endpoint.includes("?auth=") || endpoint.includes("CLORE_API_KEY")) {
    throw new Error("Refusing to put API credentials in a URL.");
  }

  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${config.apiBaseUrl}${normalizedEndpoint}`;
}

export function mapCloreCode(code: number) {
  if (code === 0) {
    return "success";
  }
  if (code === 5) {
    return "rate_limited";
  }
  return `clore_error_${code}`;
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(url: string, init: RequestInit, retriesRemaining: number): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (retriesRemaining <= 0) {
      throw error;
    }
    await sleep(1500);
    return fetchWithRetries(url, init, retriesRemaining - 1);
  }
}

export async function cloreRequest<T>(
  config: CloreConfig,
  endpoint: string,
  init: RequestInit = {},
  minDelayMs = 1000,
  retriesRemaining = 3,
): Promise<T> {
  if (!config.apiKey) {
    throw new Error("Missing CLORE_API_KEY for real Clore API request.");
  }

  const url = buildCloreUrl(config, endpoint);
  await sleep(minDelayMs);

  const response = await fetchWithRetries(url, {
    ...init,
    headers: {
      ...createCloreHeaders(config.apiKey),
      ...(init.headers ?? {}),
    },
  }, 2);

  const payload = (await response.json()) as CloreApiResponse<T> & Record<string, unknown>;
  if (payload.code === 5) {
    if (retriesRemaining <= 0) {
      throw new Error("Clore API rate limit persisted after retries.");
    }
    await sleep(2000);
    return cloreRequest<T>(config, endpoint, init, minDelayMs, retriesRemaining - 1);
  }

  if (payload.code !== 0) {
    throw new Error(`Clore API failed: ${mapCloreCode(payload.code)} ${payload.message ?? ""}`.trim());
  }

  return ("data" in payload ? payload.data : payload) as T;
}
