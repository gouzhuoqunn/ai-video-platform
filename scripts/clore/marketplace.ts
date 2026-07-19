import type { CloreCandidate, CloreConfig, RawCloreServer } from "./types";

export const CLORE_RENTER_FEE_RATE = 0.05;
export const CLORE_CREATION_FEE_USD = 0.1;
export const CLORE_DEFAULT_MAX_SESSION_HOURS = 380 / 60;

export function computeCloreProjectedCost(baseHourlyUsd: number | null, sessionHours: number) {
  if (baseHourlyUsd === null || !Number.isFinite(sessionHours) || sessionHours <= 0) {
    return {
      baseHourlyUsd,
      effectiveHourlyUsd: null,
      projectedTotalUsd: null,
      renterFeeRate: CLORE_RENTER_FEE_RATE,
      creationFeeUsd: CLORE_CREATION_FEE_USD,
      sessionHours,
    };
  }
  const effectiveHourlyUsd = baseHourlyUsd * (1 + CLORE_RENTER_FEE_RATE);
  return {
    baseHourlyUsd,
    effectiveHourlyUsd,
    projectedTotalUsd: CLORE_CREATION_FEE_USD + effectiveHourlyUsd * sessionHours,
    renterFeeRate: CLORE_RENTER_FEE_RATE,
    creationFeeUsd: CLORE_CREATION_FEE_USD,
    sessionHours,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown) {
  return asArray(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function firstString(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim().toLowerCase();
      const match = /([\d.]+)/.exec(normalized);
      if (match && Number.isFinite(Number(match[1]))) {
        const number = Number(match[1]);
        if (normalized.includes("mb")) return number / 1024;
        return number;
      }
    }
  }
  return null;
}

function firstNumberWithSource(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return { value, source: name };
    }
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim().toLowerCase();
      const match = /([\d.]+)/.exec(normalized);
      if (match && Number.isFinite(Number(match[1]))) {
        return { value: Number(match[1]), source: name };
      }
    }
  }
  return null;
}

function firstBoolean(record: Record<string, unknown>, names: string[], fallback = false) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
  }
  return fallback;
}

function nestedRecord(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = asRecord(record[name]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function nestedNumber(record: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = record;
    for (const segment of path) {
      current = asRecord(current)?.[segment];
    }
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current === "string" && Number.isFinite(Number(current))) return Number(current);
  }
  return null;
}

function nestedNumberWithSource(record: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = record;
    for (const segment of path) {
      current = asRecord(current)?.[segment];
    }
    if (typeof current === "number" && Number.isFinite(current)) return { value: current, source: path.join(".") };
    if (typeof current === "string" && Number.isFinite(Number(current))) return { value: Number(current), source: path.join(".") };
  }
  return null;
}

function normalizeGpuName(name: string) {
  const squashed = name.replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "").replace(/\s+/g, " ").trim();
  if (/^RTX 5090$/i.test(squashed)) {
    return "NVIDIA GeForce RTX 5090";
  }
  if (/^RTX 4090$/i.test(squashed)) {
    return "NVIDIA GeForce RTX 4090";
  }
  return name.replace(/\s+/g, " ").trim();
}

function getGpuName(raw: RawCloreServer) {
  const gpu = nestedRecord(raw, ["gpu", "gpus"]);
  const gpuArray = asArray(raw.gpu_array);
  const firstGpu = asRecord(gpuArray[0]);
  const firstGpuString = typeof gpuArray[0] === "string" ? gpuArray[0].trim() : null;
  const specs = nestedRecord(raw, ["specs"]);
  return (
    firstString(raw, ["gpu_name", "gpu", "card", "name"]) ??
    (gpu ? firstString(gpu, ["name", "model", "gpu_name"]) : null) ??
    (firstGpu ? firstString(firstGpu, ["name", "model", "gpu_name"]) : null) ??
    firstGpuString ??
    (specs ? firstString(specs, ["gpu"]) : null) ??
    ""
  );
}

function getGpuCount(raw: RawCloreServer) {
  const gpuArray = asArray(raw.gpu_array);
  return firstNumber(raw, ["gpu_count", "num_gpus", "cards"]) ?? (gpuArray.length > 0 ? gpuArray.length : 1);
}

