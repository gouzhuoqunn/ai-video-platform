import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "scripts", "clore", "diagnostic-agent.py");
const source = readFileSync(file, "utf8");
const digest = createHash("sha256").update(source, "utf8").digest("hex");

assert.match(source, /add_argument\("--port", type=int, default=8080\)/);
assert.match(source, /ThreadingHTTPServer\(\("0\.0\.0\.0", args\.port\)/);
for (const route of ["/healthz", "/status", "/logs", "/stage/environment", "/stage/gpu", "/stage/controller", "/stage/comfyui"]) assert.match(source, new RegExp(route.replaceAll("/", "\\/")));
assert.match(source, /Authorization/);
assert.match(source, /hmac\.compare_digest/);
assert.match(source, /stage_parameters_forbidden/);
assert.doesNotMatch(source, /base64/);
assert.match(source, /PROJECT_URL/);
assert.match(source, /STATE_LOCK = threading\.Lock\(\)/);
assert.match(source, /STAGE_GATE = threading\.Lock\(\)/);
assert.match(source, /STAGE_GATE\.acquire\(blocking=False\)/);
assert.match(source, /finally: STAGE_GATE\.release\(\)/);
assert.doesNotMatch(source, /threading\.RLock/);
execFileSync("py", ["-3", "-m", "py_compile", file], { stdio: "pipe" });
execFileSync("py", ["-3", path.join(process.cwd(), "scripts", "clore", "diagnostic-agent-lock-regression.py")], { stdio: "inherit" });
console.log(JSON.stringify({ ok: true, diagnostic_agent_sha256: digest, routes: 7, stage_gate: "separate_lock", arbitrary_command_execution: false }, null, 2));
