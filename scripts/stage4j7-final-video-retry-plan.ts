import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { evaluateRestoreGate } from "./model-cache/restore-throughput";

const PROJECT_ID = "a6cbf8c1-f158-4583-8f40-fa524dddd9d1";
const SEGMENT_0_ID = "9e5f4d03-5233-4612-a375-01251c9c230a";
const SEGMENT_0_ATTEMPT_ID = "b94faa26-e434-4c38-a67c-bacbb3bd51a6";
const SEGMENT_1_ID = "554adaa8-fc5f-40c3-a02b-331eabcd23c8";
const SEGMENT_0_MP4_SHA = "4d72d09d12f2bf7a40e6ab49f29cc963e002bcab3d3ec2046126aef2307758d9";
const SEGMENT_0_LAST_FRAME_SHA = "6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a";
const RESTORE_BYTES = 35_572_266_487;
const STATE_PATH = path.join(process.cwd(), ".secrets", "long-video-state.json");
const POOL_PATH = path.join(process.cwd(), ".secrets", "generation-pool-state.json");
const BATCH_PATH = path.join(process.cwd(), ".secrets", "stage4j1-batch.json");
const BLOCKER_PATH = path.join(process.cwd(), ".secrets", "stage4j6-external-blocker.json");

type Json = Record<string, unknown>;

function json(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf8")) as Json;
}

function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function verifiedFile(filePath: string, expectedSha: string) {
  return existsSync(filePath) && statSync(filePath).size > 1024 && sha256(filePath) === expectedSha;
}

function assertOnlyPlanMode() {
  if (process.argv.some((value) => value === "--execute" || value.startsWith("--authorize"))) {
    throw new Error("stage4j7_is_strictly_non_authorizing");
  }
}

