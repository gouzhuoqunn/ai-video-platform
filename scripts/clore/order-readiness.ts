import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { cloreRequest, sleep } from "./client";
import { loadCloreConfig } from "./config";
import { buildSshArgs, type SshTarget } from "./ssh-client";
import { readActiveOrder } from "./order-state";
import { FIXED_RUNTIME_DIGEST } from "../gpu-providers/common";

type ReadinessFailure =
  | "order_never_running"
  | "image_pull_or_container_start_timeout"
  | "ssh_endpoint_not_published"
  | "ssh_tcp_unreachable"
  | "ssh_auth_failed"
  | "runtime_start_failure";

type Connection = {
  ssh?: SshTarget;
  httpPublished: boolean;
};

function getArg(name: string) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstPort(record: Record<string, unknown>, names: string[]) {
  const value = firstString(record, names);
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function orderRecords(payload: unknown) {
  const record = asRecord(payload);
  const orders = Array.isArray(record.orders) ? record.orders : Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : [];
  return orders.map(asRecord);
}

function orderStatus(order: Record<string, unknown>) {
  return (firstString(order, ["status", "state", "order_status"]) ?? "").toLowerCase();
}

function isRunning(status: string) {
  return /running|active|started|ready/.test(status) && !/cancel|error|fail|stop|expire/.test(status);
}

function connectionFromOrder(order: Record<string, unknown>): Connection {
  const ssh = asRecord(order.ssh);
  const proxy = asRecord(order.ssh_proxy);
  const source = Object.keys(ssh).length > 0 ? ssh : Object.keys(proxy).length > 0 ? proxy : order;
  const host = firstString(source, ["host", "hostname", "ssh_host", "ip", "address"]);
  const port = firstPort(source, ["port", "ssh_port", "sshPort"]);
  const http = asRecord(order.http);
  const httpProxy = asRecord(order.http_proxy);
  const httpPublished =
    Boolean(firstString(http, ["host", "url", "address"])) ||
    Boolean(firstString(httpProxy, ["host", "url", "address"])) ||
    Boolean(firstString(order, ["http_url", "proxy_url", "controller_url"]));
  return { ssh: host && port ? { host, port, user: firstString(source, ["user", "ssh_user", "username"]) ?? "root" } : undefined, httpPublished };
}

function tcpReachable(target: SshTarget) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(5000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function sshTrue(target: SshTarget) {
  const result = spawnSync("ssh", buildSshArgs(target, "true"), { encoding: "utf8", timeout: 15000, stdio: "pipe" });
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return { ok: result.status === 0, authFailed: /permission denied|publickey/i.test(output) };
}

function failureFor(input: { running: boolean; status: string; sshPublished: boolean; tcpReached: boolean; authFailed: boolean }): ReadinessFailure {
  if (!input.running) return /image|pull|container|start/.test(input.status) ? "image_pull_or_container_start_timeout" : "order_never_running";
  if (!input.sshPublished) return "ssh_endpoint_not_published";
  if (!input.tcpReached) return "ssh_tcp_unreachable";
  if (input.authFailed) return "ssh_auth_failed";
  return "runtime_start_failure";
}

async function main() {
  const orderId = getArg("order-id");
  if (!orderId) throw new Error("clore:readiness requires --order-id=<id>.");
  const requestedTimeout = Number(getArg("timeout-minutes") ?? 10);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > 10) {
    throw new Error("clore:readiness --timeout-minutes must be between 1 and 10.");
  }
  const timeoutMs = requestedTimeout * 60 * 1000;
  const startedAt = Date.now();
  const config = loadCloreConfig();
  let running = false;
  let latestStatus = "";
  let sshPublished = false;
  let tcpReached = false;
  let authFailed = false;
  let httpPublished = false;

  while (Date.now() - startedAt < timeoutMs) {
    const orders = orderRecords(await cloreRequest<unknown>(config, "/my_orders"));
    const order = orders.find((item) => firstString(item, ["id", "order_id"]) === orderId);
    if (order) {
      latestStatus = orderStatus(order);
      running ||= isRunning(latestStatus);
      const connection = connectionFromOrder(order);
      httpPublished ||= connection.httpPublished;
      if (connection.ssh) {
        sshPublished = true;
        tcpReached = await tcpReachable(connection.ssh);
        if (tcpReached) {
          const ssh = sshTrue(connection.ssh);
          authFailed ||= ssh.authFailed;
          if (ssh.ok) {
            const targetPath = path.join(process.cwd(), ".secrets", "clore-ssh-target.json");
            mkdirSync(path.dirname(targetPath), { recursive: true });
            const active = readActiveOrder();
            writeFileSync(targetPath, `${JSON.stringify({ order_id: orderId, ...connection.ssh, username: connection.ssh.user, gpuProfile: active?.gpu_profile ?? "rtx4090", runtimeDigest: FIXED_RUNTIME_DIGEST, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
            console.log(JSON.stringify({ ready: true, order_id: orderId, elapsed_seconds: Math.round((Date.now() - startedAt) / 1000), order_running: running, ssh_proxy_published: true, ssh_tcp_reachable: true, ssh_command_true: true, http_proxy_published: httpPublished, secrets_printed: false }, null, 2));
            return;
          }
        }
      }
    }
    await sleep(10000);
  }

  const issue = failureFor({ running, status: latestStatus, sshPublished, tcpReached, authFailed });
  console.log(JSON.stringify({ ready: false, order_id: orderId, issue, elapsed_seconds: Math.round((Date.now() - startedAt) / 1000), order_running: running, ssh_proxy_published: sshPublished, ssh_tcp_reachable: tcpReached, ssh_auth_failed: authFailed, http_proxy_published: httpPublished, secrets_printed: false }, null, 2));
  process.exitCode = 2;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "order readiness failed");
  process.exitCode = 1;
});
