import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeOrderMatchesRunner,
  formatClockDuration,
  projectLiveReceiptStage,
  projectRentalTiming,
  rentalClockSnapshot,
} from "../src/lib/image-generation/live-runner-display";

const taskA = "8bd27444-d750-4b19-aa18-cee750b38fc7";
const taskB = "ea73295c-7893-4ccd-b5a4-8acdee88085a";
const runner = {
  state: "running",
  attemptId: "36028b7b-becc-47d5-aed8-57b577719e45",
  orderId: "1986571",
  serverId: "97978",
  candidateRole: "rented_host",
  frozenTaskIds: [taskA, taskB],
};
const activeOrder = {
  orderId: "1986571",
  serverId: "97978",
  createdAt: "2026-07-28T06:40:42.432Z",
  createAttemptId: runner.attemptId,
};
const watchdog = {
  armed: true,
  serverId: "97978",
  drainingAt: "2026-07-28T10:30:42.423Z",
  hardDeadlineAt: "2026-07-28T10:40:42.423Z",
};
const receipt = {
  sessionId: runner.attemptId,
  sessionState: "running",
  orderId: runner.orderId,
  serverId: runner.serverId,
  selectedTaskIds: runner.frozenTaskIds,
  currentTaskId: null,
  currentRemoteStage: "models",
  currentStageRunId: "72204202-521c-48d9-bdf6-ff89abf1e5e2",
};

assert.equal(activeOrderMatchesRunner(runner, activeOrder), true);
assert.equal(activeOrderMatchesRunner({ ...runner, orderId: null, candidateRole: "candidate" }, activeOrder), true);
assert.equal(activeOrderMatchesRunner(runner, { ...activeOrder, orderId: "stale-order" }), false);
assert.equal(activeOrderMatchesRunner(runner, { ...activeOrder, serverId: "98682" }), false);
assert.equal(activeOrderMatchesRunner(runner, { ...activeOrder, createAttemptId: "stale-attempt" }), false);

assert.deepEqual(projectLiveReceiptStage(runner, receipt), {
  stage: "正在下载并校验模型",
  currentTaskIndex: null,
});
assert.deepEqual(projectLiveReceiptStage(runner, {
  ...receipt,
  currentRemoteStage: "inference",
  currentTaskId: taskB,
}), {
  stage: "正在生成图像（第 2 / 2 张）",
  currentTaskIndex: 1,
});
assert.equal(projectLiveReceiptStage(runner, { ...receipt, sessionId: "stale-session" }), null);
assert.equal(projectLiveReceiptStage(runner, { ...receipt, orderId: "stale-order" }), null);
assert.equal(projectLiveReceiptStage(runner, { ...receipt, currentStageRunId: null }), null);
assert.equal(projectLiveReceiptStage(runner, { ...receipt, selectedTaskIds: [taskB, taskA] }), null);

const timing = projectRentalTiming({ runner, activeOrder, watchdog });
assert.deepEqual(timing, {
  startedAt: activeOrder.createdAt,
  drainingAt: watchdog.drainingAt,
  hardDeadlineAt: watchdog.hardDeadlineAt,
});
assert.equal(projectRentalTiming({
  runner: { ...runner, candidateRole: "candidate" },
  activeOrder,
  watchdog,
}), null);
assert.equal(projectRentalTiming({
  runner,
  activeOrder: { ...activeOrder, orderId: "stale-order" },
  watchdog,
}), null);
assert.deepEqual(projectRentalTiming({
  runner,
  activeOrder,
  watchdog: { ...watchdog, serverId: "98682" },
}), {
  startedAt: activeOrder.createdAt,
  drainingAt: null,
  hardDeadlineAt: null,
});
assert.equal(projectRentalTiming({
  runner,
  activeOrder: { ...activeOrder, createdAt: "invalid" },
  watchdog,
}), null);

assert.equal(formatClockDuration(0), "00:00:00");
assert.equal(formatClockDuration(3_599_000), "00:59:59");
assert.equal(formatClockDuration(3_600_000), "01:00:00");
assert.equal(formatClockDuration(25 * 3_600_000), "25:00:00");
assert.equal(formatClockDuration(-1_000), "00:00:00");
assert.deepEqual(
  rentalClockSnapshot(
    { startedAt: "2026-07-28T06:40:42.000Z", drainingAt: null, hardDeadlineAt: "2026-07-28T10:40:42.000Z" },
    Date.parse("2026-07-28T07:40:42.000Z"),
  ),
  { elapsed: "01:00:00", countdown: "03:00:00", deadlineReached: false },
);
assert.deepEqual(
  rentalClockSnapshot(
    { startedAt: "2026-07-28T06:40:42.000Z", drainingAt: null, hardDeadlineAt: "2026-07-28T10:40:42.000Z" },
    Date.parse("2026-07-28T10:40:43.000Z"),
  ),
  { elapsed: "04:00:01", countdown: "00:00:00", deadlineReached: true },
);

const routeSource = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8");
const studioSource = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
assert.match(routeSource, /readLocalWatchdogArmState/);
assert.match(routeSource, /projectLiveReceiptRunner/);
assert.match(routeSource, /rentalTiming: projectedRentalTiming/);
assert.doesNotMatch(routeSource.match(/async function responsePayload[\s\S]*?\n}\n/)?.[0] ?? "", /cloreRequest|readLiveOrdersSummary|saveRunner/);
assert.match(studioSource, /显卡租用时间/);
assert.match(studioSource, /退租倒计时（最晚）/);
assert.match(studioSource, /window\.clearInterval\(timer\)/);
assert.match(studioSource, /candidateRole === "rented_host"/);

console.log(JSON.stringify({
  ok: true,
  liveStageProjection: true,
  rentalTiming: true,
  countdownClamped: true,
  providerMutationCount: 0,
}));
