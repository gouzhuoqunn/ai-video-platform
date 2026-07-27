import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  ImmutableSourceResolutionError,
  immutablePublicSourceEndpoints,
  resolveImmutableSource,
  type ImmutableSourceEndpoint,
  type ResolvedImmutableSource,
} from "./immutable-source-resolver";

export type Rtx4090GoldenDeploymentProfile = {
  id: "rtx4090-golden-agent-v1";
  gpuClass: "rtx4090";
  supportedDimensions: { maxWidth: 1280; maxHeight: 1280 };
  image: "cloreai/jupyter:ubuntu24.04-v2";
  ports: { "8080": "http" };
  healthPath: "/healthz";
  controllerBind: "0.0.0.0:8080";
  immutable: {
    commit: string;
    agentSourceSha256: string;
    agentSha256: string;
    controllerSha256: string;
    workflowSha256: string;
  };
  agentContract: "stage-acceptance-v2";
  acceptedStageResponseFields: readonly ["accepted", "state", "status", "stage", "stage_run_id"];
  bootstrapTemplateSha256: string;
};

const immutable = {
  // The published commit contains the accepted controller/workflow and the
  // immediate predecessor of stage-acceptance-v2. The fixed patch below
  // materializes the locally pinned Agent byte-for-byte before it can execute.
  commit: "5c9364c291ea6a10b36024832a8d1e14200889c2",
  agentSourceSha256: "678083c89a96579f7e1bf9f7b9d2783f950d83aba43a57e42d841be4a333af51",
  agentSha256: "26b6c3ef0fe59f1f5bf7fc7fb46a0036036b68cddb45bccb81de0771384a724f",
  controllerSha256: "96569eb5eee895f974d7b8304bb15f3b38e8f806115aae90f06bf0f8b927563e",
  workflowSha256: "e5b3e4cc7f347888f3231a82068d746740d5cb575905351ac4c7949d4b1cdd0d",
} as const;

