import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCloreDeploymentHold } from "./deployment-hold";
import { readActiveOrder } from "./order-state";

type IncidentOrder = {
  order_id: string;
  server_id: string;
  gpu: string;
  price_usd: number | null;
  image: string;
  payload: { autossh_entrypoint: boolean; ports: string[]; ssh_public_key_present: boolean; private_key_present: false };
  outcome: { entered_running: boolean; ssh_endpoint_published: boolean; http_endpoint_published: boolean; wait_minutes: number | null; final_state: string };
  spend_usd: number | null;
};

const image = "ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137";
const payload = { autossh_entrypoint: true, ports: ["22/tcp", "8080/http"], ssh_public_key_present: true, private_key_present: false as const };
const orders: IncidentOrder[] = [
  { order_id: "1954464", server_id: "105176", gpu: "NVIDIA GeForce RTX 4090", price_usd: null, image, payload, outcome: { entered_running: false, ssh_endpoint_published: false, http_endpoint_published: false, wait_minutes: 12, final_state: "cancelled:order_never_running" }, spend_usd: 0.18 },
  { order_id: "1954484", server_id: "105173", gpu: "NVIDIA GeForce RTX 4090", price_usd: null, image, payload, outcome: { entered_running: false, ssh_endpoint_published: false, http_endpoint_published: false, wait_minutes: 12, final_state: "cancelled:order_never_running" }, spend_usd: 0.18 },
  { order_id: "1954507", server_id: "104878", gpu: "NVIDIA GeForce RTX 5090", price_usd: null, image, payload, outcome: { entered_running: false, ssh_endpoint_published: false, http_endpoint_published: false, wait_minutes: 12, final_state: "cancelled:order_never_running" }, spend_usd: 0.19 },
  { order_id: "1950673", server_id: "79445", gpu: "official-small-image-comparison", price_usd: null, image: "official_small_image_comparison", payload, outcome: { entered_running: false, ssh_endpoint_published: false, http_endpoint_published: false, wait_minutes: null, final_state: "historical_comparison_failed" }, spend_usd: null },
];

export function buildCloreDeploymentIncident() {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    deployment_hold: getCloreDeploymentHold(),
    orders,
    probe_summary: {
      local_readiness_probe: "orders did not reach running or publish SSH; SSH was not attempted for the three incident orders",
      github_runner_probe: "not_applicable: deployment failure occurred after Clore order creation, not in GitHub Actions",
    },
    balance: { before_usd: 14.78, after_usd: 14.23, observed_spend_usd: 0.55 },
    final_active_order: readActiveOrder() === null ? 0 : 1,
    redaction: { api_key: false, ssh_public_key_fulltext: false, passwords: false, environment: false, raw_payload: false },
  };
}

export function exportCloreDeploymentIncident(root = process.cwd()) {
  const incident = buildCloreDeploymentIncident();
  const dir = path.join(root, "artifacts", "clore-support");
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, "clore-deployment-incident.json");
  const mdPath = path.join(dir, "clore-deployment-incident.md");
  writeFileSync(jsonPath, `${JSON.stringify(incident, null, 2)}\n`, "utf8");
  const rows = incident.orders.map((order) => `| ${order.order_id} | ${order.server_id} | ${order.gpu} | ${order.outcome.entered_running ? "yes" : "no"} | ${order.outcome.ssh_endpoint_published ? "yes" : "no"} | ${order.outcome.final_state} |`).join("\n");
  writeFileSync(mdPath, `# Clore Deployment Incident\n\nGenerated: ${incident.generated_at}\n\n| Order | Server | GPU | Running | SSH published | Final state |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\nAll listed deployments used the fixed Runtime digest where applicable, ` + "`autossh_entrypoint=true`" + ", `22/tcp`, and `8080/http`; no `8188` port, API key, private key, password, environment dump, or raw payload is included. The three current incidents never entered running or published SSH/HTTP. Final active order count: ${incident.final_active_order}.\n", "utf8");
  return { jsonPath, mdPath, finalActiveOrder: incident.final_active_order };
}

if (process.argv[1]?.endsWith("support-export.ts")) console.log(JSON.stringify(exportCloreDeploymentIncident(), null, 2));