function getOnDemandUsdPrice(raw: RawCloreServer) {
  const hourly =
    firstNumberWithSource(raw, ["price_usd_per_hour", "usd_per_hour", "price_per_hour_usd", "on_demand_usd_per_hour", "price_on_demand_usd_hour"]) ??
    firstNumberWithSource(nestedRecord(raw, ["pricing", "price", "on_demand"]) ?? {}, ["usd_per_hour", "hourly_usd", "price_usd_per_hour"]);
  if (hourly) {
    return {
      value: hourly.value,
      source: "usd_per_hour",
      originalAmount: hourly.value,
      originalCurrency: "USD" as const,
      originalUnit: "hour" as const,
      originalLabel: `${hourly.value} USD/hour`,
    };
  }

  const daily =
    firstNumberWithSource(raw, ["price_usd_per_day", "usd_per_day", "on_demand_usd_per_day"]) ??
    firstNumberWithSource(nestedRecord(raw, ["pricing", "price", "on_demand"]) ?? {}, ["usd_per_day", "daily_usd", "price_usd_per_day"]) ??
    nestedNumberWithSource(raw, [
      ["price", "usd", "on_demand_usd"],
      ["price", "usd", "on_demand"],
      ["price", "usd", "on_demand_price"],
      ["price", "usd", "on_demand_clore"],
    ]);
  if (daily) {
    return {
      value: daily.value / 24,
      source: "usd_per_24h",
      originalAmount: daily.value,
      originalCurrency: "USD" as const,
      originalUnit: "day" as const,
      originalLabel: `${daily.value} USD/day`,
    };
  }

  const btcDaily = firstNumberWithSource(raw, ["btc_per_day", "price_btc_per_day"]) ?? firstNumberWithSource(nestedRecord(raw, ["pricing", "price"]) ?? {}, ["btc_per_day"]);
  if (btcDaily) {
    return {
      value: null,
      source: "btc_day_not_converted",
      originalAmount: btcDaily.value,
      originalCurrency: "BTC" as const,
      originalUnit: "day" as const,
      originalLabel: `${btcDaily.value} BTC/day`,
    };
  }

  const cloreDaily = firstNumberWithSource(raw, ["clore_per_day", "price_clore_per_day"]) ?? firstNumberWithSource(nestedRecord(raw, ["pricing", "price"]) ?? {}, ["clore_per_day"]);
  if (cloreDaily) {
    return {
      value: null,
      source: "clore_day_not_converted",
      originalAmount: cloreDaily.value,
      originalCurrency: "CLORE" as const,
      originalUnit: "day" as const,
      originalLabel: `${cloreDaily.value} CLORE/day`,
    };
  }

  return {
    value: null,
    source: null,
    originalAmount: null,
    originalCurrency: null,
    originalUnit: null,
    originalLabel: null,
  };
}

