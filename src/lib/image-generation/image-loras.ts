export const MAX_TASK_LORAS = 8;
export const MAX_TASK_LORA_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_REGISTERED_LORAS = 64;
export const MAX_LORA_NAME_LENGTH = 80;
export const MAX_NEGATIVE_PROMPT_LENGTH = 4_000;
export const MIN_LORA_STRENGTH = 0;
export const MAX_LORA_STRENGTH = 1.5;

export const BUILTIN_AIDMA_LORA = {
  id: "builtin-aidma-nsfw-unlock",
  name: "画裸体LoRA",
  filename: "aidmaNSFWunlock-FLUX-V0.2.safetensors",
  sha256: "7d3408f4a7b7890f470c1cce7f7255b6d8e03ea770a2829066c1ce41145562ec",
  sizeBytes: 19_268_648,
  defaultStrength: 0.8,
} as const;

export type ImageTaskLora = {
  id: string;
  name: string;
  filename: string;
  strength: number;
  enabled: boolean;
  sha256: string;
  sizeBytes: number;
};

export type LoraSourceLocator =
  | {
    provider: "civitai";
    modelId: number | null;
    versionId: number;
    fileId: number;
  }
  | {
    provider: "huggingface";
    repository: string;
    revision: string;
    path: string;
  };

export type RegisteredLora = {
  id: string;
  name: string;
  filename: string;
  defaultStrength: number;
  defaultEnabled: boolean;
  availability: "ready" | "missing";
  sha256: string | null;
  sizeBytes: number | null;
  source: LoraSourceLocator | null;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EffectiveImageLora = Pick<ImageTaskLora, "filename" | "strength">;

const SAFE_ID = /^(?:builtin-[a-z0-9-]{1,80}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SAFE_SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_FILENAME = /^[^/\\\u0000-\u001f]{1,180}\.safetensors$/i;

export function validImageLoraId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function validLoraStrength(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= MIN_LORA_STRENGTH
    && value <= MAX_LORA_STRENGTH;
}

export function assertSafeLoraFilename(value: unknown) {
  if (typeof value !== "string" || !SAFE_FILENAME.test(value) || value === "." || value === "..") {
    throw new Error("invalid_lora_filename");
  }
  return value;
}

export function assertImageTaskLoras(value: unknown): ImageTaskLora[] {
  if (!Array.isArray(value) || value.length > MAX_REGISTERED_LORAS) {
    throw new Error("invalid_image_task_loras");
  }
  const seenIds = new Set<string>();
  const seenFilenames = new Set<string>();
  let enabledCount = 0;
  let enabledBytes = 0;
  const result = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid_image_task_lora");
    const input = item as Record<string, unknown>;
    const id = String(input.id ?? "");
    const name = String(input.name ?? "").trim();
    const filename = assertSafeLoraFilename(input.filename);
    const strength = Number(input.strength);
    const enabled = input.enabled;
    const sha256 = String(input.sha256 ?? "").toLowerCase();
    const sizeBytes = Number(input.sizeBytes);
    if (
      !validImageLoraId(id)
      || !name
      || name.length > MAX_LORA_NAME_LENGTH
      || !validLoraStrength(strength)
      || typeof enabled !== "boolean"
      || !SAFE_SHA256.test(sha256)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes <= 0
      || seenIds.has(id)
      || seenFilenames.has(filename.toLowerCase())
    ) {
      throw new Error("invalid_image_task_lora");
    }
    seenIds.add(id);
    seenFilenames.add(filename.toLowerCase());
    if (enabled) {
      enabledCount += 1;
      enabledBytes += sizeBytes;
    }
    return { id, name, filename, strength, enabled, sha256, sizeBytes };
  });
  if (enabledCount > MAX_TASK_LORAS) throw new Error("too_many_enabled_loras");
  if (enabledBytes > MAX_TASK_LORA_BYTES) throw new Error("enabled_loras_too_large");
  return result;
}

/**
 * Missing `loras` is the legacy task contract and therefore still loads the
 * pinned AIDMA LoRA. An explicit empty array is intentional "no LoRA".
 */
export function effectiveImageTaskLoras(
  task: { loras?: unknown; loraStrength?: unknown },
): EffectiveImageLora[] {
  if (task.loras === undefined) {
    const legacyStrength = Number(task.loraStrength);
    if (!Number.isFinite(legacyStrength)) throw new Error("invalid_legacy_lora_strength");
    return [{ filename: BUILTIN_AIDMA_LORA.filename, strength: legacyStrength }];
  }
  return assertImageTaskLoras(task.loras)
    .filter((lora) => lora.enabled)
    .map(({ filename, strength }) => ({ filename, strength }));
}

export function normalizeNegativePrompt(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_NEGATIVE_PROMPT_LENGTH) {
    throw new Error("invalid_negative_prompt");
  }
  return value.trim();
}
