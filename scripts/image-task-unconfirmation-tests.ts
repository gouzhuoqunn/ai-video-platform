import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deletePendingImageTaskGroup, unconfirmImageTaskGroup } from "../src/lib/image-generation/image-task-groups";

const base = (id: string, status: string, patch: Record<string, unknown> = {}) => ({ id, groupId: "group-1", groupIndex: id === "a" ? 1 : 2, groupRequestedCount: 2, prompt: "fixture", referenceImage: "local-reference.png", status, attempts: 3, createdAt: "2026-07-26T00:00:00.000Z", updatedAt: "2026-07-26T00:00:00.000Z", ...patch });

function main() {
  const waiting = base("a", "waiting_for_gpu", { error: { message: "stale" }, localClaim: { leaseExpiresAt: "2026-07-01T00:00:00.000Z" } });
  const completed = base("b", "completed", { result: { relativeDir: "kept", pngSha256: "a".repeat(64), completedAt: "2026-07-26T01:00:00.000Z" } });
  const result = unconfirmImageTaskGroup([waiting, completed], "group-1", "2026-07-27T00:00:00.000Z");
  const restored = result.tasks.find((task) => task.id === "a")!; const unchanged = result.tasks.find((task) => task.id === "b")!;
  assert.equal(result.reverted, 1); assert.equal(restored.status, "pending_confirmation"); assert.equal(restored.attempts, 3); assert.equal(restored.groupId, "group-1"); assert.equal(restored.referenceImage, "local-reference.png"); assert.equal(restored.localClaim, undefined); assert.equal(restored.error, undefined); assert.deepEqual(unchanged, completed);
  assert.throws(() => unconfirmImageTaskGroup([base("a", "waiting_for_gpu", { localClaim: { leaseExpiresAt: "2099-01-01T00:00:00.000Z" } })], "group-1", "2026-07-27T00:00:00.000Z"), /停止并退租/);
  assert.throws(() => unconfirmImageTaskGroup([base("a", "generating")], "group-1", "2026-07-27T00:00:00.000Z"), /停止并退租/);
  const deleted = deletePendingImageTaskGroup([base("a", "pending_confirmation")], "group-1"); assert.equal(deleted.tasks.length, 0);
  assert.throws(() => deletePendingImageTaskGroup([base("a", "waiting_for_gpu")], "group-1"), /取消任务/);
  const route = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8"); const ui = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
  assert.match(route, /unconfirm_group/); assert.match(route, /removeUnsubmittedFrozenGroupTasks/); assert.match(ui, /取消任务/); assert.match(ui, /删除/); assert.match(ui, /尚未确认生成，无需取消/); assert.match(ui, /停止并退租/);
  const unconfirmGuard = route.slice(route.indexOf("function assertUnconfirmIsSafe"), route.indexOf("function removeUnsubmittedFrozenGroupTasks"));
  assert.match(unconfirmGuard, /activeStateLooksImageOrder/, "a real local active-order record blocks unconfirmation");
  assert.doesNotMatch(unconfirmGuard, /runner\.host\?\.orderId/, "a terminal historical host must not block an unrelated waiting group");
  assert.match(route, /const historicalTerminal = terminalRunnerState\(runner\.state\)/, "terminal cleanup is projected without a rented host");
  assert.match(ui, /const rentedHost = running &&/, "the UI labels only a live order as rented");
  console.log(JSON.stringify({ ok: true, unconfirmPreservesTaskAndGroup: true, staleClaimCleared: true, activeClaimBlocked: true, terminalHistoricalHostNonblocking: true, deleteAndUnconfirmDistinct: true, providerMutationCount: 0 }));
}

main();
