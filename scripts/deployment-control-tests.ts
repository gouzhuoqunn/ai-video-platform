import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getCloreDeploymentHold } from "./clore/deployment-hold";

const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const readOnly = spawnSync(process.execPath, [tsx, "scripts/clore/deployment-control.ts", "resume"], { cwd: process.cwd(), encoding: "utf8" });
assert.equal(readOnly.status, 0);
const output = JSON.parse(readOnly.stdout);
assert.equal(output.mode, "read_only");
assert.equal(output.holdChanged, false);
assert.equal(output.activeOrderCheck, "not_called_without_exact_flag");
assert.equal(getCloreDeploymentHold().enabled, true);

const pause = spawnSync(process.execPath, [tsx, "scripts/clore/deployment-control.ts", "pause"], { cwd: process.cwd(), encoding: "utf8" });
assert.equal(pause.status, 0);
assert.equal(JSON.parse(pause.stdout).activeSessionCancelled, false);
assert.equal(getCloreDeploymentHold().enabled, true);
console.log("Clore deployment hold, read-only resume, and drain-safe pause tests passed.");
