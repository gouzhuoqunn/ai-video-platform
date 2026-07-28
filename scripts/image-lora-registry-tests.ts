import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listRegisteredLoras,
  registerLoraFromUrl,
  snapshotTaskLoras,
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
}) {
  return {
    id: input.id,
    name: input.name ?? "fixture-lora.safetensors",
    primary: input.primary ?? true,
    type: "Model",
    hashes: { SHA256: input.sha256 ?? CIVITAI_SHA },
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

async function testDefaultRegistry(root: string) {
  const registryPath = path.join(root, "defaults", "loras.json");
  mkdirSync(path.dirname(registryPath), { recursive: true });
  const items = listRegisteredLoras({ registryPath });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.name), [
    "画裸体LoRA",
    "解决男人女器官LoRA",
    "大肌肉阳刚LoRA",
  ]);
  assert.deepEqual(items.map((item) => item.availability), ["ready", "missing", "missing"]);
  assert.equal(items[0].defaultStrength, 0.8);
  assert.equal(items[1].defaultStrength, 0.85);
  assert.equal(items[2].defaultStrength, 0.75);
  assert.equal(items[0].defaultEnabled, true);
  assert.equal(items[1].defaultEnabled, false);
  assert.equal(items[2].defaultEnabled, false);
  assert.equal(existsSync(registryPath), false, "read-only default listing must not create registry state");
}

async function testCivitaiRegistrationPersistenceAndSnapshot(root: string) {
  const registryPath = path.join(root, "civitai-success", "loras.json");
  const calls: FetchCall[] = [];
  const version = {
    id: 456,
    modelId: 123,
    files: [civitaiFile({ id: 789 })],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    calls.push(call);
    if (call.url === "https://civitai.com/api/v1/model-versions/456") {
      return jsonResponse(version);
    }
    if (call.url === "https://civitai.com/api/v1/models/123") {
      return jsonResponse({ id: 123, type: "LORA", modelVersions: [version] });
    }
    if (call.url === "https://civitai.com/api/download/models/456") {
      return redirectResponse("https://cdn.civitai.example/fixture-lora.safetensors");
    }
    if (call.url === "https://cdn.civitai.example/fixture-lora.safetensors") {
      return binaryResponse({});
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };

  const result = await registerLoraFromUrl({
    name: "测试 Civitai LoRA",
    sourceUrl: "https://civitai.com/models/123/fixture?modelVersionId=456&fileId=789",
    defaultStrength: 0.7,
  }, registryOptions(registryPath, fetchImpl));

  assert.equal(result.item.name, "测试 Civitai LoRA");
  assert.equal(result.item.filename, "fixture-lora.safetensors");
  assert.equal(result.item.sha256, CIVITAI_SHA);
  assert.equal(result.item.sizeBytes, LORA_SIZE);
  assert.deepEqual(result.item.source, {
    provider: "civitai",
    modelId: 123,
    versionId: 456,
    fileId: 789,
  });
  assert.equal(result.verification.finalHostname, "cdn.civitai.example");
  assert.equal(result.verification.redirectCount, 1);
  assert.equal(result.items.length, 4);

  const civitaiOriginCalls = calls.filter((call) => new URL(call.url).origin === "https://civitai.com");
  const cdnCalls = calls.filter((call) => new URL(call.url).hostname === "cdn.civitai.example");
  assert.ok(civitaiOriginCalls.every((call) => call.authorization === "Bearer civitai-local-token"));
  assert.ok(cdnCalls.every((call) => call.authorization === null), "credential must not cross redirect origin");
  assert.ok(calls.every((call) => call.redirect === "manual"));
  assert.ok(calls.some((call) => call.range?.startsWith("bytes=0-")));

  assert.equal(existsSync(registryPath), true);
  const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
    schemaVersion: number;
    items: Array<{ id: string; filename: string; sha256: string }>;
  };
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.items.find((item) => item.id === result.item.id)?.sha256, CIVITAI_SHA);
  assert.equal(readFileSync(registryPath, "utf8").includes("civitai-local-token"), false);
  assert.equal(readFileSync(registryPath, "utf8").includes("cdn.civitai.example"), false);
  assert.equal(existsSync(`${registryPath}.lock`), false);

  const reread = listRegisteredLoras({ registryPath });
  assert.equal(reread.find((item) => item.id === result.item.id)?.filename, "fixture-lora.safetensors");

  const snapshot = snapshotTaskLoras([{
    id: result.item.id,
    name: "browser-spoof",
    filename: "../browser-spoof.safetensors",
    sha256: "0".repeat(64),
    sizeBytes: 1,
    strength: 1.25,
    enabled: true,
  }], { registryPath });
  assert.deepEqual(snapshot, [{
    id: result.item.id,
    name: "测试 Civitai LoRA",
    filename: "fixture-lora.safetensors",
    strength: 1.25,
    enabled: true,
    sha256: CIVITAI_SHA,
    sizeBytes: LORA_SIZE,
  }], "task identity must be an authoritative registry snapshot");
  assert.deepEqual(snapshotTaskLoras([], { registryPath }), []);
  assert.equal(snapshotTaskLoras(undefined, { registryPath }), undefined);
}

