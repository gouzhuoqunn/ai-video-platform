export type CloreConfig = {
  apiBaseUrl: string;
  apiKey?: string;
  apiKeySource?: string;
  targetGpu: "NVIDIA GeForce RTX 4090" | "NVIDIA GeForce RTX 5090";
  minGpuVramGb: number;
  maxGpuPricePerHour: number;
  minReliability: number;
  minRating: number;
  minRatingCount: number;
  minRamGb: number;
  minCpuCores: number;
  minDiskGb: number;
  minDownloadMbps: number;
  minUploadMbps: number;
  allowedCountries: string[];
  rentalCurrency: string;
  dockerImage: string;
  orderType: "on-demand";
  sshPublicKeyPath?: string;
  projectTag: string;
  assumedMinimumRentalHours: number;
  excludedServerIds: string[];
};

export type CloreApiResponse<T> = {
  code: number;
  data?: T;
  message?: string;
  error?: unknown;
  details?: unknown;
  errors?: unknown;
  field?: unknown;
  request_id?: unknown;
};

export type RawCloreServer = Record<string, unknown>;

export type CloreCandidate = {
  serverId: string;
  gpu: string;
  gpuNormalizedName: string;
  gpuCount: number;
  gpuMemoryGb: number | null;
  gpuMemoryMiB: number | null;
  gpuMemoryRawValue: number | null;
  gpuMemoryRawUnit: "bytes" | "MB" | "MiB" | "GB" | "GiB" | "display_gb" | null;
  gpuMemorySource: string | null;
  gpuMemoryAccepted: boolean;
  gpuMemoryNote: string;
  ramGb: number | null;
  cpuCores: number | null;
  diskGb: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  reliability: number | null;
  rating: number | null;
  ratingCount: number | null;
  country: string | null;
  minRentalHours: number | null;
  maxRentalHours: number | null;
  priceUsdPerHour: number | null;
  priceSource: string | null;
  priceOriginalAmount: number | null;
  priceOriginalCurrency: "USD" | "BTC" | "CLORE" | null;
  priceOriginalUnit: "hour" | "day" | "spot_hour" | "spot_day" | null;
  priceOriginalLabel: string | null;
  allowedCurrencies: string[];
  sixHourCostUsd: number | null;
  effectivePriceUsdPerHour: number | null;
  projectedSessionHours: number;
  projectedSessionCostUsd: number | null;
  creationFeeUsd: number;
  renterFeeRate: number;
  balanceMarginUsd: number | null;
  balanceSufficientForSixHours: boolean | "unknown";
  platformTotalPrice: number | null;
  rentable: boolean;
  orderType: string;
  supportsDocker: boolean;
  supportsSsh: boolean;
  driverCompatible: boolean | null;
  hostOnline: boolean | null;
  missingFields: string[];
  rejectionReasons: string[];
  riskTier: "A" | "B" | "reject";
  riskNotes: string[];
  raw: RawCloreServer;
};

export type OrderPlan = {
  dryRun: true;
  selected: CloreCandidate | null;
  dockerImage: string;
  dockerImageVerified: boolean;
  dockerImagePlatform: string;
  sshPublicKeyPath: string;
  sshPublicKeyExists: boolean;
  sshPublicKeyFormatValid: boolean;
  currency: string;
  availableUsdBalance: number | null;
  minimumRentalHours: number;
  createdAt: string;
  expiresAt: string;
};

export type WalletBalance = {
  name: string;
  balance: number | null;
  currency: string | null;
  isUsdLike: boolean;
};

export type WalletSummary = {
  balances: WalletBalance[];
  availableUsdBalance: number | null;
  source: string;
};
