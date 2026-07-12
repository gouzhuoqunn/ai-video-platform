import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isLoopbackHost, normalizeHost } from "../src/lib/local-lab/host";
import { LOCAL_LAB_BALANCE, LOCAL_LAB_ROLE, parseEnvContent } from "../src/lib/local-lab/config";
import { videoModelLabels } from "../src/types/video-config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
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

  const proxy = read("proxy.ts");
  assert(proxy.includes("LOCAL_LAB_ENABLED") || proxy.includes("isLocalLabServerEnabled"), "Proxy must enforce local_lab mode.");
  assert(proxy.includes("status: 403"), "Non-loopback local_lab requests must return 403.");

  const route = read("src/app/api/local-lab/session/route.ts");
  assert(route.includes("status: 404"), "Local lab session route must be hidden when disabled.");
  assert(route.includes("status: 403"), "Local lab session route must reject remote hosts.");
  assert(route.includes("signInWithPassword"), "Auto login must use normal Supabase password login.");
  assert(!route.includes("LOCAL_LAB_PASSWORD") && !route.includes("localStorage"), "Auto login route must not expose password or localStorage.");

  const studio = read("src/components/StudioExperience.tsx");
  const localStudio = read("src/components/LocalCreationStudio.tsx");
  assert(studio.includes("LocalCreationStudio"), "Local lab mode must use the dedicated local creation studio.");
  assert(localStudio.includes("积分 ∞"), "Local lab UI must show infinite credits.");
  assert(localStudio.includes("Wan2.2 TI2V-5B"), "Local lab UI must show Wan2.2.");
  assert(localStudio.includes("加入生成队列"), "Local lab submit button must queue prompts instead of promising immediate generation.");
  assert(localStudio.includes("GPU 未启动时会保持 queued"), "Local lab UI must explain queued tasks before GPU starts.");
  assert(localStudio.includes("启动GPU会话"), "Local lab UI must expose one-click GPU session start.");
  assert(!localStudio.includes("输入：{plan.required_confirmation_text}"), "Local lab UI must not require manual professional confirmation text.");
  assert(localStudio.includes("/api/local-lab/clore/candidates"), "Local lab UI must call the protected Clore candidates API.");
  assert(localStudio.includes("/api/local-lab/results"), "Local lab UI must call the protected local results API.");
  assert(localStudio.includes("aria-label=\"删除该记录\""), "Local lab history cards must expose a trash delete button.");
  assert(localStudio.includes("主机排序"), "Local lab host panel must expose host sorting.");

  const routeGuard = read("src/lib/local-lab/route-guard.ts");
  assert(routeGuard.includes("isLocalLabServerEnabled"), "Local lab API guard must check LOCAL_LAB_ENABLED.");
  assert(routeGuard.includes("isLoopbackHost"), "Local lab API guard must enforce loopback hosts.");
  assert(routeGuard.includes("Same-origin check failed"), "Local lab POST routes must include same-origin protection.");

  const cloreConsole = read("src/lib/local-lab/clore-console.ts");
  assert(cloreConsole.includes("CLORE_ORDER_EXECUTION_ENABLED"), "Web order confirm must be blocked by a server-only execution flag.");
  assert(cloreConsole.includes("createCloreOrder"), "Web order flow must enter the guarded create helper when the server flag is enabled.");
  assert(cloreConsole.includes("hashNonce"), "Order plans must store hashed one-time nonces.");
  assert(!cloreConsole.includes("Confirmation text does not match."), "Order confirmation must not require manual confirmation text.");

  const candidatesRoute = read("src/app/api/local-lab/clore/candidates/route.ts");
  const orderConfirmRoute = read("src/app/api/local-lab/clore/order-confirm/route.ts");
  const jobsRoute = read("src/app/api/local-lab/jobs/route.ts");
  const deleteJobRoute = read("src/app/api/local-lab/jobs/[jobId]/route.ts");
  assert(candidatesRoute.includes("guardLocalLabRequest"), "Candidates route must use local lab guard.");
  assert(orderConfirmRoute.includes("guardLocalLabMutation"), "Order confirmation route must use mutation guard.");
  assert(jobsRoute.includes("guardLocalLabRequest"), "Jobs route must use local lab guard.");
  assert(deleteJobRoute.includes("guardLocalLabMutation"), "History delete route must use local lab mutation guard.");

  const envExample = read(".env.example");
  assert(envExample.includes("NEXT_PUBLIC_APP_MODE="), ".env.example must include NEXT_PUBLIC_APP_MODE.");
  assert(envExample.includes("LOCAL_LAB_ENABLED="), ".env.example must include LOCAL_LAB_ENABLED.");
  assert(envExample.includes("CLORE_ORDER_EXECUTION_ENABLED=\"false\""), ".env.example must default web Clore execution to false.");
  assert(!envExample.includes("NEXT_PUBLIC_CLORE_API_KEY"), ".env.example must not expose a public Clore API key.");

  const gitignore = read(".gitignore");
  assert(gitignore.includes(".secrets/local-lab.env"), ".secrets/local-lab.env must be ignored.");

  const setup = read("scripts/setup-local-lab-user.ts");
  assert(setup.includes(`app_metadata: { role: LOCAL_LAB_ROLE }`), "local_tester role must be written to app_metadata.");
  assert(setup.includes("user_metadata: { role: LOCAL_LAB_ROLE }"), "ordinary user forge test should use user_metadata.");
  assert(setup.includes("Password was written locally and not printed"), "setup must avoid printing full password.");
  assert(LOCAL_LAB_ROLE === "local_tester", "local lab role constant must be local_tester.");
  assert(LOCAL_LAB_BALANCE === 1_000_000_000, "local lab balance must be a large finite integer.");

  const reset = read("scripts/reset-local-lab.ts");
  assert(reset.includes("Dry-run only"), "reset must default to dry-run.");
  assert(reset.includes("--execute"), "reset must require --execute.");
  assert(reset.includes("app_metadata?.role === LOCAL_LAB_ROLE"), "reset must verify local_tester role.");

  const packageJson = read("package.json");
  assert(packageJson.includes("dev:local"), "package must include dev:local.");
  assert(packageJson.includes("--hostname 127.0.0.1"), "local dev/start must bind 127.0.0.1.");
  assert(packageJson.includes("local-lab:test"), "package must include local-lab:test.");
  assert(packageJson.includes("check:local-lab"), "package must include check:local-lab.");
  assert(!packageJson.includes("vast:"), "Vast npm entrypoints must not reappear.");

  assert(videoModelLabels["standard-video"] === "Wan2.2 TI2V-5B", "standard-video must map to Wan2.2 in UI labels.");
  assert(parseEnvContent('LOCAL_LAB_EMAIL="a@example.test"').get("LOCAL_LAB_EMAIL") === "a@example.test", "local lab env parser should parse quoted values.");
  assert(!existsSync(path.join(process.cwd(), ".secrets", "clore-active-order.json")), "Local lab tests must not create Clore order state.");
  console.log("Local lab测试通过。");
}

void main();
