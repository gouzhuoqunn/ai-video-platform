import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CloreLongVideoProviderAdapter } from "../src/lib/long-video/clore-adapter";
import { LongVideoExecutionCoordinator, type LongVideoExecutionAuthorization } from "../src/lib/long-video/execution";

function arg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function usage(): never {
  console.error("用法：npm run long-video:execute -- --project-id=<id> --plan 或 --execute --authorization=<id>");
  process.exit(2);
}

function consumeAuthorizationFile(filePath: string, authorization: LongVideoExecutionAuthorization) {
  const consumed = { ...authorization, consumedAt: new Date().toISOString() };
  const temporary = `${filePath}.${process.pid}.part`;
  writeFileSync(temporary, `${JSON.stringify(consumed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

async function main() {
  const projectId = arg("project-id");
  if (!projectId) usage();
  const planMode = process.argv.includes("--plan");
  const executeMode = process.argv.includes("--execute");
  const providerName = arg("provider") ?? "clore";
  if (providerName !== "clore") throw new Error("long_video_provider_must_be_clore");
  if (planMode === executeMode) usage();
  const provider = new CloreLongVideoProviderAdapter();
  const coordinator = new LongVideoExecutionCoordinator({ provider, policy: executeMode ? { maxSpendUsd: 1.2, maxSegmentsPerSession: 3, maxConsecutiveSegments: 3 } : undefined });
  if (planMode) {
    console.log(JSON.stringify({ ...(await coordinator.plan(projectId)), real_clore_adapter_ready: true }, null, 2));
    return;
  }
  const authorizationId = arg("authorization");
  if (!authorizationId) usage();
  const filePath = path.join(process.cwd(), ".secrets", "long-video-authorizations", `${authorizationId}.json`);
  if (!existsSync(filePath)) throw new Error("long_video_authorization_missing");
  const authorization = JSON.parse(readFileSync(filePath, "utf8")) as LongVideoExecutionAuthorization;
  if (authorization.id !== authorizationId || authorization.projectId !== projectId) throw new Error("long_video_authorization_project_mismatch");
  const preflight = await coordinator.plan(projectId);
  if (!preflight.real_project_plan_ready) throw new Error(`long_video_plan_blocked:${preflight.blockers.join(",")}`);
  process.env.CLORE_ORDER_EXECUTION_ENABLED = "true";
  consumeAuthorizationFile(filePath, authorization);
  const result = await coordinator.execute(projectId, { ...authorization, consumedAt: null });
  console.log(JSON.stringify({ ...result, merge: "MERGE_CONFIRMATION_REQUIRED" }, null, 2));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "long_video_execute_failed"); process.exitCode = 1; });
