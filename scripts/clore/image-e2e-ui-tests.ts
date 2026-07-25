import assert from "node:assert/strict";
import { ensureLocalUi } from "./image-e2e-ui";
async function main() { let killed = false; const fake: any = () => ({ pid: 123, killed: false, stdout: { on: () => undefined }, stderr: { on: () => undefined }, kill() { killed = true; this.killed = true; } }); const original = global.fetch; let checks = 0; global.fetch = (async () => ({ ok: ++checks > 1 })) as any; const handle = await ensureLocalUi({ baseUrl: "http://127.0.0.1:9", spawnImpl: fake, timeoutMs: 50 }); assert.equal(handle.started, true); handle.stop(); assert.equal(killed, true); global.fetch = original; console.log(JSON.stringify({ ok: true, ui_start_bounded: true, coordinator_child_only: true })); }
void main();
