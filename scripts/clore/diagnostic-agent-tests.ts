import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "scripts", "clore", "diagnostic-agent.py");
const source = readFileSync(file, "utf8");
const digest = createHash("sha256").update(source, "utf8").digest("hex");

assert.equal(digest, "a0e0a43c3a6411e7bd4620206e8789b72efe262f3c69041127fe6e2af29d8d34");
assert.match(source, /ThreadingHTTPServer\(\("0\.0\.0\.0", 8080\)/);
for (const route of ["/healthz", "/status", "/logs", "/stage/environment", "/stage/gpu", "/stage/controller", "/stage/comfyui"]) assert.match(source, new RegExp(route.replaceAll("/", "\\/")));
assert.match(source, /Authorization/);
assert.match(source, /hmac\.compare_digest/);
assert.match(source, /stage_parameters_forbidden/);
assert.doesNotMatch(source, /base64/);
execFileSync("python", ["-m", "py_compile", file], { stdio: "pipe" });
console.log(JSON.stringify({ ok: true, diagnostic_agent_sha256: digest, routes: 7, arbitrary_command_execution: false }, null, 2));