function getGpuMemory(raw: RawCloreServer, gpuNormalizedName: string, config: CloreConfig) {
  const nestedGpu = nestedRecord(raw, ["gpu", "gpus"]);
  const specs = nestedRecord(raw, ["specs"]) ?? {};
  const gpuArray = asArray(raw.gpu_array);
  const firstGpu = asRecord(gpuArray[0]) ?? {};
  const sources: Array<{ record: Record<string, unknown>; fields: string[]; unit: "bytes" | "MB" | "MiB" | "GB" | "GiB" | "display_gb" }> = [
    { record: raw, fields: ["gpu_memory_bytes", "gpu_ram_bytes", "vram_bytes"], unit: "bytes" },
    { record: raw, fields: ["gpu_memory_mib", "gpu_ram_mib", "vram_mib"], unit: "MiB" },
    { record: raw, fields: ["gpu_memory_mb", "gpu_ram_mb", "vram_mb"], unit: "MB" },
    { record: raw, fields: ["gpu_memory_gib", "gpu_ram_gib", "vram_gib"], unit: "GiB" },
    { record: raw, fields: ["gpu_memory_gb", "gpu_ram_gb", "vram_gb"], unit: "GB" },
    { record: nestedGpu ?? {}, fields: ["memory_mib", "vram_mib"], unit: "MiB" },
    { record: nestedGpu ?? {}, fields: ["memory_mb", "vram_mb"], unit: "MB" },
    { record: nestedGpu ?? {}, fields: ["memory_gib", "vram_gib"], unit: "GiB" },
    { record: nestedGpu ?? {}, fields: ["memory_gb", "vram_gb"], unit: "GB" },
    { record: firstGpu, fields: ["memory_mib", "vram_mib"], unit: "MiB" },
    { record: firstGpu, fields: ["memory_mb", "vram_mb"], unit: "MB" },
    { record: firstGpu, fields: ["memory_gib", "vram_gib"], unit: "GiB" },
    { record: firstGpu, fields: ["memory_gb", "vram_gb"], unit: "GB" },
    { record: specs, fields: ["gpuram", "gpu_ram", "vram"], unit: "display_gb" },
  ];

  let rawValue: number | null = null;
  let rawUnit: "bytes" | "MB" | "MiB" | "GB" | "GiB" | "display_gb" | null = null;
  let source: string | null = null;
  for (const entry of sources) {
    const found = firstNumberWithSource(entry.record, entry.fields);
    if (found) {
      rawValue = found.value;
      rawUnit = entry.unit;
      source = found.source;
      break;
    }
  }

  const memoryMiB =
    rawValue === null || rawUnit === null
      ? null
      : rawUnit === "bytes"
        ? rawValue / 1024 / 1024
        : rawUnit === "MB"
          ? rawValue / 1.048576
          : rawUnit === "MiB"
            ? rawValue
            : rawUnit === "GB" || rawUnit === "display_gb"
              ? rawValue * 1024
              : rawValue * 1024;

  const exactRtx5090 = gpuNormalizedName === "NVIDIA GeForce RTX 5090";
  const exactRtx4090 = gpuNormalizedName === "NVIDIA GeForce RTX 4090";
  const preciseUnit = rawUnit === "bytes" || rawUnit === "MB" || rawUnit === "MiB";
  const acceptsRoundedTargetVram =
    !preciseUnit &&
    rawValue !== null &&
    ((config.targetGpu === "NVIDIA GeForce RTX 5090" && exactRtx5090 && rawValue >= 30.5) ||
      (config.targetGpu === "NVIDIA GeForce RTX 4090" && exactRtx4090 && rawValue >= 23));
  const accepted =
    memoryMiB !== null &&
    (memoryMiB >= config.minGpuVramGb * 1024 || acceptsRoundedTargetVram);
  const note =
    memoryMiB === null
      ? "GPU memory missing"
      : acceptsRoundedTargetVram && rawValue !== null && rawValue < config.minGpuVramGb
        ? `API rounded/usable VRAM display (${rawValue} ${rawUnit}); accepted by exact ${config.targetGpu.replace("NVIDIA GeForce ", "")} model rule`
        : "GPU memory evaluated from API field";

  return {
    rawValue,
    rawUnit,
    source,
    memoryMiB,
    memoryGbDisplay: rawValue === null ? null : rawValue,
    accepted,
    note,
  };
}

function collectMissing(candidate: Omit<CloreCandidate, "missingFields" | "rejectionReasons" | "riskTier" | "riskNotes">) {
  const required: Array<[keyof typeof candidate, string]> = [
    ["gpu", "gpu"],
    ["gpuMemoryGb", "gpuMemoryGb"],
    ["ramGb", "ramGb"],
    ["cpuCores", "cpuCores"],
    ["diskGb", "diskGb"],
    ["downloadMbps", "downloadMbps"],
    ["uploadMbps", "uploadMbps"],
    ["reliability", "reliability"],
    ["rating", "rating"],
    ["ratingCount", "ratingCount"],
    ["priceUsdPerHour", "priceUsdPerHour"],
  ];
  return required.filter(([key]) => candidate[key] === null || candidate[key] === "").map(([, name]) => name);
}

function getRisk(candidate: Omit<CloreCandidate, "riskTier" | "riskNotes">, config: CloreConfig) {
  const notes: string[] = [];
  if (candidate.missingFields.length > 0) {
    notes.push(`missing: ${candidate.missingFields.join(", ")}`);
  }
  if (candidate.orderType !== "on-demand") {
    notes.push("not on-demand");
  }
  if (candidate.rejectionReasons.length > 0) {
    return { tier: "reject" as const, notes: [...notes, ...candidate.rejectionReasons] };
  }

  const allowedCountry = config.allowedCountries.length === 0 || (candidate.country ? config.allowedCountries.includes(candidate.country.toUpperCase()) : false);
  if (
    (candidate.reliability ?? 0) >= 0.995 &&
    (candidate.rating ?? 0) >= 4.8 &&
    (candidate.ratingCount ?? 0) >= 10 &&
    candidate.missingFields.length === 0 &&
    candidate.hostOnline !== false &&
    allowedCountry
  ) {
    return { tier: "A" as const, notes: notes.length > 0 ? notes : ["strong P2P candidate, not a security guarantee"] };
  }

  return { tier: "B" as const, notes: notes.length > 0 ? notes : ["meets minimum P2P filters, still not a security guarantee"] };
}

