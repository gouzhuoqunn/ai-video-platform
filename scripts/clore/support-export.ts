import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCloreDeploymentHold } from "./deployment-hold";
import { readActiveOrder } from "./order-state";

type IncidentOrder = {
  order_id: string;
  server_id: string | null;
  image_digest: string | null;
  created_at: string | null;
  cancelled_at: string | null;
  final_status: string;
  entered_running: boolean;
  ssh_published: boolean;
  spend_usd: number | null;
  evidence_note: string;
};

const legacyDigest = "sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a";
const fixedRuntimeDigest = "sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137";
const lightBootstrapDigest = "sha256:0586bbd2c26a8bcfd194d9d022ce4966ede23b3a743471032069c1f2ed2abc27";
const unknownTime = "原始精确时间未保留；未进行推测";

export const failedCloreOrders: IncidentOrder[] = [
  { order_id: "1947533", server_id: null, image_digest: legacyDigest, created_at: null, cancelled_at: null, final_status: "cancelled:ssh_unavailable", entered_running: true, ssh_published: true, spend_usd: 0.34, evidence_note: `SSH 映射端口出现但持续重置/超时；${unknownTime}` },
  { order_id: "1949701", server_id: "107713", image_digest: legacyDigest, created_at: "2026-07-13T09:27:31.000Z", cancelled_at: null, final_status: "expired:runtime_startup_failure_audit", entered_running: false, ssh_published: false, spend_usd: 0.11456018518518514, evidence_note: `创建时间来自脱敏 ct；${unknownTime}` },
  { order_id: "1949948", server_id: null, image_digest: legacyDigest, created_at: null, cancelled_at: null, final_status: "expired:runtime_startup_failure_audit", entered_running: false, ssh_published: false, spend_usd: null, evidence_note: unknownTime },
  { order_id: "1950673", server_id: "79445", image_digest: null, created_at: null, cancelled_at: null, final_status: "historical_official_image_comparison_failed", entered_running: false, ssh_published: false, spend_usd: null, evidence_note: unknownTime },
  { order_id: "1954329", server_id: "91005", image_digest: "sha256:4e3dd6d2610c33ab2b260e970e4a9288043dc2c762cb1b8902b6712cfdfaa96c", created_at: null, cancelled_at: null, final_status: "cancelled:ssh_unavailable", entered_running: false, ssh_published: false, spend_usd: 0.25, evidence_note: `12 分钟内未发布 SSH；${unknownTime}` },
  { order_id: "1954464", server_id: "105176", image_digest: fixedRuntimeDigest, created_at: null, cancelled_at: null, final_status: "cancelled:order_never_running", entered_running: false, ssh_published: false, spend_usd: 0.18, evidence_note: `12 分钟内未运行；${unknownTime}` },
  { order_id: "1954484", server_id: "105173", image_digest: fixedRuntimeDigest, created_at: null, cancelled_at: null, final_status: "cancelled:order_never_running", entered_running: false, ssh_published: false, spend_usd: 0.18, evidence_note: `12 分钟内未运行；${unknownTime}` },
  { order_id: "1954507", server_id: "104878", image_digest: fixedRuntimeDigest, created_at: null, cancelled_at: null, final_status: "cancelled:order_never_running", entered_running: false, ssh_published: false, spend_usd: 0.19, evidence_note: `12 分钟内未运行；${unknownTime}` },
  { order_id: "1955984", server_id: "105175", image_digest: lightBootstrapDigest, created_at: "2026-07-15T19:59:54.438Z", cancelled_at: "2026-07-15T20:10:26.865Z", final_status: "cancelled:order_never_running", entered_running: false, ssh_published: false, spend_usd: 0.17, evidence_note: "611 秒内未运行" },
  { order_id: "1956022", server_id: "105181", image_digest: lightBootstrapDigest, created_at: "2026-07-15T20:12:54.669Z", cancelled_at: "2026-07-15T20:23:22.831Z", final_status: "cancelled:order_never_running", entered_running: false, ssh_published: false, spend_usd: 0.17, evidence_note: "606 秒内未运行" },
  { order_id: "1956054", server_id: "29169", image_digest: lightBootstrapDigest, created_at: "2026-07-15T20:25:24.600Z", cancelled_at: "2026-07-15T20:35:51.999Z", final_status: "cancelled:order_never_running", entered_running: false, ssh_published: false, spend_usd: 0.14, evidence_note: "606 秒内未运行" },
  { order_id: "1957188", server_id: "101767", image_digest: lightBootstrapDigest, created_at: "2026-07-16T05:29:01.000Z", cancelled_at: "2026-07-16T05:43:37.000Z", final_status: "cancelled:order_not_deployed", entered_running: false, ssh_published: false, spend_usd: 0.15, evidence_note: "Stage 3P 自动订单未发布 SSH；API 关闭记录 spend 为 0.04432175925925927，钱包总差额含 0.10 创建费为 0.15 USD" },
  { order_id: "1957995", server_id: "33459", image_digest: lightBootstrapDigest, created_at: "2026-07-16T11:32:16.000Z", cancelled_at: "2026-07-16T11:39:52.000Z", final_status: "cancelled:local_windows_askpass_launcher_failed", entered_running: true, ssh_published: true, spend_usd: 0.12306666666666667, evidence_note: "API deployed and published n1.de.clorecloud.net:1963; TCP and the corrected Node askpass password probe succeeded before cancellation" },
  { order_id: "1958009", server_id: "105169", image_digest: lightBootstrapDigest, created_at: "2026-07-16T11:45:18.000Z", cancelled_at: "2026-07-16T11:46:15.000Z", final_status: "cancelled:runtime_workspace_precondition_failed", entered_running: true, ssh_published: true, spend_usd: 0.10756979166666667, evidence_note: "API endpoint became ready in 35 seconds; password auth, key install, and key auth all succeeded; hardware audit failed because /workspace was absent before mkdir fix" },
];

