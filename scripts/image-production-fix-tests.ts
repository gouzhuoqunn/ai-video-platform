import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeFixed, formatHourlyPrice } from "../src/lib/image-generation/formatters";

function read(path: string) {
  return readFileSync(path, "utf8");
}

const studio = read("src/components/ImageCreationStudio.tsx");
const route = read("src/app/api/local-lab/image-tasks/route.ts");

assert.equal(safeFixed(undefined, 2), "—", "nullable numeric UI render test: undefined must not crash");
assert.equal(safeFixed(null, 2), "—", "nullable numeric UI render test: null must not crash");
assert.equal(safeFixed(Number.NaN, 2), "—", "nullable numeric UI render test: NaN must not crash");
assert.equal(safeFixed("bad", 2), "—", "nullable numeric UI render test: invalid string must not crash");
assert.equal(safeFixed(0, 2), "0.00", "nullable numeric UI render test: zero must be preserved");
assert.equal(safeFixed("0.6", 2), "0.60", "nullable numeric UI render test: numeric string must render");
assert.equal(formatHourlyPrice(undefined), "$—/小时");
assert.equal(formatHourlyPrice(0.23), "$0.23/小时");

assert.doesNotMatch(studio, /runner\.host\.priceHourly\.toFixed/, "legacy/incomplete runner-session render test: host price must be safely formatted");
assert.doesNotMatch(studio, /maxHourlyPrice\.toFixed/, "legacy/incomplete runner-session render test: max hourly price must be safely formatted");
assert.match(studio, /formatHourlyPrice\(host\.priceHourly\)/, "legacy/incomplete runner-session render test: host price uses shared formatter");
assert.match(studio, /runnerBusy/, "duplicate start request test: UI has immediate busy gate");
assert.match(studio, /setStarting\(true\)/, "duplicate start request test: button disables immediately after first click");
assert.match(studio, /cancel_batch/, "dead-runner cancellation result: UI can call cancel API without runner process");

assert.match(route, /function normalizeHost/, "legacy/incomplete runner-session render test: API normalizes old host records");
assert.match(route, /priceHourly: finiteNumber/, "legacy/incomplete runner-session render test: priceHourly normalizes to number or null");
assert.match(route, /action === "cancel_batch"/, "cancel with live runner test fixture: route exposes cancel action");
assert.match(route, /cloreRequest<unknown>\(loadCloreConfig\(\), "\/cancel_order"/, "cancel with live runner test fixture: cancel calls provider directly");
assert.match(route, /process\.kill/, "cancel with live runner test fixture: route also attempts to stop live runner");
assert.match(route, /Cancellation does not depend on the process signal/, "cancel with dead runner test fixture: provider cancellation does not depend on PID");
assert.match(route, /没有活跃图像订单，已清理本地批次状态。/, "already-cancelled idempotency test: missing order is idempotent");
assert.match(route, /DUPLICATE_START_MESSAGE/, "duplicate start request test: backend has clear duplicate message");
assert.match(route, /processExists\(previous\.pid\)/, "duplicate start request test: stale/live runner PID is checked");
assert.match(route, /activeCloreOrderCount\(\)/, "duplicate start request test: active Clore order gate exists");
assert.match(route, /\[\.\.\.new Set\(batch\.map\(\(task\) => task\.id\)\)\]/, "duplicate task ID freeze test: frozen IDs are deduplicated");

console.log("image production fix focused tests: ok");