export function normalizeCloreServer(raw: RawCloreServer, config: CloreConfig): CloreCandidate {
  const price = getOnDemandUsdPrice(raw);
  const specs = nestedRecord(raw, ["specs"]) ?? {};
  const net = nestedRecord(specs, ["net"]) ?? {};
  const disk = nestedRecord(specs, ["disk"]) ?? {};
  const rating = nestedRecord(raw, ["rating"]) ?? {};
  const country = (firstString(raw, ["country", "country_code", "region"]) ?? firstString(net, ["cc"]))?.toUpperCase() ?? null;
  const hasOnDemandPrice = price.value !== null;
  const spot = firstBoolean(raw, ["spot", "is_spot", "spot_available"], false);
  const orderType = spot && !hasOnDemandPrice ? "spot" : (firstString(raw, ["order_type", "rental_type", "type"]) ?? "on-demand").toLowerCase();
  const priceUsdPerHour = price.value;
  const sixHourCostUsd = priceUsdPerHour === null ? null : priceUsdPerHour * config.assumedMinimumRentalHours;
  const projected = computeCloreProjectedCost(priceUsdPerHour, CLORE_DEFAULT_MAX_SESSION_HOURS);
  const rawCurrency = stringArray(raw.allowed_coins ?? raw.allowed_currencies);
  const gpu = getGpuName(raw);
  const gpuNormalizedName = normalizeGpuName(gpu);
  const gpuMemory = getGpuMemory(raw, gpuNormalizedName, config);
  const base = {
    serverId: firstString(raw, ["id", "server_id", "machine_id", "renting_server"]) ?? "unknown",
    gpu,
    gpuNormalizedName,
    gpuCount: getGpuCount(raw),
    gpuMemoryGb: gpuMemory.memoryMiB === null ? null : gpuMemory.memoryMiB / 1024,
    gpuMemoryMiB: gpuMemory.memoryMiB,
    gpuMemoryRawValue: gpuMemory.rawValue,
    gpuMemoryRawUnit: gpuMemory.rawUnit,
    gpuMemorySource: gpuMemory.source,
    gpuMemoryAccepted: gpuMemory.accepted,
    gpuMemoryNote: gpuMemory.note,
    ramGb: firstNumber(raw, ["ram_gb", "memory_gb", "ram"]) ?? firstNumber(specs, ["ram", "ram_gb", "memory_gb"]),
    cpuCores: firstNumber(raw, ["cpu_cores", "cores", "cpu"]) ?? firstNumber(specs, ["cpu_cores", "cores", "cpus"]),
    diskGb: firstNumber(raw, ["disk_gb", "storage_gb", "disk"]) ?? firstNumber(specs, ["disk", "disk_gb", "storage_gb"]),
    downloadMbps:
      firstNumber(raw, ["download_mbps", "dl_mbps", "net_down_mbps", "dlperf", "net_down"]) ??
      firstNumber(specs, ["download_mbps", "net_down", "dlperf"]) ??
      firstNumber(net, ["down"]),
    uploadMbps:
      firstNumber(raw, ["upload_mbps", "ul_mbps", "net_up_mbps", "inet_up", "net_up"]) ??
      firstNumber(specs, ["upload_mbps", "net_up", "inet_up"]) ??
      firstNumber(net, ["up"]),
    diskSpeedMbps:
      firstNumber(raw, ["disk_speed_mbps", "disk_speed", "disk_benchmark_mbps", "disk_read_mbps"]) ??
      firstNumber(specs, ["disk_speed_mbps", "disk_speed", "disk_benchmark_mbps", "disk_read_mbps"]) ??
      firstNumber(disk, ["read_mbps", "write_mbps", "speed_mbps", "read", "write"]),
    reliability: firstNumber(raw, ["reliability", "online_reliability"]),
    rating: firstNumber(raw, ["rating", "avg_rating", "rating_avg"]) ?? firstNumber(rating, ["avg", "average", "rating"]),
    ratingCount: firstNumber(raw, ["rating_count", "ratings", "rating_samples"]) ?? firstNumber(rating, ["cnt", "count", "ratings"]),
    country,
    minRentalHours: firstNumber(raw, ["min_rental_hours", "min_duration_hours", "min_hours", "min_rental_time", "minimum_rental_hours", "minimum_charge_hours"]),
    maxRentalHours: firstNumber(raw, ["mrl", "max_rental_hours", "max_duration_hours", "max_rental_time"]),
    priceUsdPerHour,
    priceSource: price.source,
    priceOriginalAmount: price.originalAmount,
    priceOriginalCurrency: price.originalCurrency,
    priceOriginalUnit: price.originalUnit,
    priceOriginalLabel: price.originalLabel,
    allowedCurrencies: rawCurrency,
    sixHourCostUsd,
    effectivePriceUsdPerHour: projected.effectiveHourlyUsd,
    projectedSessionHours: projected.sessionHours,
    projectedSessionCostUsd: projected.projectedTotalUsd,
    creationFeeUsd: projected.creationFeeUsd,
    renterFeeRate: projected.renterFeeRate,
    balanceMarginUsd: null,
    balanceSufficientForSixHours: "unknown" as const,
    platformTotalPrice: nestedNumber(raw, [["price", "usd", "total"], ["price", "usd", "total_clore"]]),
    rentable: firstBoolean(raw, ["rentable", "available", "is_available"], true) && !firstBoolean(raw, ["rented"], false),
    orderType,
    supportsDocker: firstBoolean(raw, ["docker", "supports_docker", "allow_docker"], true),
    supportsSsh: firstBoolean(raw, ["ssh", "supports_ssh", "allow_ssh"], true),
    driverCompatible: raw.driver_compatible === undefined ? null : firstBoolean(raw, ["driver_compatible"], false),
    hostOnline: raw.host_online === undefined ? null : firstBoolean(raw, ["host_online"], false),
    raw,
  };

  const missingFields = collectMissing(base);
  const rejectionReasons = getRejectionReasons(base, config);
  const withChecks = { ...base, missingFields, rejectionReasons };
  const risk = getRisk(withChecks, config);

  return {
    ...withChecks,
    riskTier: risk.tier,
    riskNotes: risk.notes,
  };
}

