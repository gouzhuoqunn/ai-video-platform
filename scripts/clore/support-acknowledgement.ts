import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoSecretOutput } from "./client";
import { readGpuBillingStatus } from "../gpu-billing-status";

export const SUPPORT_ACK_PATH = path.join(process.cwd(), ".secrets", "clore-support-incident-ack.json");
export const SUPPORT_ACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SupportAcknowledgement = {
  schemaVersion: 1;
  acknowledged: true;
  incident: "clore-order-never-running";
  ticketId: string;
  acknowledgedAt: string;
  recommendedServerIds: string[];
  sanitizedResponseSha256: string;
};

type BillingSafety = Awaited<ReturnType<typeof readGpuBillingStatus>>;

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function sanitizeSupportResponseText(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email-redacted]")
    .replace(/https?:\/\/\S+/gi, "[url-redacted]")
    .replace(/(?:api[_ -]?key|authorization|bearer|token|password)\s*[:=]\s*\S+/gi, "[credential-redacted]")
    .replace(/ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+\S+)?/g, "[ssh-key-redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

export function responseSha256(value: string) {
  const sanitized = sanitizeSupportResponseText(value);
  if (!sanitized) throw new Error("支持回复文本为空，无法记录确认摘要。");
  return createHash("sha256").update(sanitized, "utf8").digest("hex");
}

export function validateSupportAcknowledgement(value: unknown, now = Date.now()) {
  const ack = value as Partial<SupportAcknowledgement> | null;
  const blockers: string[] = [];
  if (!ack || ack.schemaVersion !== 1 || ack.acknowledged !== true || ack.incident !== "clore-order-never-running") blockers.push("支持确认记录格式无效");
  if (!ack?.ticketId || !/^[A-Za-z0-9._\/-]{1,120}$/.test(ack.ticketId)) blockers.push("支持工单编号为空或格式无效");
  const acknowledgedAt = Date.parse(ack?.acknowledgedAt ?? "");
  if (!Number.isFinite(acknowledgedAt)) blockers.push("支持确认时间无效");
  else if (acknowledgedAt > now + 5 * 60_000) blockers.push("支持确认时间位于未来");
  else if (now - acknowledgedAt > SUPPORT_ACK_MAX_AGE_MS) blockers.push("支持确认已超过 7 天");
  if (!/^[a-f0-9]{64}$/.test(ack?.sanitizedResponseSha256 ?? "")) blockers.push("支持回复摘要无效");
  if (!Array.isArray(ack?.recommendedServerIds) || ack.recommendedServerIds.some((id) => !/^\d+$/.test(id))) blockers.push("推荐服务器编号格式无效");
  return { valid: blockers.length === 0, blockers, acknowledgement: blockers.length ? null : ack as SupportAcknowledgement };
}

export function readSupportAcknowledgement(filePath = SUPPORT_ACK_PATH, now = Date.now()) {
  if (!existsSync(filePath)) return { valid: false, blockers: ["尚未记录 Clore 支持恢复确认"], acknowledgement: null };
  try { return validateSupportAcknowledgement(JSON.parse(readFileSync(filePath, "utf8")), now); }
  catch { return { valid: false, blockers: ["支持确认文件无法解析"], acknowledgement: null }; }
}

export function billingSafetyBlockers(status: BillingSafety) {
  const blockers: string[] = [];
  if (status.clore.activeOrders > 0) blockers.push("仍有活跃 Clore 订单");
  if (status.runpod.activePods > 0) blockers.push("仍有活跃 RunPod Pod");
  if (status.runpod.networkVolumes > 0) blockers.push("仍有 RunPod 网络卷");
  if (status.watchdogs.remoteArmed || status.watchdogs.scheduledTaskActive || status.watchdogs.processCount !== 0 || status.watchdogs.deploymentWatcherProcessCount !== 0) blockers.push("仍有 Watchdog 或部署观察进程");
  if (status.createLockPresent) blockers.push("仍有资源创建锁");
  if (!status.holds.clore || !status.holds.runpod) blockers.push("两个 Provider hold 必须同时开启");
  return blockers;
}

export function writeSupportAcknowledgement(input: { ticketId: string; responseText: string; recommendedServerIds?: string[]; acknowledgedAt?: string }, filePath = SUPPORT_ACK_PATH) {
  const ticketId = input.ticketId.trim();
  const acknowledgedAt = input.acknowledgedAt ?? new Date().toISOString();
  const ack: SupportAcknowledgement = {
    schemaVersion: 1,
    acknowledged: true,
    incident: "clore-order-never-running",
    ticketId,
    acknowledgedAt,
    recommendedServerIds: [...new Set(input.recommendedServerIds ?? [])],
    sanitizedResponseSha256: responseSha256(input.responseText),
  };
  const validated = validateSupportAcknowledgement(ack);
  if (!validated.valid) throw new Error(validated.blockers.join("；"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.${process.pid}.part`;
  writeFileSync(partial, `${JSON.stringify(ack, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(partial, filePath);
  return ack;
}

async function main() {
  if (!process.argv.includes("--confirm-platform-recovered")) throw new Error("缺少精确确认参数 --confirm-platform-recovered；未写入确认记录。");
  const ticketId = argument("ticket")?.trim() ?? "";
  if (!ticketId) throw new Error("缺少非空 --ticket=<id>。");
  const responseFile = argument("response-file");
  if (!responseFile || !existsSync(path.resolve(responseFile))) throw new Error("需要 --response-file=<本地支持回复文本>；文件内容只用于脱敏摘要，不会被保存。");
  const status = await readGpuBillingStatus();
  const blockers = billingSafetyBlockers(status);
  if (blockers.length) throw new Error(blockers.join("；"));
  const recommendedServerIds = (argument("recommended-server-ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (recommendedServerIds.some((id) => !/^\d+$/.test(id))) throw new Error("--recommended-server-ids 只能包含逗号分隔的数字编号。");
  const ack = writeSupportAcknowledgement({ ticketId, responseText: readFileSync(path.resolve(responseFile), "utf8"), recommendedServerIds });
  const output = { acknowledged: true, ticketId: ack.ticketId, acknowledgedAt: ack.acknowledgedAt, recommendedServerIds: ack.recommendedServerIds, sanitizedResponseSha256: ack.sanitizedResponseSha256, fullResponseStored: false, holdChanged: false };
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

if (process.argv[1]?.endsWith("support-acknowledgement.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "支持确认失败"); process.exitCode = 1; });
