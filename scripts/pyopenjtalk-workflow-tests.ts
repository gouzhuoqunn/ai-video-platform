import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("config/gpt-sovits-runtime-manifest.json", "utf8")) as {
  python: string;
  device: string;
  pyopenjtalk?: { version: string; officialSourceSha256: string; wheelStatus: string; workflow: string };
};
const workflowPath = ".github/workflows/build-pyopenjtalk-windows-wheel.yml";
const workflow = readFileSync(workflowPath, "utf8");

assert.equal(manifest.python, "3.10.11");
assert.equal(manifest.device, "cpu");
assert.deepEqual(manifest.pyopenjtalk, {
  version: "0.4.1",
  officialSourceFilename: "pyopenjtalk-0.4.1.tar.gz",
  officialSourceSha256: "d5ada46f7fc2b52c1c79c273eb9668ff6ad7ab276a8db9d8be119ef93440f0dc",
  wheelStatus: "blocked_pyopenjtalk_artifact_download",
  workflow: workflowPath,
});
assert.match(workflow, /runs-on: windows-2022/);
assert.match(workflow, /python-version: "3\.10"/);
assert.match(workflow, /architecture: "x64"/);
assert.match(workflow, /timeout-minutes: 30/);
assert.match(workflow, /pyopenjtalk==0\.4\.1/);
assert.match(workflow, /d5ada46f7fc2b52c1c79c273eb9668ff6ad7ab276a8db9d8be119ef93440f0dc/);
assert.match(workflow, /pip wheel --no-deps --no-build-isolation/);
assert.match(workflow, /pyopenjtalk\.g2p\('こんにちは'\)/);
assert.match(workflow, /actions\/upload-artifact@v4/);
assert.doesNotMatch(workflow, /GPT-SoVITS.*(?:pth|ckpt)|\.secrets|CLORE_API_KEY|SUPABASE_SERVICE_ROLE_KEY/);

console.log(JSON.stringify({ ok: true, source: "official_pypi_sdist", wheel: "cp310-win-amd64", status: manifest.pyopenjtalk.wheelStatus }));
