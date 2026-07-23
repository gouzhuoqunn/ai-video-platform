import net from "node:net";
import type { SshTarget } from "./ssh-client";

export type CloreReadinessIssue = "order_not_deployed" | "deployed_without_ssh_endpoint" | "ssh_tcp_unreachable" | "ssh_auth_failed" | "ssh_ready" | "runtime_failed";
export type ParsedCloreOrder = {
  orderId: string | null;
  serverId: string | null;
  active: boolean;
  terminal: boolean;
  lifecycleStatus: string;
  deploymentState: string;
  deploymentReady: boolean;
  ssh: SshTarget | null;
  sshSource: "structured" | "ssh_command" | null;
  fullSshCommandPresent: boolean;
  forwardedPorts: string[];
  controllerUrl: string | null;
  controllerUrlSource: "http_pub" | "alternate_http_public" | "legacy_mapped_port" | null;
  httpPub: string | null;
  rawFieldNames: string[];
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstPort(record: Record<string, unknown>, names: string[]) {
  const port = Number(firstString(record, names));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function sanitizeHttpUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const input = value.trim();
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function validSshHost(value: string) {
  const host = value.trim();
  if (!host || host.length > 253 || /[\s/@\\]/.test(host) || host.startsWith("-") || host.endsWith(".")) return false;
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(unwrapped)) return true;
  return unwrapped.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

export function parseSshCommand(command: string): SshTarget | null {
  const normalized = command.trim().replace(/\s+/g, " ");
  const first = /^ssh -p (\d{1,5}) ([A-Za-z0-9._-]+)@([^\s]+)$/.exec(normalized);
  const second = /^ssh ([A-Za-z0-9._-]+)@([^\s]+) -p (\d{1,5})$/.exec(normalized);
  const user = first?.[2] ?? second?.[1]; const host = first?.[3] ?? second?.[2]; const port = Number(first?.[1] ?? second?.[3]);
  if (!user || !host || !/^[A-Za-z0-9._-]{1,64}$/.test(user) || !validSshHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { user, host, port };
}

function mappedSshPort(value: unknown) {
  const entries = Array.isArray(value)
    ? value.map(String)
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([left, right]) => `${left}:${String(right)}`)
      : [];
  for (const entry of entries) {
    const match = /^(\d{1,5}):(\d{1,5})$/.exec(entry.trim());
    if (!match) continue;
    const left = Number(match[1]); const right = Number(match[2]);
    if (left === 22 && right > 0 && right <= 65535) return right;
    if (right === 22 && left > 0 && left <= 65535) return left;
  }
  return null;
}

function exactSshCommand(order: Record<string, unknown>) {
  const connection = asRecord(order.connection); const ssh = order.ssh;
  for (const value of [connection.ssh_command, connection.ssh, order.ssh_command, order.ssh_cmd, typeof ssh === "string" ? ssh : null]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function mappedControllerPort(value: unknown) {
  const entries = Array.isArray(value)
    ? value.map(String)
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([left, right]) => `${left}:${String(right)}`)
      : [];
  for (const entry of entries) {
    const match = /^(\d{1,5}):(\d{1,5})$/.exec(entry.trim());
    if (!match) continue;
    const left = Number(match[1]); const right = Number(match[2]);
    if (left === 8080 && right > 0 && right <= 65535) return right;
    if (right === 8080 && left > 0 && left <= 65535) return left;
  }
  return null;
}

function resolveHttpControllerUrl(order: Record<string, unknown>, clusters: string[]) {
  const connection = asRecord(order.connection);
  const httpPub = sanitizeHttpUrl(firstString(order, ["http_pub"]));
  if (httpPub) return { controllerUrl: httpPub, controllerUrlSource: "http_pub" as const, httpPub };

  const alternate = [
    connection.web,
    connection.http_url,
    connection.http_pub,
    connection.http_public,
    connection.http_public_url,
    connection.http_proxy,
    connection.http_host,
    connection.http_hostname,
    connection.http_domain,
    connection.http_endpoint,
    connection.url,
    order.web,
    order.http_url,
    order.http_public,
    order.http_public_url,
    order.http_proxy,
    order.http_host,
    order.http_hostname,
    order.http_domain,
    order.http_endpoint,
    order.url,
  ].map(sanitizeHttpUrl).find((value): value is string => Boolean(value));
  if (alternate) return { controllerUrl: alternate, controllerUrlSource: "alternate_http_public" as const, httpPub };

  const port = mappedControllerPort(order.tcp_ports);
  if (clusters[0] && port) return { controllerUrl: `https://${clusters[0]}:${port}`, controllerUrlSource: "legacy_mapped_port" as const, httpPub };
  return { controllerUrl: null, controllerUrlSource: null, httpPub };
}

export function orderRecords(payload: unknown) {
  const record = asRecord(payload);
  const values = Array.isArray(record.orders) ? record.orders : Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : [];
  return values.map(asRecord);
}

export function parseCloreOrder(order: Record<string, unknown>): ParsedCloreOrder {
  const explicitLifecycle = firstString(order, ["status", "state", "order_status"]);
  const expired = order.expired === true;
  const terminalByText = /cancel|error|fail|stop|stopped|expire|expired|finish|finished|end|ended/.test((explicitLifecycle ?? "").toLowerCase());
  const terminal = expired || terminalByText;
  const active = !terminal && order.expired !== true;
  const container = asRecord(order.container); const deployment = asRecord(order.deployment);
  const explicitDeployment = firstString(order, ["deployment_status", "container_status", "deployment_state"])
    ?? firstString(container, ["status", "state"])
    ?? firstString(deployment, ["status", "state"]);
  const monitor = typeof order.mon_container === "number" ? order.mon_container : Number.NaN;
  // Clore's current order API reports mon_container=0 while its own order UI
  // labels the container "Deploying". It is not a failed or absent order.
  const deploymentState = explicitDeployment?.toLowerCase() ?? (monitor === 2 ? "deployed" : monitor === 1 || monitor === 0 ? "deploying" : "unknown");
  const deploymentReady = !terminal && (/deployed|running|ready/.test(deploymentState) || /running|ready/.test((explicitLifecycle ?? "").toLowerCase()));

  const sshObject = asRecord(order.ssh); const proxy = asRecord(order.ssh_proxy); const connection = asRecord(order.connection);
  const structured = [sshObject, proxy, connection, order];
  let ssh: SshTarget | null = null;
  for (const source of structured) {
    const host = firstString(source, ["host", "hostname", "ssh_host", "ip", "address"]); const port = firstPort(source, ["port", "ssh_port", "sshPort"]);
    if (host && port && validSshHost(host)) { ssh = { host, port, user: firstString(source, ["user", "ssh_user", "username"]) ?? "root" }; break; }
  }
  let sshSource: ParsedCloreOrder["sshSource"] = ssh ? "structured" : null;
  const clusters = Array.isArray(order.pub_cluster) ? order.pub_cluster.filter((value): value is string => typeof value === "string" && validSshHost(value)) : [];
  const port = mappedSshPort(order.tcp_ports);
  if (!ssh && clusters[0] && port) { ssh = { host: clusters[0], port, user: "root" }; sshSource = "structured"; }
  const command = exactSshCommand(order);
  if (!ssh && command) { ssh = parseSshCommand(command); if (ssh) sshSource = "ssh_command"; }
  const forwardedPorts = Array.isArray(order.tcp_ports) ? order.tcp_ports.map(String) : [];
  const http = resolveHttpControllerUrl(order, clusters);
  return {
    orderId: firstString(order, ["id", "order_id"]), serverId: firstString(order, ["si", "server_id", "renting_server"]), active, terminal,
    lifecycleStatus: explicitLifecycle?.toLowerCase() ?? (expired ? "expired" : "active"), deploymentState, deploymentReady, ssh, sshSource,
    fullSshCommandPresent: Boolean(command), forwardedPorts, controllerUrl: http.controllerUrl, controllerUrlSource: http.controllerUrlSource, httpPub: http.httpPub, rawFieldNames: Object.keys(order).sort(),
  };
}

export function readinessIssue(order: ParsedCloreOrder | null, probes: { tcpReached: boolean; authSucceeded: boolean; authFailed: boolean }): CloreReadinessIssue {
  if (!order || !order.active) return "order_not_deployed";
  if (!order.ssh) return "deployed_without_ssh_endpoint";
  if (!probes.tcpReached) return "ssh_tcp_unreachable";
  if (probes.authFailed || !probes.authSucceeded) return "ssh_auth_failed";
  return "ssh_ready";
}