export const RTX4090_GOLDEN_AGENT_SOURCE_PATCHES = [
  [
    "import argparse\nimport http.client",
    "import argparse\nfrom collections import deque\nimport http.client",
  ],
  [
    "def run_stage(route: str, payload: dict[str, Any]) -> str | None:",
    "def run_stage(route: str, payload: dict[str, Any], stage_run_id: str) -> str | None:",
  ],
  ["    stage_run_id = str(uuid.uuid4())\n", ""],
  [
    "\"agent\": \"restricted-clore-diagnostic\", \"current_stage\":",
    "\"agent\": \"restricted-clore-diagnostic\", \"agent_contract\": \"stage-acceptance-v2\", \"agent_sha256\": sha256(Path(__file__)), \"current_stage\":",
  ],
  [
    "if length < 0 or length > limit: self.send_json(413, {\"error\": \"stage_body_too_large\"}); return",
    "if length < 0 or (limit > 0 and length > limit) or (limit == 0 and length > 128): self.send_json(413, {\"error\": \"stage_body_too_large\"}); return",
  ],
  ["        if limit == 0 and raw: self.send_json(400, {\"error\": \"stage_parameters_forbidden\"}); return\n", ""],
  [
    "        if not isinstance(payload, dict): self.send_json(400, {\"error\": \"invalid_stage_payload\"}); return\n",
    "        if not isinstance(payload, dict): self.send_json(400, {\"error\": \"invalid_stage_payload\"}); return\n        stage_run_id = payload.pop(\"stage_run_id\", None)\n        if not isinstance(stage_run_id, str) or not UUID_RE.fullmatch(stage_run_id): self.send_json(400, {\"error\": \"stage_run_id_required\"}); return\n        if limit == 0 and payload: self.send_json(400, {\"error\": \"stage_parameters_forbidden\"}); return\n",
  ],
  ["stage_run_id = run_stage(route, payload)", "stage_run_id = run_stage(route, payload, stage_run_id)"],
  [
    "{\"accepted\": True, \"stage\": item[0], \"stage_run_id\": stage_run_id}",
    "{\"accepted\": True, \"state\": \"accepted\", \"status\": \"running\", \"stage\": item[0], \"stage_run_id\": stage_run_id}",
  ],
  [
    `RAW_ROOT = "https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform"`,
    `IMMUTABLE_SOURCE_ROOTS = (
    ("jsdelivr_commit_cdn", "https://cdn.jsdelivr.net/gh/gouzhuoqunn/ai-video-platform"),
    ("github_raw_commit", "https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform"),
)`,
  ],
  [
    `def raw_file_url(path: str) -> str:
    return f"{RAW_ROOT}/{CONFIG['project_commit']}/{path}"


def fetch_small_verified(url: str, destination: Path, expected: str) -> None:
    try:
        with urllib.request.urlopen(url, timeout=45) as response:
            if response.status != 200:
                raise RuntimeError(f"raw_download_http_{response.status}")
            content = response.read(2 * 1024 * 1024)
    except Exception as error:
        raise RuntimeError(f"raw_download_failed:{clean(error, 400)}") from error
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    if sha256(destination) != expected:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"raw_sha256_mismatch:{destination.name}")`,
    `def immutable_file_urls(path: str) -> list[tuple[str, str]]:
    commit = CONFIG["project_commit"]
    return [
        ("jsdelivr_commit_cdn", f"{IMMUTABLE_SOURCE_ROOTS[0][1]}@{commit}/{path}"),
        ("github_raw_commit", f"{IMMUTABLE_SOURCE_ROOTS[1][1]}/{commit}/{path}"),
    ]


def fetch_small_verified(sources: list[tuple[str, str]], destination: Path, expected: str) -> dict[str, Any]:
    failures: list[str] = []
    for source_id, url in sources:
        try:
            with urllib.request.urlopen(url, timeout=45) as response:
                if response.status != 200:
                    failures.append(f"{source_id}:http_{response.status}")
                    continue
                content_type = (response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                content = response.read(2 * 1024 * 1024 + 1)
        except Exception:
            failures.append(f"{source_id}:transport_failed")
            continue
        if not content or len(content) > 2 * 1024 * 1024:
            failures.append(f"{source_id}:size_invalid")
            continue
        actual = hashlib.sha256(content).hexdigest()
        if actual != expected:
            raise RuntimeError(f"immutable_source_sha256_mismatch:{source_id}:{destination.name}")
        try:
            text = content.decode("utf-8")
            prefix = text.lstrip()[:32].lower()
            safe_text = "\\x00" not in text and not prefix.startswith("<!doctype html") and not prefix.startswith("<html")
        except UnicodeDecodeError:
            safe_text = False
        if content_type not in {"application/octet-stream", "application/x-python", "text/plain", "text/x-python"} and not safe_text:
            failures.append(f"{source_id}:content_incompatible")
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        return {"endpoint_id": source_id, "bytes": len(content), "sha256": actual}
    raise RuntimeError("immutable_source_unavailable:" + ",".join(failures))`,
  ],
  [
    `    fetch_small_verified(raw_file_url("comfy-runtime/controller.py"), controller, CONFIG["controller_sha256"])
    fetch_small_verified(raw_file_url("comfy-runtime/image_workflow.py"), workflow, CONFIG["workflow_sha256"])`,
    `    controller_source = fetch_small_verified(immutable_file_urls("comfy-runtime/controller.py"), controller, CONFIG["controller_sha256"])
    workflow_source = fetch_small_verified(immutable_file_urls("comfy-runtime/image_workflow.py"), workflow, CONFIG["workflow_sha256"])`,
  ],
  [
    `    return runtime, {"project_commit": CONFIG["project_commit"], "controller_sha256": sha256(controller), "image_workflow_sha256": sha256(workflow), "import": check}`,
    `    return runtime, {"project_commit": CONFIG["project_commit"], "controller_sha256": sha256(controller), "image_workflow_sha256": sha256(workflow), "controller_source": controller_source, "workflow_source": workflow_source, "import": check}`,
  ],
  [
    `    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    patterns = re.compile(r"ERROR|WARNING: Retrying|ResolutionImpossible|No matching distribution|Could not find|dependency conflict|Requires-Python|Killed|No space left|Traceback|subprocess-exited-with-error|externally-managed-environment", re.I)
    return {"command": " ".join(command), "log_path": str(log), "started_at": started_at, "finished_at": now(), "duration_seconds": round(time.monotonic() - started, 3), "exit_code": exit_code, "timed_out": timed_out, "first_output_lines": [clean(line, 500) for line in lines[:30]], "final_output_lines": [clean(line, 500) for line in lines[-120:]], "error_matches": [clean(line, 500) for line in lines if patterns.search(line)]}`,
    `    patterns = re.compile(r"ERROR|WARNING: Retrying|ResolutionImpossible|No matching distribution|Could not find|dependency conflict|Requires-Python|Killed|No space left|Traceback|subprocess-exited-with-error|externally-managed-environment", re.I)
    first_output_lines: list[str] = []
    final_output_lines: deque[str] = deque(maxlen=120)
    error_matches: list[str] = []
    with log.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = clean(raw_line.rstrip("\\r\\n"), 500)
            if len(first_output_lines) < 30:
                first_output_lines.append(line)
            final_output_lines.append(line)
            if len(error_matches) < 120 and patterns.search(line):
                error_matches.append(line)
    return {"command": " ".join(command), "log_path": str(log), "started_at": started_at, "finished_at": now(), "duration_seconds": round(time.monotonic() - started, 3), "exit_code": exit_code, "timed_out": timed_out, "first_output_lines": first_output_lines, "final_output_lines": list(final_output_lines), "error_matches": error_matches}`,
  ],
] as const;

