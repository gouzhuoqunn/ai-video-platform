import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readGpuBillingStatus } from "./gpu-billing-status";
import { LongVideoExecutionCoordinator, type LongVideoExecutionAuthorization, type LongVideoProvider } from "../src/lib/long-video/execution";

function arg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function usage(): never {
  console.error("用法：npm run long-video:execute -- --project-id=<id> --plan 或 --execute --authorization=<id>");
  process.exit(2);
}

function readOnlyProvider(): LongVideoProvider {
  const unsupported = async () => { throw new Error("long_video_real_provider_adapter_requires_explicit_paid_runner"); };
  return {
    async listCandidates() { return []; },
    async activeOrderCount() { try { return (await readGpuBillingStatus()).clore.activeOrders; } catch { return 0; } },
    createSession: unsupported,
    waitForSsh: unsupported,
    prepareWorkspace: unsupported,
    bootstrapRuntime: unsupported,
    runCanary: unsupported,
    restoreWan: unsupported,
    generateSegment: unsupported,
    awaitReview: unsupported,
    cancelSession: unsupported,
  } as unknown as LongVideoProvider;
}

async function main() {
  const projectId = arg("project-id");
  if (!projectId) usage();
  const planMode = process.argv.includes("--plan");
  const executeMode = process.argv.includes("--execute");
  if (planMode === executeMode) usage();
  const coordinator = new LongVideoExecutionCoordinator({ provider: readOnlyProvider() });
  if (planMode) {
    console.log(JSON.stringify(await coordinator.plan(projectId), null, 2));
    return;
  }
  const authorizationId = arg("authorization");
  if (!authorizationId) usage();
  const filePath = path.join(process.cwd(), ".secrets", "long-video-authorizations", `${authorizationId}.json`);
  if (!existsSync(filePath)) throw new Error("long_video_authorization_missing");
  const authorization = JSON.parse(readFileSync(filePath, "utf8")) as LongVideoExecutionAuthorization;
  if (authorization.id !== authorizationId || authorization.projectId !== projectId) throw new Error("long_video_authorization_project_mismatch");
  throw new Error("long_video_real_provider_adapter_requires_explicit_paid_runner");
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "long_video_execute_failed"); process.exitCode = 1; });
