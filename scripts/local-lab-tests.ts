import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isLoopbackHost, normalizeHost } from "../src/lib/local-lab/host";
import { LOCAL_LAB_BALANCE, LOCAL_LAB_ROLE, parseEnvContent } from "../src/lib/local-lab/config";
import { videoJobStatusLabels, videoModelLabels } from "../src/types/video-config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  assert(normalizeHost("127.0.0.1:3000") === "127.0.0.1", "Host normalization should remove port.");
  assert(isLoopbackHost("127.0.0.1:3000"), "local_lab should accept 127.0.0.1.");
  assert(isLoopbackHost("localhost:3000"), "local_lab should accept localhost.");
  assert(isLoopbackHost("[::1]:3000"), "local_lab should accept IPv6 loopback.");
  assert(!isLoopbackHost("192.168.1.20:3000"), "local_lab must reject LAN hosts.");

  const studio = read("src/components/LocalCreationStudio.tsx");
  assert(studio.includes("创建未生成任务"), "Local lab must create pending confirmation tasks.");
  assert(studio.includes("全选未生成任务"), "Local lab must support selecting all ungenerated tasks.");
  assert(studio.includes("加急生成"), "Local lab must expose urgent generation.");
  assert(studio.includes("确认生成"), "Local lab must expose confirm generation.");
  assert(studio.includes("重新生成"), "Local lab must expose regeneration.");
  assert(studio.includes("GPU自动租用暂时停用"), "Real Clore auto-rent must be visibly disabled.");
  assert(studio.includes("推进mock寻机tick"), "Mock auto-rent tick must be reachable.");
  assert(studio.includes("onDoubleClick"), "Host cards must use double click for details.");
  assert(studio.includes("candidate.effective_usd_per_hour") && studio.includes("/小时"), "Host cards must primarily show effective hourly price.");
  assert(studio.includes("visual_mock") && studio.includes("?mock=1"), "Visual mock candidates must require an explicit local screenshot flag.");
  assert(!studio.includes("生成时间与任务状态"), "Old right-side generation time/status section must be removed.");

  const studioExperience = read("src/components/StudioExperience.tsx");
  for (const mode of ["missing", "local_lab", "commercial"]) {
    assert(studioExperience.includes("<LocalCreationStudio />"), `StudioExperience must use the confirmed local studio UI when mode is ${mode}.`);
  }
  assert(!studioExperience.includes("CommercialStudioExperience"), "Old commercial neon experience must not be reachable.");
  assert(!studioExperience.includes("NEXT_PUBLIC_APP_MODE"), "App mode must not switch visual themes.");

  const globals = read("src/app/globals.css");
  assert(globals.includes("color-scheme: light"), "Global CSS must not default to the old dark neon shell.");
  assert(!globals.includes("#070708"), "Global CSS must not keep the old near-black neon background.");

  const candidateRoute = read("src/app/api/local-lab/clore/candidates/route.ts");
  assert(candidateRoute.includes('process.env.NODE_ENV !== "production"'), "Mock Clore candidates must be disabled in production.");
  assert(candidateRoute.includes('searchParams.get("mock") === "1"'), "Mock Clore candidates must require an explicit flag.");

  const batchRoute = read("src/app/api/local-lab/jobs/batch/route.ts");
  assert(batchRoute.includes("confirm_video_jobs"), "Batch confirm must use RPC.");
  assert(batchRoute.includes("mark_video_jobs_urgent"), "Batch urgent must use RPC.");
  assert(batchRoute.includes("soft_delete_video_jobs"), "Batch delete must use RPC.");
  assert(batchRoute.includes("regenerate_video_job"), "Batch regeneration must use RPC.");
  assert(batchRoute.includes("create_gpu_autorent_request"), "Confirm and urgent actions must create auto-rent requests.");
  assert(batchRoute.includes("create_order_called: false"), "Batch route must not call real create_order.");

  const routeGuard = read("src/lib/local-lab/route-guard.ts");
  assert(routeGuard.includes("isLocalLabServerEnabled"), "Local lab API guard must check LOCAL_LAB_ENABLED.");
  assert(routeGuard.includes("isLoopbackHost"), "Local lab API guard must enforce loopback hosts.");
  assert(routeGuard.includes("Same-origin check failed"), "Local lab POST routes must include same-origin protection.");

  const envExample = read(".env.example");
  assert(envExample.includes("CLORE_ORDER_EXECUTION_ENABLED=\"false\""), ".env.example must default web Clore execution to false.");
  assert(!envExample.includes("NEXT_PUBLIC_CLORE_API_KEY"), ".env.example must not expose a public Clore API key.");

  assert(videoJobStatusLabels.pending_confirmation === "未生成", "pending_confirmation must display as 未生成.");
  assert(videoModelLabels["standard-video"] === "Wan2.2 TI2V-5B", "standard-video must map to Wan2.2 in UI labels.");
  assert(parseEnvContent('LOCAL_LAB_EMAIL="a@example.test"').get("LOCAL_LAB_EMAIL") === "a@example.test", "local lab env parser should parse quoted values.");
  assert(LOCAL_LAB_ROLE === "local_tester", "local lab role constant must be local_tester.");
  assert(LOCAL_LAB_BALANCE === 1_000_000_000, "local lab balance must be a large finite integer.");
  assert(!existsSync(path.join(process.cwd(), ".secrets", "clore-active-order.json")), "Local lab tests must not create Clore order state.");

  console.log("Local lab tests passed.");
}

void main();
