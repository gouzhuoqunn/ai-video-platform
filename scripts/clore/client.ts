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

const NORMAL_INTERVAL_MS = 1100;
const CREATE_INTERVAL_MS = 6000;
const MARKETPLACE_CACHE_MS = 60_000;
const STATE_CACHE_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = [2000, 4000, 8000, 15000];

export type CloreRequestOptions = {
  forceRefresh?: boolean;
  onCreateUncertain?: () => Promise<boolean>;
  beforeCreateRetry?: () => Promise<void>;
};

type FetchLike = typeof fetch;
type SchedulerDependencies = {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  log?: (event: Record<string, unknown>) => void;
};

type CachedResponse = { expiresAt: number; value: unknown };
type QueueItem<T> = { priority: number; run: () => Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

export function assertNoSecretOutput(value: string) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) throw new Error("Refusing to print secret-like output.");
}

export function createCloreHeaders(apiKey: string) {
  return { auth: apiKey, "content-type": "application/json" };
}

export function buildCloreUrl(config: CloreConfig, endpoint: string) {
  if (endpoint.includes("?auth=") || endpoint.includes("CLORE_API_KEY")) throw new Error("Refusing to put API credentials in a URL.");
  return `${config.apiBaseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

export function mapCloreCode(code: number) {
  if (code === 0) return "success";
  if (code === 5) return "rate_limited";
  return `clore_error_${code}`;
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheTtl(endpoint: string) {
  if (endpoint === "/marketplace") return MARKETPLACE_CACHE_MS;
  if (endpoint === "/wallets" || endpoint === "/my_orders") return STATE_CACHE_MS;
  return 0;
}

function priority(endpoint: string) {
  if (endpoint === "/cancel_order") return 100;
  if (endpoint === "/create_order") return 80;
  if (endpoint === "/my_orders" || endpoint === "/wallets") return 50;
  return 10;
}

function retryAfterMs(response: Response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export class CloreRequestScheduler {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly log: (event: Record<string, unknown>) => void;
  private queue: QueueItem<unknown>[] = [];
  private draining = false;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private lastCreateAt = Number.NEGATIVE_INFINITY;
  private readonly cache = new Map<string, CachedResponse>();
  private activeCreate: Promise<unknown> | null = null;

  constructor(dependencies: SchedulerDependencies = {}) {
    this.fetchFn = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.sleepFn = dependencies.sleep ?? sleep;
    this.jitter = dependencies.jitter ?? Math.random;
    this.log = dependencies.log ?? ((event) => console.info(JSON.stringify(event)));
  }

  private async enqueue<T>(requestPriority: number, run: () => Promise<T>) {
    return await new Promise<T>((resolve, reject) => {
      this.queue.push({ priority: requestPriority, run, resolve, reject } as QueueItem<unknown>);
      this.queue.sort((left, right) => right.priority - left.priority);
      void this.drain();
    });
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        try {
          next.resolve(await next.run());
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async waitForSlot(endpoint: string) {
    const now = this.now();
    const normalDelay = Math.max(0, this.lastRequestAt + NORMAL_INTERVAL_MS - now);
    const createDelay = endpoint === "/create_order" ? Math.max(0, this.lastCreateAt + CREATE_INTERVAL_MS - now) : 0;
    const delay = Math.max(normalDelay, createDelay);
    if (delay > 0) await this.sleepFn(delay);
    const started = this.now();
    this.lastRequestAt = started;
    if (endpoint === "/create_order") this.lastCreateAt = started;
  }

  private backoff(attempt: number, retryAfter: number | null) {
    const base = retryAfter ?? RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
    return base + Math.floor(this.jitter() * 300);
  }

  async request<T>(config: CloreConfig, endpoint: string, init: RequestInit = {}, options: CloreRequestOptions = {}): Promise<T> {
    if (!config.apiKey) throw new Error("Missing CLORE_API_KEY for real Clore API request.");
    const ttl = cacheTtl(endpoint);
    const cacheKey = endpoint;
    const cached = this.cache.get(cacheKey);
    if (ttl > 0 && !options.forceRefresh && cached && cached.expiresAt > this.now()) return cached.value as T;
    if (endpoint === "/create_order" && this.activeCreate) return this.activeCreate as Promise<T>;

    const work = this.enqueue(priority(endpoint), async () => {
      const url = buildCloreUrl(config, endpoint);
      let rateLimitAttempts = 0;
      let networkAttempts = 0;
      while (true) {
        await this.waitForSlot(endpoint);
        let response: Response;
        try {
          response = await this.fetchFn(url, { ...init, headers: { ...createCloreHeaders(config.apiKey!), ...(init.headers ?? {}) } });
        } catch (error) {
          if (networkAttempts >= 2) throw error;
          networkAttempts += 1;
          if (endpoint === "/create_order" && await options.onCreateUncertain?.()) {
            throw new Error("create_order outcome uncertain: active order found during recovery.");
          }
          if (endpoint === "/create_order") await options.beforeCreateRetry?.();
          const delay = this.backoff(networkAttempts - 1, null);
          this.log({ endpoint, at: new Date().toISOString(), status: "network_error", retry: networkAttempts });
          await this.sleepFn(delay);
          continue;
        }

        const retryAfter = retryAfterMs(response);
        const raw = await response.json().catch(() => ({}));
        const payload = raw as CloreApiResponse<T> & Record<string, unknown>;
        const code = typeof payload.code === "number" ? payload.code : response.ok ? 0 : response.status;
        this.log({ endpoint, at: new Date().toISOString(), status: response.status, retry: rateLimitAttempts });
        if (response.status === 429 || code === 5) {
          if (rateLimitAttempts >= 3) throw new Error("Clore API rate limit persisted after retries.");
          rateLimitAttempts += 1;
          if (endpoint === "/create_order") await options.beforeCreateRetry?.();
          await this.sleepFn(this.backoff(rateLimitAttempts - 1, retryAfter));
          continue;
        }
        if (code !== 0) throw new Error(`Clore API failed: ${mapCloreCode(code)} ${payload.message ?? ""}`.trim());
        const value = ("data" in payload ? payload.data : payload) as T;
        if (ttl > 0) this.cache.set(cacheKey, { value, expiresAt: this.now() + ttl });
        return value;
      }
    });
    if (endpoint !== "/create_order") return work;
    this.activeCreate = work;
    try {
      return await work as T;
    } finally {
      this.activeCreate = null;
    }
  }
}

export const cloreScheduler = new CloreRequestScheduler();

export async function cloreRequest<T>(config: CloreConfig, endpoint: string, init: RequestInit = {}, options: CloreRequestOptions = {}): Promise<T> {
  return await cloreScheduler.request<T>(config, endpoint, init, options);
}
