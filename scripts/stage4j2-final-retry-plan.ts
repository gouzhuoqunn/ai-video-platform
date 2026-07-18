import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { readGenerationPool } from "../src/lib/generation/task-pool";
import { getLongVideoProject } from "../src/lib/long-video/store";
import {
  assertCreateOrderBodySafe,
  assertCreateOrderUsesCanonicalIdentity,
  buildKeyWithPasswordFallbackCreateOrderBody,
} from "./clore/order-execution";
import { generateStrongSshPassword } from "./clore/manual-parity";
import { ensureValidatedProjectSshKey } from "./clore/ssh-key-validation";
import { buildScpToRemoteArgs, buildSshCommandArgs } from "./gpu-providers/common";
import type { GpuTarget } from "./gpu-providers/types";

type PreparedBatch = {
  batchId: string;
  imageJobs: string[];
  longVideoProjectId: string;
  videoSegmentCount: number;
  videoBoundaryTaskId: string;
  gpuClass: string;
  imageA: { width: number; height: number };
  imageB: { width: number; height: number };
  video: {
    generationWidth: number;
    generationHeight: number;
    finalWidth: number;
    finalHeight: number;
    frames: number;
    fps: number;
    seed: number;
    negativePrompt: string;
    segmentPrompts: string[];
  };
  tasksSelected: string[];
  paidExecutionAuthorized: boolean;
};

