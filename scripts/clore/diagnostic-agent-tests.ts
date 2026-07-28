import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "scripts", "clore", "diagnostic-agent.py");
const source = readFileSync(file, "utf8");
const digest = createHash("sha256").update(source, "utf8").digest("hex");

assert.match(source, /add_argument\("--port", type=int, default=8080\)/);
assert.match(source, /add_argument\("--project-commit"\)/);
assert.match(source, /add_argument\("--controller-sha256"\)/);
assert.match(source, /add_argument\("--workflow-sha256"\)/);
assert.match(source, /add_argument\("--immutable"/);
assert.match(source, /ThreadingHTTPServer\(\("0\.0\.0\.0", args\.port\)/);
for (const route of ["/healthz", "/status", "/logs", "/stage/environment", "/stage/gpu", "/stage/controller", "/stage/comfyui", "/stage/models", "/stage/inference", "/artifacts/"]) assert.match(source, new RegExp(route.replaceAll("/", "\\/")));
assert.match(source, /Authorization/);
assert.match(source, /hmac\.compare_digest/);
assert.match(source, /stage_parameters_forbidden/);
// The immutable runtime overlay is transported as a bounded raw-deflate
// payload.  Keep the safety contract focused on the fixed decoder and patch
// guards rather than banning the legitimate `base64` module entirely.
assert.match(source, /base64\.b64decode\(encoded_patches\)/);
assert.match(source, /zlib\.decompress\(base64\.b64decode\(encoded_patches\), -15\)/);
assert.match(source, /len\(encoded_patches\) > 24_000/);
assert.match(source, /len\(patches\) > 16/);
assert.match(source, /immutable_source_patch_context_mismatch/);
assert.doesNotMatch(source, /(?:os\.system|subprocess\.run\([^)]*shell\s*=\s*True)/);
assert.match(source, /IMMUTABLE_SOURCE_ROOTS/);
assert.match(source, /cdn\.jsdelivr\.net\/gh\/gouzhuoqunn\/ai-video-platform/);
assert.match(source, /raw\.githubusercontent\.com\/gouzhuoqunn\/ai-video-platform/);
assert.match(source, /def immutable_file_urls\(path: str\)/);
assert.match(source, /def fetch_small_verified\(\s*sources: list\[tuple\[str, str\]\]/);
assert.match(source, /immutable_source_sha256_mismatch/);
assert.match(source, /first_output_lines/);
assert.match(source, /final_output_lines/);
assert.match(source, /len\(error_matches\) < 120/);
assert.match(source, /STATE_LOCK = threading\.Lock\(\)/);
assert.match(source, /STAGE_GATE = threading\.Lock\(\)/);
assert.match(source, /STAGE_GATE\.acquire\(blocking=False\)/);
assert.match(source, /finally:\s+STAGE_GATE\.release\(\)/);
assert.match(source, /def run_stage\(route: str, payload: dict\[str, Any\], stage_run_id: str\)/);
assert.match(source, /stage_run_id_required/);
assert.match(source, /"agent_contract": "stage-acceptance-v2"/);
assert.match(source, /begin\(name, stage_run_id\)/);
assert.match(source, /record\.get\("stage_run_id"\) != stage_run_id/);
assert.match(source, /"current_stage_run_id"/);
assert.doesNotMatch(source, /threading\.RLock/);
assert.doesNotMatch(source, /git", "clone".*PROJECT_URL/);
assert.match(source, /model_url_must_be_https/);
assert.match(source, /verified_existing/);
assert.match(source, /artifact_not_verified/);
execFileSync("py", ["-3", "-m", "py_compile", file], { stdio: "pipe" });
execFileSync("py", ["-3", path.join(process.cwd(), "scripts", "clore", "diagnostic-agent-lock-regression.py")], { stdio: "inherit" });
execFileSync("py", ["-3", path.join(process.cwd(), "scripts", "clore", "diagnostic-agent-restricted-tests.py")], { stdio: "inherit" });
console.log(JSON.stringify({ ok: true, diagnostic_agent_sha256: digest, routes: 12, stage_gate: "separate_lock", arbitrary_command_execution: false }, null, 2));