export function applyPublishedAgentSourcePatch(source: Buffer) {
  let materialized = source.toString("utf8");
  for (const [search, replacement] of RTX4090_GOLDEN_AGENT_SOURCE_PATCHES) {
    const first = materialized.indexOf(search);
    if (first < 0 || materialized.indexOf(search, first + search.length) >= 0) {
      throw new Error("golden_agent_source_patch_context_mismatch");
    }
    materialized = `${materialized.slice(0, first)}${replacement}${materialized.slice(first + search.length)}`;
  }
  return Buffer.from(materialized, "utf8");
}

function buildBootstrap(input: Rtx4090GoldenDeploymentProfile["immutable"] & { tokenSha256: string }) {
  const urls = immutablePublicSourceEndpoints(input.commit, "scripts/clore/diagnostic-agent.py").map((endpoint) => endpoint.url);
  const patch = deflateRawSync(Buffer.from(JSON.stringify(RTX4090_GOLDEN_AGENT_SOURCE_PATCHES), "utf8")).toString("base64");
  const program = [
    "import urllib.request as u,hashlib as h,os,json,base64,zlib,functools as f",
    `urls=${JSON.stringify(urls)}`,
    "d=None",
    "for x in urls:",
    " try:",
    "  r=u.urlopen(x,timeout=30)",
    "  if getattr(r,'status',200)!=200: continue",
    "  b=r.read(2097153)",
    "  if len(b)>2097152: continue",
    "  c=(r.headers.get('Content-Type') or '').split(';',1)[0].strip().lower()",
    "  if c not in ('application/octet-stream','application/x-python','text/plain','text/x-python'):",
    "   try:",
    "    t=b.decode('utf-8');s=t.lstrip()[:32].lower()",
    "    if chr(0) in t or any(ord(ch)<32 and ch not in '\\t\\n\\r' for ch in t) or s.startswith('<!doctype html') or s.startswith('<html'): continue",
    "   except UnicodeDecodeError: continue",
    `  if h.sha256(b).hexdigest()!='${input.agentSourceSha256}': raise RuntimeError('immutable_source_hash_mismatch')`,
    "  d=b;break",
    " except RuntimeError: raise",
    " except Exception: pass",
    "if d is None: raise RuntimeError('immutable_source_unavailable')",
    `q=json.loads(zlib.decompress(base64.b64decode('${patch}'),-15))`,
    "d=f.reduce(lambda x,y:x.replace(y[0],y[1]),q,d.decode()).encode()",
    `assert h.sha256(d).hexdigest()=='${input.agentSha256}'`,
    "p='/tmp/a.py';open(p,'wb').write(d)",
    `os.execvp('python3',['python3',p,'--token-sha256','${input.tokenSha256}','--immutable','${input.commit}:${input.controllerSha256}:${input.workflowSha256}'])`,
  ].join("\n");
  const encoded = deflateRawSync(Buffer.from(program, "utf8")).toString("base64");
  return `python3 -c "import base64,zlib;exec(zlib.decompress(base64.b64decode('${encoded}'),-15))"`;
}

