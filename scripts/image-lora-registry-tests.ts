import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listRegisteredLoras,
  parseLoraRegistrationSource,
  parseWindowsLoopbackProxyServer,
  registerLoraFromUrl,
  resolveAndSnapshotTaskLoras,
  resolveTaskLoraDownloads,
  snapshotTaskLoraSelections,
  snapshotTaskLoras,
  updateRegisteredLora,
  type LoraRegistryOptions,
} from "../src/lib/image-generation/local-lora-registry";

const PUBLIC_ADDRESSES = async () => ["8.8.8.8"];
const LORA_SIZE = 4_096;
const CIVITAI_SHA = "a".repeat(64);
const HF_SHA = "b".repeat(64);
const HF_COMMIT = "c".repeat(40);

type FetchCall = {
  url: string;
  authorization: string | null;
  range: string | null;
  redirect: RequestRedirect | undefined;
};

function safetensorsPrefix() {
  const header = Buffer.from(JSON.stringify({
    "lora.weight": {
      dtype: "F16",
      shape: [1],
      data_offsets: [0, 2],
    },
  }), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, Buffer.from([0, 0])]);
}

function jsonResponse(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

function redirectResponse(location: string) {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function binaryResponse(input: {
  body?: BodyInit | null;
  totalBytes?: number;
  status?: number;
}) {
  const body = input.body === undefined ? safetensorsPrefix() : input.body;
  const bodyBytes = body instanceof Uint8Array
    ? body.byteLength
    : typeof body === "string"
      ? Buffer.byteLength(body)
      : safetensorsPrefix().byteLength;
  const totalBytes = input.totalBytes ?? LORA_SIZE;
  return new Response(body, {
    status: input.status ?? 206,
    headers: {
      "content-type": "application/octet-stream",
      "content-range": `bytes 0-${Math.max(0, bodyBytes - 1)}/${totalBytes}`,
      "content-length": String(bodyBytes),
    },
  });
}

function callRecord(input: string | URL | Request, init?: RequestInit): FetchCall {
  const headers = new Headers(init?.headers);
  return {
    url: String(input),
    authorization: headers.get("authorization"),
    range: headers.get("range"),
    redirect: init?.redirect,
  };
}

function civitaiFile(input: {
  id: number;
  name?: string;
  sha256?: string;
  primary?: boolean;
  downloadUrl?: string;
  sizeBytes?: number;
}) {
  return {
    id: input.id,
    name: input.name ?? "fixture-lora.safetensors",
    primary: input.primary ?? true,
    type: "Model",
    hashes: { SHA256: input.sha256 ?? CIVITAI_SHA },
    sizeKB: (input.sizeBytes ?? LORA_SIZE) / 1024,
    downloadUrl: input.downloadUrl ?? "https://civitai.com/api/download/models/456",
    pickleScanResult: "Success",
    virusScanResult: "Success",
  };
}

function registryOptions(
  registryPath: string,
  fetchImpl: typeof fetch,
  overrides: Partial<LoraRegistryOptions> = {},
): LoraRegistryOptions {
  mkdirSync(path.dirname(registryPath), { recursive: true });
  return {
    registryPath,
    fetchImpl,
    tokenProvider: (name) => name === "CIVITAI_API_TOKEN" ? "civitai-local-token" : "hf-local-token",
    resolveHostname: PUBLIC_ADDRESSES,
    timeoutMs: 100,
    ...overrides,
  };
}

function noNetworkOptions(registryPath: string, counter: { calls: number }) {
  return registryOptions(registryPath, async () => {
    counter.calls += 1;
    throw new Error("registration_must_not_fetch");
  });
}

function selection(id: string, enabled = true, strength = 0.8) {
  return [{
    id,
    name: "browser value is not authoritative",
    filename: "../browser-value.safetensors",
    sha256: "0".repeat(64),
    sizeBytes: 1,
    strength,
    enabled,
  }];
}

async function testDefaultAndLegacyReadyRegistry(root: string) {
  const defaultPath = path.join(root, "defaults", "loras.json");
  mkdirSync(path.dirname(defaultPath), { recursive: true });
  const defaults = listRegisteredLoras({ registryPath: defaultPath });
  assert.deepEqual(defaults.map((item) => item.name), [
    "画裸体LoRA",
    "解决男人女器官LoRA",
    "大肌肉阳刚LoRA",
  ]);
  assert.deepEqual(defaults.map((item) => item.availability), ["ready", "missing", "missing"]);
  assert.equal(existsSync(defaultPath), false, "read-only listing must not create registry state");

  const legacyPath = path.join(root, "legacy-ready", "loras.json");
  mkdirSync(path.dirname(legacyPath), { recursive: true });
  const legacyId = "11111111-1111-4111-8111-111111111111";
  writeFileSync(legacyPath, `${JSON.stringify({
    schemaVersion: 1,
    items: [{
      id: legacyId,
      name: "旧版 ready LoRA",
      filename: "legacy.safetensors",
      defaultStrength: 0.7,
      defaultEnabled: false,
      availability: "ready",
      sha256: HF_SHA,
      sizeBytes: LORA_SIZE,
      source: {
        provider: "huggingface",
        repository: "org/legacy",
        revision: HF_COMMIT,
        path: "legacy.safetensors",
      },
      builtIn: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }, null, 2)}\n`);
  const legacy = listRegisteredLoras({ registryPath: legacyPath }).find((item) => item.id === legacyId);
  assert.equal(legacy?.availability, "ready");
  assert.equal(legacy?.registrationSource ?? null, null);
  assert.equal(snapshotTaskLoras(selection(legacyId), { registryPath: legacyPath })?.[0]?.sha256, HF_SHA);
}

async function testRecognizedFormatsRegisterWithoutNetwork(root: string) {
  const cases = [
    {
      label: "用户链接 1",
      url: "https://civitai.red/models/1988828/better-penis-for-flux-z-imageb-klein-9b",
      expected: { provider: "civitai", modelId: 1988828, versionId: null, fileId: null },
    },
    {
      label: "用户链接 2",
      url: "https://civitai.red/models/371317/milkytiger-and-milkybot-and-hu-ku-lior-fursona",
      expected: { provider: "civitai", modelId: 371317, versionId: null, fileId: null },
    },
    {
      label: "Civitai red 下载",
      url: "https://civitai.red/api/download/models/2834733?fileId=2720788",
      expected: { provider: "civitai", modelId: null, versionId: 2834733, fileId: 2720788 },
    },
    {
      label: "Civitai com 页面",
      url: "https://civitai.com/models/1988828/better-penis-for-flux",
      expected: { provider: "civitai", modelId: 1988828, versionId: null, fileId: null },
    },
    {
      label: "HuggingFace 页面",
      url: "https://huggingface.co/org/repo",
      expected: { provider: "huggingface", repository: "org/repo", revision: null, path: null },
    },
    {
      label: "hf.co 文件",
      url: "https://hf.co/org/repo/blob/main/weights/model.safetensors",
      expected: { provider: "huggingface", repository: "org/repo", revision: "main", path: "weights/model.safetensors" },
    },
    {
      label: "直接 safetensors",
      url: "https://downloads.example.net/files/custom.safetensors",
      expected: { provider: "direct", inferredFilename: "custom.safetensors" },
    },
    {
      label: "明显下载地址",
      url: "https://models.example.net/download?id=42",
      expected: { provider: "direct", inferredFilename: null },
    },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const registryPath = path.join(root, "recognized", String(index), "loras.json");
    const network = { calls: 0 };
    const parsed = parseLoraRegistrationSource(testCase.url);
    assert.deepEqual(
      Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "originalUrl")),
      testCase.expected,
      testCase.label,
    );
    const result = await registerLoraFromUrl({
      name: testCase.label,
      sourceUrl: testCase.url,
      defaultStrength: 0.85,
    }, noNetworkOptions(registryPath, network));
    assert.equal(network.calls, 0, `${testCase.label} registration must be zero-network`);
    assert.equal(result.item.availability, "registered");
    assert.equal(result.item.name, testCase.label);
    assert.equal(result.item.defaultStrength, 0.85);
    assert.equal(result.item.sha256, null);
    assert.equal(result.item.sizeBytes, null);
    assert.equal(result.item.source, null);
    assert.equal(result.item.registrationSource?.originalUrl, testCase.url);
    assert.equal(result.verification.classification, "registered_for_generation_validation");
    const reread = listRegisteredLoras({ registryPath }).find((item) => item.id === result.item.id);
    assert.equal(reread?.availability, "registered");
    assert.deepEqual(reread?.registrationSource, result.item.registrationSource);
  }
}

