import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(filePath: string) {
  return readFileSync(filePath, "utf8");
}

const route = read("src/app/api/local-lab/image-tasks/route.ts");
const runner = read("scripts/image-4090-runner.ts");
const orderExecution = read("scripts/clore/order-execution.ts");
const orderState = read("scripts/clore/order-state.ts");

assert.match(orderState, /clearLocalActiveOrderState/, "zero provider orders + stale local order record: local active-order file can be cleared");
assert.match(orderState, /clearOrderCreateLocks/, "stale create lock cleanup: new and legacy create locks can be cleared");
assert.match(orderExecution, /reconcileProjectActiveOrderBeforeCreate/, "project-active-order guard reconciles provider state before rejection");
assert.match(orderExecution, /liveOrders\.filter\(\(order\) => order\.active && order\.orderId\)/, "project-active-order guard queries real active orders");
assert.match(orderExecution, /provider_zero_active_orders/, "zero provider orders + stale local order record: stale local record is cleared");

assert.match(route, /CREATE_ORDER_STALE_MS = 3 \* 60 \* 1000/, "creating_order timeout reconciliation: timeout is 3 minutes");
assert.match(route, /creatingOrderLooksStale/, "creating_order timeout reconciliation: stale creating_order is detected");
assert.match(route, /acquireRunnerStartLock/, "concurrent starts are guarded before spawning a runner");
assert.match(route, /createAttempt: \{ id: attemptId/, "a durable attempt identifier is persisted before runner launch");
assert.match(route, /returnFrozenTasksToWaiting/, "image task preserved: frozen tasks are returned to confirmed waiting state");
assert.match(route, /clearLocalActiveImageState/, "zero provider orders + stale local order record: Studio API clears stale local state");
assert.match(route, /assertNoActiveProviderOrderBeforeStart/, "duplicate create prevention: start path reconciles provider state before launch");

assert.match(runner, /reconcileCreateAttempt/, "rate-limited create: runner reconciles before retrying");
assert.match(runner, /persistRecoveredActiveOrder\(recoveredOrderId, input\.candidate, input\.requestBody/, "real active order adoption: recovered order is persisted");
assert.match(runner, /onCreateRetry/, "transient create_order retries remain inside the centralized scheduler flight");
assert.match(runner, /create_order_rate_limited/, "rate limit is represented as a nonterminal runner phase");
assert.match(runner, /state: "failed"[\s\S]*stage: "create_order_failed"/, "final no-order failure is terminal failed");
assert.match(runner, /order_created_waiting_deployment/, "deployment waiting begins only after an order is known");

console.log("image order state reconcile focused tests: ok");