const templateTokenSha256 = "0".repeat(64);
export const RTX4090_GOLDEN_DEPLOYMENT_PROFILE: Rtx4090GoldenDeploymentProfile = {
  id: "rtx4090-golden-agent-v1",
  gpuClass: "rtx4090",
  supportedDimensions: { maxWidth: 1280, maxHeight: 1280 },
  image: "cloreai/jupyter:ubuntu24.04-v2",
  ports: { "8080": "http" },
  healthPath: "/healthz",
  controllerBind: "0.0.0.0:8080",
  immutable,
  agentContract: "stage-acceptance-v2",
  acceptedStageResponseFields: ["accepted", "state", "status", "stage", "stage_run_id"],
  bootstrapTemplateSha256: createHash("sha256").update(buildBootstrap({ ...immutable, tokenSha256: templateTokenSha256 })).digest("hex"),
};

export function rtx4090GoldenDeploymentFingerprint(profile = RTX4090_GOLDEN_DEPLOYMENT_PROFILE) {
  const canonicalIdentity = {
    scope: "clore-rtx4090-deployment-profile-v1",
    id: profile.id,
    gpuClass: profile.gpuClass,
    supportedDimensions: {
      maxWidth: profile.supportedDimensions.maxWidth,
      maxHeight: profile.supportedDimensions.maxHeight,
    },
    image: profile.image,
    ports: { "8080": profile.ports["8080"] },
    healthPath: profile.healthPath,
    controllerBind: profile.controllerBind,
    immutable: {
      commit: profile.immutable.commit,
      agentSourceSha256: profile.immutable.agentSourceSha256,
      agentSha256: profile.immutable.agentSha256,
      controllerSha256: profile.immutable.controllerSha256,
      workflowSha256: profile.immutable.workflowSha256,
    },
    agentContract: profile.agentContract,
    acceptedStageResponseFields: [...profile.acceptedStageResponseFields],
    bootstrapTemplateSha256: profile.bootstrapTemplateSha256,
  };
  return createHash("sha256").update(JSON.stringify(canonicalIdentity)).digest("hex");
}

export function buildRtx4090GoldenBootstrap(tokenSha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(tokenSha256)) throw new Error("golden_deployment_token_hash_invalid");
  const command = buildBootstrap({ ...RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable, tokenSha256 });
  if (Buffer.byteLength(command, "utf8") >= 8_192) throw new Error("golden_deployment_bootstrap_too_long");
  return command;
}

export function rtx4090GoldenBootstrapByteLength(tokenSha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(tokenSha256)) throw new Error("golden_deployment_token_hash_invalid");
  return Buffer.byteLength(buildBootstrap({ ...RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable, tokenSha256 }), "utf8");
}

export function assertRtx4090GoldenDeploymentProfile(profile = RTX4090_GOLDEN_DEPLOYMENT_PROFILE) {
  if (profile.image !== "cloreai/jupyter:ubuntu24.04-v2" || profile.ports["8080"] !== "http" || profile.healthPath !== "/healthz" || profile.controllerBind !== "0.0.0.0:8080" || profile.agentContract !== "stage-acceptance-v2" || profile.acceptedStageResponseFields.join(",") !== "accepted,state,status,stage,stage_run_id") {
    throw new Error("rtx4090_golden_deployment_profile_drift");
  }
  const expected = createHash("sha256").update(buildBootstrap({ ...profile.immutable, tokenSha256: templateTokenSha256 })).digest("hex");
  if (expected !== profile.bootstrapTemplateSha256) throw new Error("rtx4090_golden_bootstrap_hash_mismatch");
  const localAgent = createHash("sha256").update(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "clore", "diagnostic-agent.py"))).digest("hex");
  if (localAgent !== profile.immutable.agentSha256) throw new Error("rtx4090_golden_agent_contract_source_mismatch");
  return profile;
}

type GoldenSourceRole = "agent" | "controller" | "workflow";

type GoldenResolvedSource = {
  role: GoldenSourceRole;
  sourcePath: string;
  resolved: ResolvedImmutableSource;
};

function immutableSourceEvidencePath() {
  return path.join(process.cwd(), ".secrets", "diagnostics", "rtx4090-immutable-source-preflight.json");
}