async function testUnrecognizedSourceRejected(root: string) {
  const registryPath = path.join(root, "unrecognized", "loras.json");
  const options = noNetworkOptions(registryPath, { calls: 0 });
  for (const url of [
    "not a URL",
    "http://civitai.red/models/123/example",
    "https://example.com/about",
    "https://127.0.0.1/model.safetensors",
    "https://user:password@example.com/model.safetensors",
  ]) {
    await assert.rejects(
      registerLoraFromUrl({
        name: "无法识别",
        sourceUrl: url,
        defaultStrength: 0.8,
      }, options),
      /(?:unrecognized|unsupported)_lora_source_url/,
      url,
    );
  }
  assert.equal(existsSync(registryPath), false);
}

async function testWindowsLoopbackProxyParsing() {
  assert.equal(
    parseWindowsLoopbackProxyServer("127.0.0.1:22833"),
    "http://127.0.0.1:22833/",
  );
  assert.equal(
    parseWindowsLoopbackProxyServer("http=127.0.0.1:22000;https=localhost:22833"),
    "http://localhost:22833/",
  );
  for (const value of [
    "proxy.example.com:8080",
    "https=user:password@127.0.0.1:22833",
    "127.0.0.1",
    "127.0.0.1:70000",
    "socks=127.0.0.1:22833",
  ]) {
    assert.equal(parseWindowsLoopbackProxyServer(value), null, value);
  }
}

