import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_TAG } from "./config";
import { assertNoSecretOutput } from "./client";
import { loadCloreConfig } from "./config";
import { loadCloreExecutionConfig } from "./execution-config";
import { cancelCloreOrder } from "./cancel-execution";

const ACTIVE_ORDER_PATH = path.join(process.cwd(), ".secrets", "clore-active-order.json");

function getArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readLocalState() {
  if (!existsSync(ACTIVE_ORDER_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(ACTIVE_ORDER_PATH, "utf8")) as { order_id?: string; project_tag?: string; server_id?: string };
}

async function main() {
  const execute = process.argv.includes("--execute");
  const orderId = getArg("order-id") ?? "dry-run-order";
  const localState = readLocalState();
  const verifiedProjectOrder = Boolean(localState?.order_id && localState.order_id === orderId && localState.project_tag === PROJECT_TAG);

  if (execute) {
    const execution = loadCloreExecutionConfig();
    if (!execution.enabled) {
      throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false. Refusing real cancel_order.");
    }
    const result = await cancelCloreOrder({
      config: loadCloreConfig(),
      execution,
      orderId,
      processingJobs: Number(getArg("processing-jobs") ?? 0),
      uploading: getArg("uploading") === "true",
      finalVideoUploaded: getArg("final-video-uploaded") === "true",
      issue: getArg("issue"),
    });
    const output = JSON.stringify(result, null, 2);
    assertNoSecretOutput(output);
    console.log(output);
    return;
  }

  const output = JSON.stringify(
    {
      banner: "DRY RUN - NO ORDER CANCELED",
      order_id: orderId,
      active_order_state_exists: Boolean(localState),
      verified_project_order: verifiedProjectOrder,
      required_project_tag: PROJECT_TAG,
      warnings_before_future_cancel: [
        "Upload final video before canceling.",
        "Run cleanup-worker on the GPU before canceling.",
        "Local container and model cache may be lost.",
        "Check order status after canceling.",
        "Check wallet balance stops changing after canceling.",
      ],
      deletes_supabase_final_videos: false,
      deletes_user_data: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "clore cancel failed");
  process.exitCode = 1;
});