function hasExactValues(values: string[], expected: string[]) {
  return values.length === expected.length && new Set(values).size === values.length && expected.every((value) => values.includes(value));
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function buildStage4J2FinalRetryPlan() {
  const batchPath = path.join(process.cwd(), ".secrets", "stage4j1-batch.json");
  const batch = JSON.parse(readFileSync(batchPath, "utf8")) as PreparedBatch;
  const pool = readGenerationPool();
  const imageTasks = batch.imageJobs.map((id) => pool.tasks.find((task) => task.id === id));
  const project = getLongVideoProject(batch.longVideoProjectId);
  const expectedSelected = [...batch.imageJobs, batch.videoBoundaryTaskId];
  const selectedTasks = pool.tasks.filter((task) => batch.tasksSelected.includes(task.id));
  const shortVideoTasks = selectedTasks.filter((task) => task.id !== batch.videoBoundaryTaskId && task.generationType !== "image");

  const mediumReady = Boolean(
    imageTasks[0] &&
    imageTasks[0].generationType === "image" &&
    imageTasks[0].width === 1536 &&
    imageTasks[0].height === 1024 &&
    imageTasks[0].gpuPreference.length === 1 &&
    imageTasks[0].gpuPreference[0] === "rtx5090",
  );
  const highReady = Boolean(
    imageTasks[1] &&
    imageTasks[1].generationType === "image" &&
    imageTasks[1].width === 2048 &&
    imageTasks[1].height === 2048 &&
    imageTasks[1].gpuPreference.length === 1 &&
    imageTasks[1].gpuPreference[0] === "rtx5090",
  );
  const longVideoReady = Boolean(
    project &&
    project.targetDurationSeconds === 10 &&
    project.gpuPreference.length === 1 &&
    project.gpuPreference[0] === "rtx5090" &&
    project.segments.length === 2 &&
    project.segments.every((segment, index) =>
      segment.sequenceIndex === index &&
      segment.startSecond === index * 5 &&
      segment.endSecond === (index + 1) * 5 &&
      segment.prompt.trim().length > 0,
    ) &&
    batch.videoSegmentCount === 2 &&
    batch.video.segmentPrompts.length === 2 &&
    batch.video.segmentPrompts.every((prompt) => prompt.trim().length > 0) &&
    batch.video.generationWidth === 1280 &&
    batch.video.generationHeight === 720 &&
    batch.video.finalWidth === 1920 &&
    batch.video.finalHeight === 1080 &&
    batch.video.frames === 81 &&
    batch.video.fps === 16 &&
    batch.video.seed === 50902001 &&
    batch.video.negativePrompt.trim().length > 0
  );
  const preparedBatchReused = Boolean(
    batch.batchId === "stage4j1-final-5090-20260718" &&
    batch.gpuClass === "rtx5090" &&
    batch.imageJobs.length === 2 &&
    new Set(batch.imageJobs).size === 2 &&
    mediumReady &&
    highReady &&
    longVideoReady &&
    hasExactValues(batch.tasksSelected, expectedSelected) &&
    shortVideoTasks.length === 0,
  );

  const identity = ensureValidatedProjectSshKey();
  const oneUsePassword = generateStrongSshPassword();
  const requestBody = buildKeyWithPasswordFallbackCreateOrderBody({
    serverId: "1",
    currency: "USD-Blockchain",
    sshPassword: oneUsePassword,
    sshPublicKey: identity.normalizedPublicKey,
    requiredPriceForApi: 1,
  });
  assertCreateOrderBodySafe(requestBody);
  const createCredentialSummary = assertCreateOrderUsesCanonicalIdentity(requestBody);

  const target: GpuTarget = {
    provider: "clore",
    host: "provider-returned.example.invalid",
    port: 22,
    username: "root",
    sshKeyPath: identity.privateKeyPath,
    sshCredentialSource: "canonical_clore_project_key",
    sshIdentityFingerprint: identity.fingerprint,
    gpuProfile: "rtx5090",
    runtimeDigest: "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    knownHostsPath: path.join(process.cwd(), ".secrets", "clore-known-hosts-orders", "plan-only"),
  };
  const readinessArgs = buildSshCommandArgs(target, "true");
  const runtimeArgs = buildSshCommandArgs(target, "runtime-fixture");
  const scpArgs = buildScpToRemoteArgs(target, "fixture", "/workspace/fixture");
  const identities = [readinessArgs, runtimeArgs, scpArgs].map((args) => option(args, "-i"));
  const allComponentsShareIdentity = identities.every((value) => value === identity.privateKeyPath);
  const globalKnownHostsUsed = [readinessArgs, runtimeArgs, scpArgs].some((args) =>
    args.some((value) => value.includes(".secrets\\clore-known-hosts") && !value.includes("clore-known-hosts-orders")),
  );

  const flags = {
    final_5090_plan_ready: preparedBatchReused && allComponentsShareIdentity && !globalKnownHostsUsed,
    prepared_batch_reused: preparedBatchReused,
    duplicate_jobs_created: 0,
    canonical_ssh_identity_ready: true,
    order_ssh_key_present: requestBody.ssh_key !== undefined && requestBody.ssh_key.length > 0,
    public_private_fingerprint_match: createCredentialSummary.private_key_fingerprint_match,
    all_ssh_components_share_identity: allComponentsShareIdentity,
    order_password_fallback_prepared: Boolean(requestBody.ssh_password) && requestBody.ssh_password === oneUsePassword,
    global_known_hosts_used: globalKnownHostsUsed,
    expected_provider_orders: 1,
    paid_execution_authorized: false,
    provider_mutations: 0,
  };
  const blockers = Object.entries(flags).flatMap(([name, value]) => {
    if (name === "global_known_hosts_used") return value === false ? [] : [name];
    if (name === "paid_execution_authorized") return value === false ? [] : [name];
    if (name === "duplicate_jobs_created" || name === "provider_mutations") return value === 0 ? [] : [name];
    if (name === "expected_provider_orders") return value === 1 ? [] : [name];
    return value === true ? [] : [name];
  });
  if (blockers.length > 0) throw new Error(`stage4j2_final_retry_plan_blocked:${blockers.join(",")}`);
  return {
    ...flags,
    batch_id: batch.batchId,
    prepared_image_jobs: 2,
    prepared_long_video_projects: 1,
    prepared_video_segments: 2,
    prepared_short_video_jobs: 0,
    ssh_key_algorithm: identity.algorithm,
    ssh_key_fingerprint: identity.fingerprint,
    private_key_identifier: identity.privateKeyIdentifier,
    public_key_source: identity.publicKeySource,
    ssh_key_material_printed: false,
    password_printed: false,
    blockers,
  };
}

if (process.argv[1]?.endsWith("stage4j2-final-retry-plan.ts")) {
  console.log(JSON.stringify(buildStage4J2FinalRetryPlan(), null, 2));
}