async function testCivitaiStrictGenerationResolution(root: string) {
  const registryPath = path.join(root, "civitai-strict", "loras.json");
  const calls: FetchCall[] = [];
  const version = {
    id: 456,
    modelId: 123,
    baseModel: "Flux.1 D",
    files: [civitaiFile({ id: 789 })],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    calls.push(call);
    if (call.url === "https://civitai.red/api/v1/model-versions/456"
      || call.url === "https://civitai.com/api/v1/model-versions/456") return jsonResponse(version);
    if (call.url === "https://civitai.red/api/v1/models/123"
      || call.url === "https://civitai.com/api/v1/models/123") {
      return jsonResponse({ id: 123, type: "LORA", modelVersions: [version] });
    }
    if (call.url === "https://civitai.com/api/download/models/456?fileId=789") {
      return redirectResponse("https://cdn.civitai.example/fixture-lora.safetensors");
    }
    if (call.url === "https://cdn.civitai.example/fixture-lora.safetensors") return binaryResponse({});
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl);
  const registered = await registerLoraFromUrl({
    name: "Civitai red 待下载",
    sourceUrl: "https://civitai.red/api/download/models/456?fileId=789",
    defaultStrength: 0.7,
  }, options);
  assert.equal(registered.item.availability, "registered");
  assert.equal(calls.length, 0, "local registration must not fetch metadata or bytes");
  assert.deepEqual(
    snapshotTaskLoraSelections(selection(registered.item.id, true, 1.25), options),
    [{ id: registered.item.id, enabled: true, strength: 1.25 }],
    "pending task selection must be validated without provider access",
  );
  assert.equal(calls.length, 0, "pending card creation must stay network-free");

  const updated = updateRegisteredLora({
    id: registered.item.id,
    name: "已编辑 Civitai LoRA",
    defaultStrength: 1.15,
  }, { registryPath });
  assert.equal(updated.item.name, "已编辑 Civitai LoRA");

  const snapshot = await resolveAndSnapshotTaskLoras(selection(registered.item.id, true, 1.25), options);
  assert.deepEqual(snapshot, [{
    id: registered.item.id,
    name: "已编辑 Civitai LoRA",
    filename: "fixture-lora.safetensors",
    strength: 1.25,
    enabled: true,
    sha256: CIVITAI_SHA,
    sizeBytes: LORA_SIZE,
  }], "task identity must come from strict provider resolution, never browser fields");
  const ready = listRegisteredLoras({ registryPath }).find((item) => item.id === registered.item.id);
  assert.equal(ready?.availability, "ready");
  assert.deepEqual(ready?.source, {
    provider: "civitai",
    modelId: 123,
    versionId: 456,
    fileId: 789,
  });
  assert.ok(calls.every((call) => call.redirect === "manual"));
  assert.equal(calls.some((call) => call.range?.startsWith("bytes=0-")), false,
    "confirmation identity promotion must use metadata only");
  assert.ok(calls.filter((call) => new URL(call.url).origin === "https://civitai.red")
    .every((call) => call.authorization === null), "mirror metadata must never receive the official token");

  const downloads = await resolveTaskLoraDownloads(snapshot, options);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]?.sizeBytes, LORA_SIZE);
  assert.ok(calls.some((call) => call.range?.startsWith("bytes=0-")),
    "pre-rental delivery validation must still probe the binary");
  assert.ok(calls.filter((call) => new URL(call.url).origin === "https://civitai.com")
    .every((call) => call.authorization === "Bearer civitai-local-token"));
  assert.ok(calls.filter((call) => new URL(call.url).hostname === "cdn.civitai.example")
    .every((call) => call.authorization === null));
}