function getRejectionReasons(candidate: Omit<CloreCandidate, "missingFields" | "rejectionReasons" | "riskTier" | "riskNotes">, config: CloreConfig) {
  const reasons: string[] = [];
  if (candidate.gpuNormalizedName !== config.targetGpu) {
    reasons.push(`GPU is not exact ${config.targetGpu.replace("NVIDIA GeForce ", "")}`);
  }
  if (candidate.gpuCount !== 1) reasons.push("GPU count is not 1");
  if (!candidate.rentable) reasons.push("server is not currently rentable");
  if (candidate.orderType !== "on-demand") reasons.push("spot or non-on-demand order is not allowed");
  if ((candidate.ramGb ?? 0) < config.minRamGb) reasons.push("RAM below minimum");
  if ((candidate.cpuCores ?? 0) < config.minCpuCores) reasons.push("CPU cores below minimum");
  if ((candidate.diskGb ?? 0) < config.minDiskGb) reasons.push("disk below minimum");
  if (!candidate.gpuMemoryAccepted) reasons.push(`GPU memory below ${config.minGpuVramGb}GB accepted threshold`);
  if (candidate.reliability === null || candidate.reliability < config.minReliability) reasons.push("reliability below minimum or missing");
  if (candidate.rating === null || candidate.rating < config.minRating) reasons.push("rating below minimum or missing");
  if (candidate.ratingCount === null || candidate.ratingCount < config.minRatingCount) reasons.push("rating count below minimum or missing");
  if (candidate.downloadMbps === null || candidate.downloadMbps < config.minDownloadMbps) reasons.push("download bandwidth below minimum or missing");
  if (candidate.uploadMbps === null || candidate.uploadMbps < config.minUploadMbps) reasons.push("upload bandwidth below minimum or missing");
  if (candidate.priceUsdPerHour === null) reasons.push("missing USD hourly on-demand price");
  if (candidate.allowedCurrencies.length > 0 && !candidate.allowedCurrencies.includes(config.rentalCurrency)) reasons.push("configured rental currency is not accepted by this server");
  if ((candidate.priceUsdPerHour ?? Number.POSITIVE_INFINITY) > config.maxGpuPricePerHour) reasons.push("price above maximum");
  if (config.excludedServerIds.includes(candidate.serverId)) reasons.push("server is temporarily excluded after a failed session");
  if (!candidate.supportsDocker) reasons.push("custom Docker image is not supported");
  if (!candidate.supportsSsh) reasons.push("SSH is not supported");
  if (candidate.driverCompatible === false) reasons.push("host driver is not marked CUDA 12.8 compatible");
  if (config.allowedCountries.length > 0 && (!candidate.country || !config.allowedCountries.includes(candidate.country))) reasons.push("country not in allowed list");
  return reasons;
}