function main() {
  assertOnlyPlanMode();
  const state = json(STATE_PATH) as { projects?: Array<Record<string, unknown>> };
  const pool = json(POOL_PATH) as { tasks?: Array<Record<string, unknown>> };
  const batch = json(BATCH_PATH);
  const blocker = json(BLOCKER_PATH) as {
    restore?: { totalBytes?: number; lastObservedCompletedBytes?: number; observedSeconds?: number; observedAverageBytesPerSecond?: number };
  };
  const project = state.projects?.find((candidate) => candidate.id === PROJECT_ID);
  if (!project) throw new Error("stage4j7_project_missing");
  const segments = project.segments as Array<Record<string, unknown>>;
  const segment0 = segments[0];
  const segment1 = segments[1];
  const projectDir = path.join(
    "D:\\AI-Video-Library",
    String(project.createdAt).slice(0, 10),
    PROJECT_ID,
  );
  const segment0Dir = path.join(projectDir, "segments", "000", "attempts", SEGMENT_0_ATTEMPT_ID);
  const segment0Mp4 = path.join(segment0Dir, "output.mp4");
  const segment0LastFrame = path.join(segment0Dir, "last-frame.png");
  const imageJobs = (batch.imageJobs as string[]).map((id) => pool.tasks?.find((task) => task.id === id));
  const imagesVerified = imageJobs.length === 2 && imageJobs.every((task) => {
    const result = task?.outputMetadata as { outputPath?: string; outputSha256?: string; imagePreserved?: boolean } | undefined;
    return task?.status === "completed" && result?.imagePreserved === true &&
      typeof result.outputPath === "string" && typeof result.outputSha256 === "string" &&
      verifiedFile(result.outputPath, result.outputSha256);
  });
  const restoreSource = readFileSync(path.join(process.cwd(), "scripts", "clore", "restore-production-r2.py"), "utf8");
  const bundleSource = readFileSync(path.join(process.cwd(), "scripts", "model-cache", "production-restore-bundle.ts"), "utf8");
  const oldRestore = blocker.restore ?? {};
  const previousGate = evaluateRestoreGate({
    remainingBytes: Number(oldRestore.totalBytes ?? RESTORE_BYTES) - Number(oldRestore.lastObservedCompletedBytes ?? 0),
    measuredBytesPerSecond: Number(oldRestore.observedAverageBytesPerSecond ?? 0),
    elapsedSeconds: Number(oldRestore.observedSeconds ?? 0),
    fixedAllowanceSeconds: 55 * 60,
    hourlyUsd: 0.26,
    walletSpentUsd: 0.12,
    walletCapUsd: 1.25,
    wallClockCapSeconds: 120 * 60,
    drainingAtSeconds: 105 * 60,
  });
  const flags = {
    final_video_resume_ready:
      project.status === "failed" &&
      project.nextSegmentIndex === 1 &&
      project.totalSegments === 2 &&
      segment0.id === SEGMENT_0_ID &&
      segment0.status === "accepted" &&
      segment0.attemptsCount === 1 &&
      segment0.selectedAttemptId === SEGMENT_0_ATTEMPT_ID &&
      segment1.id === SEGMENT_1_ID &&
      segment1.status === "ready" &&
      segment1.attemptsCount === 0 &&
      Array.isArray(segment1.attempts) && segment1.attempts.length === 0 &&
      verifiedFile(segment0Mp4, SEGMENT_0_MP4_SHA) &&
      verifiedFile(segment0LastFrame, SEGMENT_0_LAST_FRAME_SHA) &&
      imagesVerified,
    prepared_batch_reused: batch.batchId === "stage4j1-final-5090-20260718" && batch.paidExecutionAuthorized === false,
    completed_images_reused: imagesVerified,
    image_jobs_to_generate: 0,
    UltraReal_restore_required: false,
    segment_0_reused: true,
    segment_0_inference_required: false,
    segment_0_attempts: Number(segment0.attemptsCount),
    segment_1_attempts: Number(segment1.attemptsCount),
    segment_1_inference_required: true,
    Wan_restore_required: true,
    video_segments_to_generate: 1,
    expected_wan_restores: 1,
    expected_segment_inferences: 1,
    short_video_tests: 0,
    previous_failure_classification: "restore_throughput_incompatible_with_previous_session_deadline",
    previous_failure_was_not_wan: true,
    previous_failure_was_not_blackwell: true,
    previous_failure_was_not_r2_integrity: true,
    previous_failure_was_not_ssh: true,
    previous_failure_was_not_runtime: true,
    previous_deadline_gate_rejects: previousGate.allowed === false,
    actual_r2_model_source_probe_required: true,
    actual_r2_model_source_probe_authorized: false,
    restore_multistream_ready:
      restoreSource.includes("parallel_ranges") &&
      restoreSource.includes("Content-Range") &&
      restoreSource.includes("sha256_mismatch") &&
      restoreSource.includes("single_stream_range_fallback"),
    restore_probe_ready:
      restoreSource.includes("run_probe") &&
      bundleSource.includes("totalBytes: 384 * 1024 ** 2") &&
      bundleSource.includes("streamCount: 8"),
    paid_execution_authorized: false,
    provider_mutations: 0,
  };
  const blockers = Object.entries(flags).flatMap(([name, value]) => {
    if (["image_jobs_to_generate", "segment_1_attempts", "short_video_tests", "provider_mutations"].includes(name)) {
      return value === 0 ? [] : [name];
    }
    if (["actual_r2_model_source_probe_authorized", "paid_execution_authorized", "UltraReal_restore_required", "segment_0_inference_required"].includes(name)) {
      return value === false ? [] : [name];
    }
    if (["segment_0_attempts", "expected_wan_restores", "expected_segment_inferences", "video_segments_to_generate"].includes(name)) {
      return value === 1 ? [] : [name];
    }
    if (name === "previous_failure_classification") return [];
    return value === true ? [] : [name];
  });
  const plan = {
    ...flags,
    project_id: PROJECT_ID,
    remaining_segment_id: SEGMENT_1_ID,
    segment_0_mp4_sha256: SEGMENT_0_MP4_SHA,
    segment_0_last_frame_sha256: SEGMENT_0_LAST_FRAME_SHA,
    accepted_image_sha256: imageJobs.map((task) =>
      (task?.outputMetadata as { outputSha256?: string } | undefined)?.outputSha256 ?? null),
    remaining_restore_bytes: RESTORE_BYTES,
    throughput_policy: {
      healthy_mib_per_second: ">=15",
      acceptable_extended_mib_per_second: "8-15",
      slow_dynamic_gate_mib_per_second: "5-8",
      inadequate_mib_per_second: "<5",
    },
    future_qualification_policy: {
      gpu: "RTX 5090",
      order_type: "on-demand",
      maximum_active_orders: 1,
      maximum_production_orders: 1,
      maximum_qualification_orders: 2,
      maximum_sequential_orders: 2,
      maximum_hourly_usd: 0.65,
      combined_wallet_delta_cap_usd: 1.25,
      wall_clock_minutes: 240,
      draining_at_minutes: 220,
      first_order_action: "actual_presigned_readonly_r2_model_source_probe",
      same_order_continues_only_if_probe_and_dynamic_gate_pass: true,
      one_alternative_allowed_only_before_restore_or_inference: true,
      replacement_after_restore_or_inference: false,
    },
    previous_gate: previousGate,
    paid_execution_authorized: false,
    provider_mutations: 0,
    blockers,
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!flags.final_video_resume_ready || blockers.length > 0) process.exitCode = 1;
}

main();