async function testCivitaiAdvertisedSizeDriftUsesExactTransferSize(root: string) {
  const registryPath = path.join(root, "civitai-size-drift", "loras.json");
  const advertisedSize = LORA_SIZE - 80;
  const version = {
    id: 456,
    modelId: 123,
    baseModel: "Flux.1 D",
    files: [civitaiFile({ id: 789, sizeBytes: advertisedSize })],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    if (
      call.url === "https://civitai.red/api/v1/model-versions/456"
      || call.url === "https://civitai.com/api/v1/model-versions/456"
    ) return jsonResponse(version);
    if (
      call.url === "https://civitai.red/api/v1/models/123"
      || call.url === "https://civitai.com/api/v1/models/123"
    ) return jsonResponse({ id: 123, type: "LORA", modelVersions: [version] });
    if (call.url === "https://civitai.com/api/download/models/456?fileId=789") {
      return redirectResponse("https://cdn.civitai.example/fixture-lora.safetensors");
    }
    if (call.url === "https://cdn.civitai.example/fixture-lora.safetensors") {
      return binaryResponse({ totalBytes: LORA_SIZE });
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl);
  const registered = await registerLoraFromUrl({
    name: "Civitai 旧文件大小校准",
    sourceUrl: "https://civitai.red/api/download/models/456?fileId=789",
    defaultStrength: 0.8,
  }, options);
  const snapshot = await resolveAndSnapshotTaskLoras(selection(registered.item.id), options);
  assert.equal(snapshot?.[0]?.sizeBytes, advertisedSize);
  const downloads = await resolveTaskLoraDownloads(snapshot, options);
  assert.equal(downloads[0]?.sizeBytes, LORA_SIZE);
  assert.equal(downloads[0]?.evidence.contentLength, LORA_SIZE);
}

async function testDisabledRegisteredDoesNotResolve(root: string) {
  const registryPath = path.join(root, "disabled", "loras.json");
  const network = { calls: 0 };
  const options = noNetworkOptions(registryPath, network);
  const registered = await registerLoraFromUrl({
    name: "未启用待下载",
    sourceUrl: "https://civitai.red/models/1988828/example",
    defaultStrength: 0.8,
  }, options);
  assert.deepEqual(
    await resolveAndSnapshotTaskLoras(selection(registered.item.id, false), options),
    [],
  );
  assert.equal(network.calls, 0);
  assert.equal(
    listRegisteredLoras({ registryPath }).find((item) => item.id === registered.item.id)?.availability,
    "registered",
  );
}

async function testCivitaiModelPageChoosesFlux1VersionFromRedMetadata(root: string) {
  const registryPath = path.join(root, "civitai-flux-version", "loras.json");
  const calls: FetchCall[] = [];
  const incompatible = {
    id: 3001,
    name: "Klein latest",
    baseModel: "Flux.2 Klein 9B-base",
    files: [civitaiFile({ id: 4001, name: "klein.safetensors", sha256: "1".repeat(64) })],
  };
  const compatible = {
    id: 3002,
    name: "Flux-v1.0",
    baseModel: "Flux.1 D",
    files: [civitaiFile({
      id: 4002,
      name: "flux1.safetensors",
      sha256: "2".repeat(64),
      sizeBytes: 8_192,
    })],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    calls.push(call);
    if (call.url === "https://civitai.red/api/v1/models/1988828") {
      return jsonResponse({
        id: 1988828,
        type: "LORA",
        modelVersions: [incompatible, compatible],
      });
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl);
  const registered = await registerLoraFromUrl({
    name: "FLUX.1 兼容选择",
    sourceUrl: "https://civitai.red/models/1988828/example",
    defaultStrength: 0.85,
  }, options);
  const snapshot = await resolveAndSnapshotTaskLoras(selection(registered.item.id), options);
  assert.equal(snapshot?.[0]?.filename, "flux1.safetensors");
  assert.equal(snapshot?.[0]?.sizeBytes, 8_192);
  assert.deepEqual(
    listRegisteredLoras({ registryPath }).find((item) => item.id === registered.item.id)?.source,
    {
      provider: "civitai",
      modelId: 1988828,
      versionId: 3002,
      fileId: 4002,
    },
  );
  assert.deepEqual(calls.map((call) => call.url), [
    "https://civitai.red/api/v1/models/1988828",
  ]);
  assert.equal(calls[0]?.authorization, null);
  assert.equal(calls[0]?.range, null);
}

async function testExplicitCivitaiFileMismatchFailsAtGeneration(root: string) {
  const registryPath = path.join(root, "civitai-file-mismatch", "loras.json");
  let binaryCalls = 0;
  const version = {
    id: 901,
    modelId: 88,
    baseModel: "Flux.1 D",
    files: [civitaiFile({ id: 703, name: "primary.safetensors", sha256: "f".repeat(64) })],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    if (call.url === "https://civitai.red/api/v1/model-versions/901"
      || call.url === "https://civitai.com/api/v1/model-versions/901") return jsonResponse(version);
    if (call.url === "https://civitai.red/api/v1/models/88"
      || call.url === "https://civitai.com/api/v1/models/88") {
      return jsonResponse({ id: 88, type: "LORA", modelVersions: [version] });
    }
    binaryCalls += 1;
    throw new Error(`binary_must_not_run:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl);
  const registered = await registerLoraFromUrl({
    name: "不存在的明确文件",
    sourceUrl: "https://civitai.red/api/download/models/901?fileId=999",
    defaultStrength: 0.8,
  }, options);
  assert.equal(registered.item.availability, "registered");
  await assert.rejects(
    resolveAndSnapshotTaskLoras(selection(registered.item.id), options),
    /civitai_lora_file_ambiguous_or_missing/,
  );
  assert.equal(binaryCalls, 0);
  assert.equal(
    listRegisteredLoras({ registryPath }).find((item) => item.id === registered.item.id)?.availability,
    "registered",
  );
}

async function testCivitaiFallbackAndIdentityCorrelation(root: string) {
  const fallbackPath = path.join(root, "civitai-fallback", "loras.json");
  const calls: FetchCall[] = [];
  const compatible = {
    id: 456,
    modelId: 123,
    baseModel: "Flux.1 D",
    files: [civitaiFile({ id: 789 })],
  };
  const fallbackFetch: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    calls.push(call);
    if (call.url === "https://civitai.com/api/v1/models/123") {
      throw new Error("fixture_primary_transport_reset");
    }
    if (call.url === "https://civitai.red/api/v1/models/123") {
      return jsonResponse({ id: 123, type: "LORA", modelVersions: [compatible] });
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const fallbackOptions = registryOptions(fallbackPath, fallbackFetch);
  const fallbackRegistered = await registerLoraFromUrl({
    name: "Civitai 元数据备用端点",
    sourceUrl: "https://civitai.com/models/123/example",
    defaultStrength: 0.8,
  }, fallbackOptions);
  const snapshot = await resolveAndSnapshotTaskLoras(
    selection(fallbackRegistered.item.id),
    fallbackOptions,
  );
  assert.equal(snapshot?.[0]?.filename, "fixture-lora.safetensors");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://civitai.com/api/v1/models/123",
    "https://civitai.red/api/v1/models/123",
  ]);
  assert.equal(calls[0]?.authorization, "Bearer civitai-local-token");
  assert.equal(calls[1]?.authorization, null);

  const wrongVersionPath = path.join(root, "civitai-wrong-version", "loras.json");
  const wrongVersion = await registerLoraFromUrl({
    name: "错误版本身份",
    sourceUrl: "https://civitai.red/api/download/models/456?fileId=789",
    defaultStrength: 0.8,
  }, noNetworkOptions(wrongVersionPath, { calls: 0 }));
  await assert.rejects(
    resolveAndSnapshotTaskLoras(
      selection(wrongVersion.item.id),
      registryOptions(wrongVersionPath, async (input) => {
        const url = String(input);
        if (url === "https://civitai.red/api/v1/model-versions/456") {
          return jsonResponse({ ...compatible, id: 999 });
        }
        throw new Error(`unexpected_fixture_url:${url}`);
      }),
    ),
    /civitai_metadata_identity_mismatch/,
  );

  const wrongModelPath = path.join(root, "civitai-wrong-model", "loras.json");
  const wrongModel = await registerLoraFromUrl({
    name: "错误模型身份",
    sourceUrl: "https://civitai.red/models/123/example",
    defaultStrength: 0.8,
  }, noNetworkOptions(wrongModelPath, { calls: 0 }));
  await assert.rejects(
    resolveAndSnapshotTaskLoras(
      selection(wrongModel.item.id),
      registryOptions(wrongModelPath, async (input) => {
        const url = String(input);
        if (url === "https://civitai.red/api/v1/models/123") {
          return jsonResponse({ id: 999, type: "LORA", modelVersions: [compatible] });
        }
        throw new Error(`unexpected_fixture_url:${url}`);
      }),
    ),
    /civitai_metadata_identity_mismatch/,
  );
}

async function testCivitaiExplicitCompatibilityAndTokenlessDelivery(root: string) {
  const incompatiblePath = path.join(root, "civitai-incompatible", "loras.json");
  const incompatible = {
    id: 2834733,
    modelId: 1988828,
    baseModel: "Flux.2 Klein 9B-base",
    files: [civitaiFile({ id: 2720788, name: "klein.safetensors" })],
  };
  const incompatibleRegistered = await registerLoraFromUrl({
    name: "显式 Klein 版本",
    sourceUrl: "https://civitai.red/api/download/models/2834733?fileId=2720788",
    defaultStrength: 0.8,
  }, noNetworkOptions(incompatiblePath, { calls: 0 }));
  await assert.rejects(
    resolveAndSnapshotTaskLoras(
      selection(incompatibleRegistered.item.id),
      registryOptions(incompatiblePath, async (input) => {
        const url = String(input);
        if (url === "https://civitai.red/api/v1/model-versions/2834733") {
          return jsonResponse(incompatible);
        }
        if (url === "https://civitai.red/api/v1/models/1988828") {
          return jsonResponse({ id: 1988828, type: "LORA", modelVersions: [incompatible] });
        }
        throw new Error(`unexpected_fixture_url:${url}`);
      }),
    ),
    /civitai_lora_flux1_incompatible/,
  );

  const privatePath = path.join(root, "civitai-token-only", "loras.json");
  const compatible = {
    id: 456,
    modelId: 123,
    baseModel: "Flux.1 D",
    files: [civitaiFile({ id: 789 })],
  };
  let tokenlessDeliveryCalls = 0;
  const privateFetch: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    if (call.url === "https://civitai.red/api/v1/model-versions/456") {
      return jsonResponse(compatible);
    }
    if (call.url === "https://civitai.red/api/v1/models/123") {
      return jsonResponse({ id: 123, type: "LORA", modelVersions: [compatible] });
    }
    if (call.url === "https://civitai.com/api/download/models/456?fileId=789") {
      if (call.authorization === "Bearer civitai-local-token") return binaryResponse({});
      tokenlessDeliveryCalls += 1;
      return new Response("authentication required", { status: 401 });
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const privateOptions = registryOptions(privatePath, privateFetch);
  const privateRegistered = await registerLoraFromUrl({
    name: "仅本机令牌可下载",
    sourceUrl: "https://civitai.red/api/download/models/456?fileId=789",
    defaultStrength: 0.8,
  }, privateOptions);
  const privateSnapshot = await resolveAndSnapshotTaskLoras(
    selection(privateRegistered.item.id),
    privateOptions,
  );
  await assert.rejects(
    resolveTaskLoraDownloads(privateSnapshot, privateOptions),
    /civitai_lora_remote_delivery_requires_local_token/,
  );
  assert.equal(tokenlessDeliveryCalls, 1);
}

async function testHuggingFaceStrictGenerationResolution(root: string) {
  const registryPath = path.join(root, "huggingface", "loras.json");
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    calls.push(call);
    if (call.url.includes("https://huggingface.co/api/models/org/repo/revision/")) {
      return jsonResponse({
        sha: HF_COMMIT,
        siblings: [{
          rfilename: "weights/fixture-hf.safetensors",
          lfs: { sha256: HF_SHA, size: LORA_SIZE },
        }],
      });
    }
    if (call.url === `https://huggingface.co/org/repo/resolve/${HF_COMMIT}/weights/fixture-hf.safetensors`) {
      return redirectResponse("https://cdn.huggingface.example/fixture-hf.safetensors");
    }
    if (call.url === "https://cdn.huggingface.example/fixture-hf.safetensors") return binaryResponse({});
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl);
  const registered = await registerLoraFromUrl({
    name: "HF 固定提交 LoRA",
    sourceUrl: "https://hf.co/org/repo/blob/main/weights/fixture-hf.safetensors",
    defaultStrength: 0.65,
  }, options);
  assert.equal(calls.length, 0);
  const snapshot = await resolveAndSnapshotTaskLoras(selection(registered.item.id), options);
  assert.equal(snapshot?.[0]?.sha256, HF_SHA);
  assert.deepEqual(
    listRegisteredLoras({ registryPath }).find((item) => item.id === registered.item.id)?.source,
    {
      provider: "huggingface",
      repository: "org/repo",
      revision: HF_COMMIT,
      path: "weights/fixture-hf.safetensors",
    },
  );
  assert.equal(calls.some((call) => call.url.includes("/resolve/")), false,
    "confirmation must not probe HuggingFace binary delivery");
  await resolveTaskLoraDownloads(snapshot, options);
  assert.ok(calls.some((call) =>
    call.url === `https://huggingface.co/org/repo/resolve/${HF_COMMIT}/weights/fixture-hf.safetensors`));
  assert.equal(calls.some((call) => /\/resolve\/main\//.test(call.url)), false);
}

async function testPrivateHuggingFaceRegistersThenFailsClearly(root: string) {
  const registryPath = path.join(root, "huggingface-private", "loras.json");
  let tokenlessDeliveryCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    if (call.url.includes("https://huggingface.co/api/models/org/private/revision/")) {
      return jsonResponse({
        sha: HF_COMMIT,
        siblings: [{
          rfilename: "private.safetensors",
          lfs: { sha256: HF_SHA, size: LORA_SIZE },
        }],
      });
    }
    if (call.url === `https://huggingface.co/org/private/resolve/${HF_COMMIT}/private.safetensors`) {
      if (call.authorization === "Bearer hf-local-token") return binaryResponse({});
      tokenlessDeliveryCalls += 1;
      return new Response("authentication required", { status: 401 });
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl);
  const registered = await registerLoraFromUrl({
    name: "私有 HF",
    sourceUrl: "https://huggingface.co/org/private/blob/main/private.safetensors",
    defaultStrength: 0.8,
  }, options);
  const snapshot = await resolveAndSnapshotTaskLoras(selection(registered.item.id), options);
  await assert.rejects(
    resolveTaskLoraDownloads(snapshot, options),
    /huggingface_lora_remote_delivery_requires_local_token/,
  );
  assert.equal(tokenlessDeliveryCalls, 1);
  assert.equal(
    listRegisteredLoras({ registryPath }).find((item) => item.id === registered.item.id)?.availability,
    "ready",
  );
}

async function testDirectRegistersButNeedsTrustedIdentity(root: string) {
  const registryPath = path.join(root, "direct", "loras.json");
  const network = { calls: 0 };
  const options = noNetworkOptions(registryPath, network);
  const registered = await registerLoraFromUrl({
    name: "直接下载",
    sourceUrl: "https://downloads.example.net/files/direct.safetensors",
    defaultStrength: 0.9,
  }, options);
  assert.equal(registered.item.availability, "registered");
  assert.equal(registered.item.filename, "direct.safetensors");
  await assert.rejects(
    resolveAndSnapshotTaskLoras(selection(registered.item.id), options),
    /direct_lora_source_identity_unavailable/,
  );
  assert.equal(network.calls, 0);
}

async function testStrictResolutionNetworkGuards(root: string) {
  const privatePath = path.join(root, "private-dns", "loras.json");
  let privateFetchCalls = 0;
  const privateOptions = registryOptions(privatePath, async () => {
    privateFetchCalls += 1;
    throw new Error("fetch_must_not_run");
  }, { resolveHostname: async () => ["127.0.0.1"] });
  const privateItem = await registerLoraFromUrl({
    name: "私网拒绝",
    sourceUrl: "https://huggingface.co/org/repo/blob/main/private.safetensors",
    defaultStrength: 0.8,
  }, privateOptions);
  await assert.rejects(
    resolveAndSnapshotTaskLoras(selection(privateItem.item.id), privateOptions),
    /lora_source_nonpublic_address/,
  );
  assert.equal(privateFetchCalls, 0);

  const timeoutPath = path.join(root, "timeout", "loras.json");
  const timeoutFetch: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const fail = () => {
      const error = new Error("fixture_aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (init?.signal?.aborted) fail();
    else init?.signal?.addEventListener("abort", fail, { once: true });
  });
  const timeoutOptions = registryOptions(timeoutPath, timeoutFetch, { timeoutMs: 15 });
  const timeoutItem = await registerLoraFromUrl({
    name: "超时 LoRA",
    sourceUrl: "https://huggingface.co/org/repo/blob/main/timeout.safetensors",
    defaultStrength: 0.8,
  }, timeoutOptions);
  await assert.rejects(
    resolveAndSnapshotTaskLoras(selection(timeoutItem.item.id), timeoutOptions),
    /(?:lora_source_timeout|fixture_aborted)/,
  );
}

async function testStalledBodyTerminatesAtStrictResolution(root: string) {
  const registryPath = path.join(root, "stalled-body", "loras.json");
  let binarySignal: AbortSignal | null = null;
  let cancelCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    if (call.url.includes("https://huggingface.co/api/models/org/stalled/revision/")) {
      return jsonResponse({
        sha: HF_COMMIT,
        siblings: [{
          rfilename: "stalled.safetensors",
          lfs: { sha256: HF_SHA, size: LORA_SIZE },
        }],
      });
    }
    if (call.url === `https://huggingface.co/org/stalled/resolve/${HF_COMMIT}/stalled.safetensors`) {
      binarySignal = init?.signal ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(safetensorsPrefix().subarray(0, 4));
        },
        cancel() {
          cancelCalls += 1;
          return new Promise<void>(() => undefined);
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes 0-3/${LORA_SIZE}`,
          "content-length": "4",
        },
      });
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl, { timeoutMs: 30 });
  const registered = await registerLoraFromUrl({
    name: "正文停滞 LoRA",
    sourceUrl: "https://huggingface.co/org/stalled/blob/main/stalled.safetensors",
    defaultStrength: 0.8,
  }, options);
  const snapshot = await resolveAndSnapshotTaskLoras(selection(registered.item.id), options);
  const started = Date.now();
  await assert.rejects(
    resolveTaskLoraDownloads(snapshot, options),
    /lora_source_timeout/,
  );
  const elapsedMs = Date.now() - started;
  assert.ok(binarySignal);
  assert.equal(binarySignal.aborted, true);
  assert.equal(cancelCalls, 1);
  assert.ok(elapsedMs < 1_500, `stalled body/cancel must terminate promptly, elapsed=${elapsedMs}ms`);
}

function hfFixtureFetch(input: {
  metadataSha?: string;
  metadataSize?: number;
  binarySize?: number;
  binaryBody?: BodyInit | null;
}) {
  return (async (request, init) => {
    const call = callRecord(request, init);
    if (call.url.includes("https://huggingface.co/api/models/org/integrity/revision/")) {
      return jsonResponse({
        sha: HF_COMMIT,
        siblings: [{
          rfilename: "integrity.safetensors",
          lfs: {
            sha256: input.metadataSha ?? HF_SHA,
            size: input.metadataSize ?? LORA_SIZE,
          },
        }],
      });
    }
    if (call.url === `https://huggingface.co/org/integrity/resolve/${HF_COMMIT}/integrity.safetensors`) {
      return binaryResponse({
        body: input.binaryBody,
        totalBytes: input.binarySize ?? LORA_SIZE,
      });
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  }) as typeof fetch;
}

async function registerThenResolveIntegrityFixture(
  registryPath: string,
  fetchImpl: typeof fetch,
) {
  const options = registryOptions(registryPath, fetchImpl);
  const registered = await registerLoraFromUrl({
    name: "完整性测试",
    sourceUrl: "https://huggingface.co/org/integrity/blob/main/integrity.safetensors",
    defaultStrength: 0.8,
  }, options);
  assert.equal(registered.item.availability, "registered");
  const snapshot = await resolveAndSnapshotTaskLoras(selection(registered.item.id), options);
  return { snapshot, options };
}

async function testIntegrityFailuresOccurAtStrictResolution(root: string) {
  await assert.rejects(
    registerThenResolveIntegrityFixture(
      path.join(root, "bad-hash", "loras.json"),
      hfFixtureFetch({ metadataSha: "not-a-sha256" }),
    ),
    /huggingface_lora_identity_incomplete/,
  );
  await assert.rejects(
    (async () => {
      const fixture = await registerThenResolveIntegrityFixture(
        path.join(root, "bad-size", "loras.json"),
        hfFixtureFetch({ metadataSize: LORA_SIZE + 1, binarySize: LORA_SIZE }),
      );
      await resolveTaskLoraDownloads(fixture.snapshot, fixture.options);
    })(),
    /huggingface_lora_size_mismatch/,
  );
  await assert.rejects(
    (async () => {
      const fixture = await registerThenResolveIntegrityFixture(
        path.join(root, "corrupt-header", "loras.json"),
        hfFixtureFetch({ binaryBody: Buffer.alloc(32) }),
      );
      await resolveTaskLoraDownloads(fixture.snapshot, fixture.options);
    })(),
    /invalid_safetensors_header_length/,
  );
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "image-lora-registry-"));
  const checks: Array<[string, () => Promise<void>]> = [
    ["默认项与旧 ready 记录兼容", () => testDefaultAndLegacyReadyRegistry(root)],
    ["Civitai red/com、HF/hf.co 与直链均零网络注册", () => testRecognizedFormatsRegisterWithoutNetwork(root)],
    ["无法识别或不安全链接明确拒绝", () => testUnrecognizedSourceRejected(root)],
    ["Windows 仅接受无凭据回环代理", () => testWindowsLoopbackProxyParsing()],
    ["Civitai 待下载项建卡零网络、确认锁定身份、租卡前探测", () => testCivitaiStrictGenerationResolution(root)],
    ["Civitai 旧文件元数据大小漂移使用实际传输长度", () => testCivitaiAdvertisedSizeDriftUsesExactTransferSize(root)],
    ["未启用待下载项不访问网络", () => testDisabledRegisteredDoesNotResolve(root)],
    ["Civitai.red 模型页选择当前 FLUX.1-D 兼容版本", () => testCivitaiModelPageChoosesFlux1VersionFromRedMetadata(root)],
    ["明确 Civitai fileId 不匹配在生成前失败", () => testExplicitCivitaiFileMismatchFailsAtGeneration(root)],
    ["Civitai 元数据备用端点与请求身份严格关联", () => testCivitaiFallbackAndIdentityCorrelation(root)],
    ["显式 Civitai 版本兼容性与无令牌交付在租卡前关闭", () => testCivitaiExplicitCompatibilityAndTokenlessDelivery(root)],
    ["HuggingFace/hf.co 在任务创建前固定不可变身份", () => testHuggingFaceStrictGenerationResolution(root)],
    ["私有 HuggingFace 可注册但无令牌远端交付失败", () => testPrivateHuggingFaceRegistersThenFailsClearly(root)],
    ["直接文件可注册但缺可信身份时清晰失败", () => testDirectRegistersButNeedsTrustedIdentity(root)],
    ["严格解析保留 DNS 与超时保护", () => testStrictResolutionNetworkGuards(root)],
    ["严格解析正文停滞可有界退出", () => testStalledBodyTerminatesAtStrictResolution(root)],
    ["哈希、大小与 safetensors 损坏在严格解析阶段拒绝", () => testIntegrityFailuresOccurAtStrictResolution(root)],
  ];
  let passed = 0;
  try {
    for (const [name, check] of checks) {
      const started = Date.now();
      process.stdout.write(`CHECK ${name}\n`);
      await check();
      passed += 1;
      process.stdout.write(`PASS ${name} (${Date.now() - started}ms)\n`);
    }
    process.stdout.write(`SUMMARY passed=${passed} failed=0 total=${checks.length}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