export function evaluateMarketplace(rawServers: RawCloreServer[], config: CloreConfig) {
  const candidates = rawServers.map((server) => normalizeCloreServer(server, config));
  const matches = candidates
    .filter((candidate) => candidate.rejectionReasons.length === 0)
    .sort((left, right) => (left.priceUsdPerHour ?? Number.POSITIVE_INFINITY) - (right.priceUsdPerHour ?? Number.POSITIVE_INFINITY));
  return { candidates, matches };
}

export function summarizeCandidate(candidate: CloreCandidate) {
  return {
    server_id: candidate.serverId,
    gpu: candidate.gpu,
    gpu_normalized_name: candidate.gpuNormalizedName,
    gpu_count: candidate.gpuCount,
    gpu_memory_gb: candidate.gpuMemoryGb,
    gpu_memory_mib: candidate.gpuMemoryMiB === null ? null : Number(candidate.gpuMemoryMiB.toFixed(2)),
    gpu_memory_raw_value: candidate.gpuMemoryRawValue,
    gpu_memory_raw_unit: candidate.gpuMemoryRawUnit,
    gpu_memory_source: candidate.gpuMemorySource,
    gpu_memory_accepted: candidate.gpuMemoryAccepted,
    gpu_memory_note: candidate.gpuMemoryNote,
    ram_gb: candidate.ramGb,
    cpu_cores: candidate.cpuCores,
    disk_gb: candidate.diskGb,
    download_mbps: candidate.downloadMbps,
    upload_mbps: candidate.uploadMbps,
    disk_speed_mbps: candidate.diskSpeedMbps,
    reliability: candidate.reliability,
    rating: candidate.rating,
    rating_count: candidate.ratingCount,
    country: candidate.country,
    min_rental_hours: candidate.minRentalHours,
    min_billing_confirmed_by_api: candidate.minRentalHours !== null,
    min_billing_note: candidate.minRentalHours === null ? "API did not expose a minimum billing duration; verify on Clore before real create." : "from marketplace/API field",
    original_on_demand_price: candidate.priceOriginalLabel,
    original_price_amount: candidate.priceOriginalAmount,
    original_price_currency: candidate.priceOriginalCurrency,
    original_price_unit: candidate.priceOriginalUnit,
    normalized_usd_per_hour: candidate.priceUsdPerHour === null ? null : Number(candidate.priceUsdPerHour.toFixed(6)),
    base_usd_per_hour: candidate.priceUsdPerHour,
    on_demand_usd_per_hour: candidate.priceUsdPerHour,
    effective_usd_per_hour:
      candidate.effectivePriceUsdPerHour === null ? null : Number(candidate.effectivePriceUsdPerHour.toFixed(6)),
    renter_fee_rate: candidate.renterFeeRate,
    creation_fee_usd: candidate.creationFeeUsd,
    one_hour_cost_usd: candidate.priceUsdPerHour === null ? null : Number(candidate.priceUsdPerHour.toFixed(4)),
    six_hour_cost_usd: candidate.sixHourCostUsd === null ? null : Number(candidate.sixHourCostUsd.toFixed(4)),
    max_session_hours: Number(candidate.projectedSessionHours.toFixed(4)),
    max_session_projected_total_usd:
      candidate.projectedSessionCostUsd === null ? null : Number(candidate.projectedSessionCostUsd.toFixed(4)),
    platform_total_price: candidate.platformTotalPrice,
    platform_total_price_status: candidate.platformTotalPrice === null ? "API not confirmed" : "provided by API",
    balance_margin_usd: candidate.balanceMarginUsd === null ? null : Number(candidate.balanceMarginUsd.toFixed(4)),
    balance_sufficient_for_6h: candidate.balanceSufficientForSixHours,
    currently_rentable: candidate.rentable,
    missing_fields: candidate.missingFields,
    risk_tier: candidate.riskTier,
    risk_notes: candidate.riskNotes,
  };
}

export function applyWalletBalance(candidates: CloreCandidate[], availableUsdBalance: number | null) {
  return candidates.map((candidate) => {
    if (availableUsdBalance === null || candidate.projectedSessionCostUsd === null) {
      return { ...candidate, balanceMarginUsd: null, balanceSufficientForSixHours: "unknown" as const };
    }
    const balanceMarginUsd = availableUsdBalance - candidate.projectedSessionCostUsd;
    return {
      ...candidate,
      balanceMarginUsd,
      balanceSufficientForSixHours: balanceMarginUsd >= 0,
    };
  });
}