export const manualGoldenControlOrders = [{
  order_id: "1957892",
  server_id: "28726",
  image: "cloreai/jupyter:ubuntu24.04-v2",
  ui_status: ["Active", "Deployed"],
  endpoint_published: true,
  password_ssh: true,
  ssh_host: "n1.msk.cloreai.ru",
  ssh_port: 1584,
  hardware: { gpu: "RTX 4070 SUPER", vram_mib: 12282, driver: "550.90.07", cuda: "12.4", ram_gib_approx: 15, disk_gib_approx: 79, python: "3.12.3", docker_available: false },
  closed: true,
  spend_usd: 0.02130763888888889,
  password_stored: false,
}] as const;

export const knownVerifiedCloreHosts = [
  { server_id: "29167", deployment_verified: true, ssh_verified: true, inference_verified: false },
  { server_id: "105178", deployment_verified: true, ssh_verified: true, inference_verified: false },
] as const;

export function buildCloreDeploymentIncident() {
  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    deployment_hold: getCloreDeploymentHold(),
    orders: failedCloreOrders,
    known_verified_hosts: knownVerifiedCloreHosts,
    control_orders: manualGoldenControlOrders,
    control_classification: { manual_web_deployment_verified: true, clore_platform_globally_down: false, automatic_readiness_or_payload_bug_suspected: true, automatic_payload_and_endpoint_parser_fixed: true, automatic_password_and_key_ssh_verified: true },
    final_active_order: readActiveOrder() === null ? 0 : 1,
    known_total_spend_usd: Number(failedCloreOrders.reduce((total, order) => total + (order.spend_usd ?? 0), 0).toFixed(6)),
    redaction: { api_key_included: false, full_ssh_public_key_included: false, authorization_header_included: false, password_included: false, raw_payload_included: false },
  };
}

export function exportCloreDeploymentIncident(root = process.cwd()) {
  const incident = buildCloreDeploymentIncident();
  const dir = path.join(root, "artifacts", "clore-support");
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, "clore-deployment-incident.json");
  const mdPath = path.join(dir, "clore-deployment-incident.md");
  const instructionsPath = path.join(dir, "README-发送给Clore支持.md");
  writeFileSync(jsonPath, `${JSON.stringify(incident, null, 2)}\n`, "utf8");
  const rows = incident.orders.map((order) => `| ${order.order_id} | ${order.server_id ?? "未保留"} | ${order.created_at ?? "未保留"} | ${order.cancelled_at ?? "未保留"} | ${order.entered_running ? "是" : "否"} | ${order.ssh_published ? "是" : "否"} | ${order.spend_usd ?? "未保留"} | ${order.final_status} |`).join("\n");
  writeFileSync(mdPath, `# Clore 部署失败证据\n\n生成时间：${incident.generated_at}\n\n| 订单 | 服务器 | 创建时间 | 取消时间 | Running | SSH | 花费 USD | 最终状态 |\n| --- | --- | --- | --- | --- | --- | ---: | --- |\n${rows}\n\n镜像 digest 及证据说明见 JSON。所有未知字段均明确标记为未保留，没有推测。最终本地活跃订单数：${incident.final_active_order}。\n`, "utf8");
  writeFileSync(instructionsPath, "# 如何发送给 Clore 支持\n\n1. 在 Clore 支持工单中说明：多台独立服务器的订单长期未进入 Running 或未发布可用 SSH。\n2. 附上 `clore-deployment-incident.json` 和 `clore-deployment-incident.md`。\n3. 请支持人员核查订单对应宿主机的镜像拉取、容器启动和 SSH 代理日志，并确认平台恢复后再通知你。\n4. 不要附加 `.secrets`、API Key、SSH 私钥、公钥全文或浏览器授权头。\n5. 收到支持确认后，手工创建 `.secrets/clore-support-incident-ack.json`，内容仅为 `{\"acknowledged\":true,\"incident\":\"clore-order-never-running\"}`，然后再使用受保护的恢复命令。\n", "utf8");
  return { jsonPath, mdPath, instructionsPath, failedOrderCount: incident.orders.length, finalActiveOrder: incident.final_active_order };
}

if (process.argv[1]?.endsWith("support-export.ts")) console.log(JSON.stringify(exportCloreDeploymentIncident(), null, 2));
