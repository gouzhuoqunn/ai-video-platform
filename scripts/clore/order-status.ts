import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertCloreApiKey, loadCloreConfig } from "./config";
import { assertNoSecretOutput, cloreRequest } from "./client";
import { writeSanitizedFixture } from "./fixtures";
import { parseCloreOrder } from "./order-readiness-parser";

const ACTIVE_ORDER_PATH = path.join(process.cwd(), ".secrets", "clore-active-order.json");

function summarizeOrders(data: unknown) {
  const record = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const orders = Array.isArray(record.orders) ? record.orders : Array.isArray(data) ? data : [];
  return orders.map((order) => {
    const value = order && typeof order === "object" ? (order as Record<string, unknown>) : {};
    const parsed = parseCloreOrder(value);
    return {
      order_id: value.id ?? value.order_id ?? null,
      server_id: value.server_id ?? value.renting_server ?? value.si ?? null,
      lifecycle_status: parsed.lifecycleStatus,
      deployment_state: parsed.deploymentState,
      price: value.price ?? value.price_usd_per_hour ?? null,
      started_at: value.created_at ?? value.started_at ?? null,
      ssh_summary_available: Boolean(parsed.ssh),
      ssh_host: parsed.ssh?.host ?? null,
      ssh_port: parsed.ssh?.port ?? null,
      ssh_source: parsed.sshSource,
    };
  });
}

async function main() {
  const config = loadCloreConfig();
  const localState = existsSync(ACTIVE_ORDER_PATH) ? JSON.parse(readFileSync(ACTIVE_ORDER_PATH, "utf8")) : null;
  if (!config.apiKey) {
    const output = JSON.stringify(
      {
        mode: "local-state-only",
        active_order_state_exists: Boolean(localState),
        local_state: localState ? { order_id: localState.order_id, project_tag: localState.project_tag, server_id: localState.server_id } : null,
        note: "Missing CLORE_API_KEY, so no live my_orders query was made.",
      },
      null,
      2,
    );
    assertNoSecretOutput(output);
    console.log(output);
    return;
  }

  assertCloreApiKey(config);
  const data = await cloreRequest<unknown>(config, "/my_orders");
  const output = JSON.stringify(
    {
      mode: "live-my-orders-read-only",
      active_order_state_exists: Boolean(localState),
      active_order_summary: localState ? { order_id: localState.order_id, project_tag: localState.project_tag, server_id: localState.server_id } : null,
      orders_summary: summarizeOrders(data),
      hidden_sensitive_fields: ["passwords", "full connection credentials", "api key"],
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  writeSanitizedFixture("latest-orders", JSON.parse(output) as unknown);
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "clore status failed");
  process.exitCode = 1;
});