function writeImmutableSourceEvidence(filePath: string | false | undefined, value: unknown) {
  if (filePath === false) return;
  const target = path.resolve(filePath ?? immutableSourceEvidencePath());
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

function resolvedSourceProjection(source: GoldenResolvedSource) {
  const verifiedEndpoint = [...source.resolved.evidence].reverse().find((entry) =>
    entry.classification === "verified" || entry.classification === "cache_verified");
  return {
    source: source.resolved.source,
    endpointId: source.resolved.endpointId,
    httpStatus: verifiedEndpoint?.httpStatus ?? null,
    contentType: verifiedEndpoint?.contentType ?? null,
    bytes: source.resolved.bytes.length,
    sha256: source.resolved.sha256,
    evidence: source.resolved.evidence,
  };
}

export async function verifyRtx4090GoldenPublishedSources(options: {
  fetchImpl?: typeof fetch;
  cacheRoot?: string;
  timeoutMs?: number;
  evidencePath?: string | false;
  endpointFactory?: (input: {
    role: GoldenSourceRole;
    commit: string;
    sourcePath: string;
  }) => ImmutableSourceEndpoint[];
} = {}) {
  const profile = assertRtx4090GoldenDeploymentProfile();
  const profileFingerprint = rtx4090GoldenDeploymentFingerprint(profile);
  const specifications = [
    {
      role: "agent" as const,
      sourcePath: "scripts/clore/diagnostic-agent.py",
      expectedSha256: profile.immutable.agentSourceSha256,
    },
    {
      role: "controller" as const,
      sourcePath: "comfy-runtime/controller.py",
      expectedSha256: profile.immutable.controllerSha256,
    },
    {
      role: "workflow" as const,
      sourcePath: "comfy-runtime/image_workflow.py",
      expectedSha256: profile.immutable.workflowSha256,
    },
  ];
  const completed: GoldenResolvedSource[] = [];
  let activeRole: GoldenSourceRole | null = null;
  try {
    for (const specification of specifications) {
      activeRole = specification.role;
      const resolved = await resolveImmutableSource({
        profileFingerprint,
        commit: profile.immutable.commit,
        sourcePath: specification.sourcePath,
        expectedSha256: specification.expectedSha256,
        cacheRoot: options.cacheRoot,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        endpoints: options.endpointFactory?.({
          role: specification.role,
          commit: profile.immutable.commit,
          sourcePath: specification.sourcePath,
        }),
      });
      completed.push({ role: specification.role, sourcePath: specification.sourcePath, resolved });
    }
    const agentSource = completed.find((source) => source.role === "agent");
    const controller = completed.find((source) => source.role === "controller");
    const workflow = completed.find((source) => source.role === "workflow");
    if (!agentSource || !controller || !workflow) throw new Error("golden_runtime_source_bundle_incomplete");
    const materializedAgentSha256 = createHash("sha256")
      .update(applyPublishedAgentSourcePatch(agentSource.resolved.bytes))
      .digest("hex");
    if (materializedAgentSha256 !== profile.immutable.agentSha256) {
      throw new Error("golden_runtime_materialized_agent_sha256_mismatch");
    }
    const result = {
      classification: "published_sources_verified" as const,
      verifiedAt: new Date().toISOString(),
      profileFingerprint,
      commit: profile.immutable.commit,
      agent: {
        ...resolvedSourceProjection(agentSource),
        sourceBytes: agentSource.resolved.bytes.length,
        sourceSha256: agentSource.resolved.sha256,
        materializedSha256: materializedAgentSha256,
      },
      controller: resolvedSourceProjection(controller),
      workflow: resolvedSourceProjection(workflow),
    };
    writeImmutableSourceEvidence(options.evidencePath, result);
    return result;
  } catch (error) {
    const failure = {
      classification: "immutable_source_preflight_failed",
      failedAt: new Date().toISOString(),
      profileFingerprint,
      commit: profile.immutable.commit,
      failedRole: activeRole,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      completed: completed.map(resolvedSourceProjection),
      evidence: error instanceof ImmutableSourceResolutionError ? error.evidence : [],
    };
    writeImmutableSourceEvidence(options.evidencePath, failure);
    throw error;
  }
}