async function testCivitaiAmbiguousPageThenSpecificDownload(root: string) {
  const registryPath = path.join(root, "civitai-specific", "loras.json");
  const ambiguousVersion = {
    id: 900,
    modelId: 88,
    files: [
      civitaiFile({
        id: 701,
        name: "first.safetensors",
        sha256: "d".repeat(64),
        primary: false,
        downloadUrl: "https://civitai.com/api/download/models/900?fileId=701",
      }),
      civitaiFile({
        id: 702,
        name: "second.safetensors",
        sha256: "e".repeat(64),
        primary: false,
        downloadUrl: "https://civitai.com/api/download/models/900?fileId=702",
      }),
    ],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    if (call.url === "https://civitai.com/api/v1/models/88") {
      return jsonResponse({ id: 88, type: "LORA", modelVersions: [ambiguousVersion] });
    }
    if (call.url === "https://civitai.com/api/v1/model-versions/900") {
      return jsonResponse(ambiguousVersion);
    }
    if (call.url === "https://civitai.com/api/download/models/900?fileId=702") {
      return binaryResponse({});
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };
  const options = registryOptions(registryPath, fetchImpl);

  await assert.rejects(
    registerLoraFromUrl({
      name: "歧义页面",
      sourceUrl: "https://civitai.com/models/88/ambiguous",
      defaultStrength: 0.8,
    }, options),
    /civitai_lora_file_ambiguous_or_missing/,
  );
  assert.equal(existsSync(registryPath), false, "failed source resolution must not persist partial state");

  const specific = await registerLoraFromUrl({
    name: "明确文件",
    sourceUrl: "https://civitai.com/api/download/models/900?fileId=702",
    defaultStrength: 0.9,
  }, options);
  assert.equal(specific.item.filename, "second.safetensors");
  assert.equal(specific.item.sha256, "e".repeat(64));
  assert.deepEqual(specific.item.source, {
    provider: "civitai",
    modelId: 88,
    versionId: 900,
    fileId: 702,
  });
}

async function testHuggingFaceImmutableRevision(root: string) {
  const registryPath = path.join(root, "huggingface", "loras.json");
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = callRecord(input, init);
    calls.push(call);
    if (call.url.includes("https://huggingface.co/api/models/org/repo/revision/main")) {
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
    if (call.url === "https://cdn.huggingface.example/fixture-hf.safetensors") {
      return binaryResponse({});
    }
    throw new Error(`unexpected_fixture_url:${call.url}`);
  };

  const result = await registerLoraFromUrl({
    name: "HF 固定提交 LoRA",
    sourceUrl: "https://huggingface.co/org/repo/blob/main/weights/fixture-hf.safetensors",
    defaultStrength: 0.65,
  }, registryOptions(registryPath, fetchImpl));

  assert.deepEqual(result.item.source, {
    provider: "huggingface",
    repository: "org/repo",
    revision: HF_COMMIT,
    path: "weights/fixture-hf.safetensors",
  });
  assert.equal(result.item.sha256, HF_SHA);
  assert.ok(calls.some((call) =>
    call.url === `https://huggingface.co/org/repo/resolve/${HF_COMMIT}/weights/fixture-hf.safetensors`));
  assert.equal(calls.some((call) => /\/resolve\/main\//.test(call.url)), false);
  assert.ok(calls.filter((call) => new URL(call.url).origin === "https://huggingface.co")
    .every((call) => call.authorization === "Bearer hf-local-token"));
  assert.ok(calls.filter((call) => new URL(call.url).hostname === "cdn.huggingface.example")
    .every((call) => call.authorization === null));
}

async function testPrivateDnsRejected(root: string) {
  const registryPath = path.join(root, "private-dns", "loras.json");
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch_must_not_run");
  };
  await assert.rejects(
    registerLoraFromUrl({
      name: "私网拒绝",
      sourceUrl: "https://huggingface.co/org/repo/blob/main/private.safetensors",
      defaultStrength: 0.8,
    }, registryOptions(registryPath, fetchImpl, {
      resolveHostname: async () => ["127.0.0.1"],
    })),
    /lora_source_nonpublic_address/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(existsSync(registryPath), false);
}

async function testNetworkTimeout(root: string) {
  const registryPath = path.join(root, "timeout", "loras.json");
  const fetchImpl: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const fail = () => {
      const error = new Error("fixture_aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (init?.signal?.aborted) {
      fail();
      return;
    }
    init?.signal?.addEventListener("abort", fail, { once: true });
  });

  await assert.rejects(
    registerLoraFromUrl({
      name: "超时 LoRA",
      sourceUrl: "https://huggingface.co/org/repo/blob/main/timeout.safetensors",
      defaultStrength: 0.8,
    }, registryOptions(registryPath, fetchImpl, { timeoutMs: 15 })),
    /(?:lora_source_timeout|fixture_aborted)/,
  );
  assert.equal(existsSync(registryPath), false);
}

function hfFixtureFetch(input: {
  metadataSha?: string;
  metadataSize?: number;
  binarySize?: number;
  binaryBody?: BodyInit | null;
}) {
  return (async (request, init) => {
    const call = callRecord(request, init);
    if (call.url.includes("https://huggingface.co/api/models/org/integrity/revision/main")) {
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

async function testIntegrityFailures(root: string) {
  const sourceUrl = "https://huggingface.co/org/integrity/blob/main/integrity.safetensors";

  const badHashPath = path.join(root, "bad-hash", "loras.json");
  await assert.rejects(
    registerLoraFromUrl({
      name: "错误哈希",
      sourceUrl,
      defaultStrength: 0.8,
    }, registryOptions(badHashPath, hfFixtureFetch({ metadataSha: "not-a-sha256" }))),
    /huggingface_lora_identity_incomplete/,
  );
  assert.equal(existsSync(badHashPath), false);

  const badSizePath = path.join(root, "bad-size", "loras.json");
  await assert.rejects(
    registerLoraFromUrl({
      name: "错误大小",
      sourceUrl,
      defaultStrength: 0.8,
    }, registryOptions(badSizePath, hfFixtureFetch({
      metadataSize: LORA_SIZE + 1,
      binarySize: LORA_SIZE,
    }))),
    /huggingface_lora_size_mismatch/,
  );
  assert.equal(existsSync(badSizePath), false);

  const corruptPath = path.join(root, "corrupt-header", "loras.json");
  await assert.rejects(
    registerLoraFromUrl({
      name: "损坏 safetensors",
      sourceUrl,
      defaultStrength: 0.8,
    }, registryOptions(corruptPath, hfFixtureFetch({
      binaryBody: Buffer.alloc(32),
    }))),
    /invalid_safetensors_header_length/,
  );
  assert.equal(existsSync(corruptPath), false);
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "image-lora-registry-"));
  const checks: Array<[string, () => Promise<void>]> = [
    ["默认三项", () => testDefaultRegistry(root)],
    ["Civitai 注册、持久化与任务快照", () => testCivitaiRegistrationPersistenceAndSnapshot(root)],
    ["Civitai 歧义页面失败后使用具体下载链接", () => testCivitaiAmbiguousPageThenSpecificDownload(root)],
    ["HuggingFace 分支固定到不可变提交", () => testHuggingFaceImmutableRevision(root)],
    ["DNS 私网地址拒绝", () => testPrivateDnsRejected(root)],
    ["网络请求超时", () => testNetworkTimeout(root)],
    ["错误哈希、错误大小与损坏 safetensors", () => testIntegrityFailures(root)],
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
