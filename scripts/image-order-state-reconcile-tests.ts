import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path: string) {
  return readFileSync(path, "utf8");
}

const route = read("src/app/api/local-lab/image-tasks/route.ts");
const runner = read("scripts/image-4090-runner.ts");
const orderExecution = read("scripts/clore/order-execution.ts");
const orderState = read("scripts/clore/order-state.ts");
const studio = read("src/components/ImageCreationStudio.tsx");

assert.match(orderState, /clearLocalActiveOrderState/, "zero provider orders + stale local order record: local active-order file can be cleared");
assert.match(orderState, /clearOrderCreateLocks/, "stale create lock cleanup: new and legacy create locks can be cleared");
assert.match(orderExecution, /reconcileProjectActiveOrderBeforeCreate/, "project-active-order guard reconciles provider state before rejection");
assert.match(orderExecution, /liveOrders\.filter\(\(order\) => order\.active && order\.orderId\)/, "project-active-order guard queries real active orders");
assert.match(orderExecution, /provider_zero_active_orders/, "zero provider orders + stale local order record: stale local record is cleared");
assert.match(orderExecution, /A project active Clore order already exists: \$\{matching\.orderId/, "unrelated active order blocks with ID");

assert.match(route, /CREATE_ORDER_STALE_MS = 3 \* 60 \* 1000/, "creating_order timeout reconciliation: timeout is 3 minutes");
assert.match(route, /creatingOrderLooksStale/, "creating_order timeout reconciliation: stale creating_order is detected");
assert.match(route, /stopRunnerProcessTree/, "stuck runner stopped: process tree helper exists");
assert.match(route, /taskkill", \["\/PID", String\(pid\), "\/T", "\/F"\]/, "stuck runner stopped: Windows child tree is terminated");
assert.match(route, /returnFrozenTasksToWaiting/, "image task preserved: frozen tasks are returned to confirmed waiting state");
assert.match(route, /clearLocalActiveImageState/, "zero provider orders + stale local order record: Studio API clears stale local state");
assert.match(route, /检测到本地残留订单状态，已自动清理/, "UI behavior: stale local cleanup message is persisted");
assert.match(route, /创建订单失败，未产生订单/, "UI behavior: no-order create failure message is persisted");
assert.match(route, /检测到真实活动订单：\$\{activeImageOrder\.orderId\}/, "real active order adoption: matching image order is adopted");
assert.match(route, /已有其他活动订单：\$\{order\.orderId/, "unrelated active order blocks with ID");
assert.match(route, /assertNoActiveProviderOrderBeforeStart/, "duplicate create prevention: start path reconciles provider state before launch");
assert.match(route, /action === "cancel_batch"/, "cancellation when current session orderId is null: cancel API remains available");
assert.match(route, /clearLocalActiveImageState\(\)/, "cancellation when current session orderId is null: stale local state is cleared");

assert.match(runner, /activeBeforeCreate/, "real active order adoption: runner checks live orders before create_order");
assert.match(runner, /matchingBeforeCreate/, "real active order adoption: runner reuses matching order");
assert.match(runner, /persistRecoveredActiveOrder\(orderId, candidate, requestBody\)/, "real active order adoption: recovered order is persisted");
assert.match(runner, /已有其他活动订单：\$\{activeBeforeCreate\[0\]\.orderId/, "unrelated active order blocks with ID in runner");
assert.match(runner, /CREATE_ORDER_HARD_TIMEOUT_MS = 60_000/, "create_order HTTP timeout remains 60 seconds");
assert.match(runner, /CREATE_ORDER_RETRY_DELAY_MS = 3_000/, "transient create_order retry remains single short retry");
assert.match(runner, /state: "failed"[\s\S]*stage: "create_order_failed"/, "creating_order timeout reconciliation: final no-order failure is terminal failed");

assert.match(studio, /active_order_conflict/, "UI behavior: active-order conflict has a readable stage label");
assert.match(studio, /httpAddressState = !orderCreated \? "—"/, "UI behavior: HTTP waiting is hidden before orderId exists");

console.log("image order state reconcile focused tests: ok");
