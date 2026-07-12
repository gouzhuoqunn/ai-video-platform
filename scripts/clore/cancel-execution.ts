import { cloreRequest, sleep } from "./client";
import type { loadCloreConfig } from "./config";
import { PROJECT_TAG } from "./config";
import { clearActiveOrder, readActiveOrder } from "./order-state";
import type { CloreExecutionConfig } from "./execution-config";

export type CancelOrderRequest = {
  id: string;
  issue?: string;
};

export type LoadedCloreConfig = ReturnType<typeof loadCloreConfig>;

export function assertCancelAllowed(input: {
  execution: CloreExecutionConfig;
  orderId: string;
  processingJobs: number;
  uploading: boolean;
  finalVideoUploaded: boolean;
  issue?: string;
}) {
  if (!input.execution.enabled) {
    throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false.");
  }
  const active = readActiveOrder();
  if (!active || active.order_id !== input.orderId || active.project_tag !== PROJECT_TAG) {
    throw new Error("Order does not belong to the current project active order state.");
  }
  if (input.processingJobs > 0) {
    throw new Error("Refusing to cancel while a job is processing.");
  }
  if (input.uploading) {
    throw new Error("Refusing to cancel while a video upload is in progress.");
  }
  const failureCleanup = /ssh_unavailable|hardware_check_failed|bootstrap_failed|model_download_failed|worker_failed|budget_stop/i.test(input.issue ?? "");
  if (!input.finalVideoUploaded && !failureCleanup) {
    throw new Error("Refusing to cancel before final video upload is verified.");
  }
  return active;
}

export async function cancelCloreOrder(input: {
  config: LoadedCloreConfig;
  execution: CloreExecutionConfig;
  orderId: string;
  processingJobs: number;
  uploading: boolean;
  finalVideoUploaded: boolean;
  issue?: string;
  request?: (body: CancelOrderRequest) => Promise<unknown>;
}) {
  assertCancelAllowed(input);
  const body: CancelOrderRequest = {
    id: input.orderId,
    issue: input.issue ?? "project session complete",
  };
  await sleep(5000);
  const response = input.request
    ? await input.request(body)
    : await cloreRequest<unknown>(input.config, "/cancel_order", {
        method: "POST",
        body: JSON.stringify(body),
      });
  clearActiveOrder(input.orderId);
  return {
    order_canceled: true,
    cancel_order_called: true,
    order_id: input.orderId,
    response_received: Boolean(response),
  };
}
