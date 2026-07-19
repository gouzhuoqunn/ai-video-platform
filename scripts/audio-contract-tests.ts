import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUDIO_WORKER_PATHS } from "../src/lib/audio/worker-contract";
import { getAudioCardStatus } from "../src/lib/audio/status";
import { audioInferenceStatuses } from "../src/types/audio";

assert.deepEqual(audioInferenceStatuses, ["queued", "waiting_for_resources", "loading_voice", "generating", "muxing", "succeeded", "failed", "canceled"]);
assert.equal(getAudioCardStatus(null).label, "生成声音");
for (const status of ["queued", "waiting_for_resources", "loading_voice", "generating", "muxing"] as const) assert.equal(getAudioCardStatus(status).label, "声音正在生成");
assert.equal(getAudioCardStatus("succeeded").label, "声音生成成功");
assert.equal(getAudioCardStatus("failed").label, "声音生成失败");
assert.equal(getAudioCardStatus("canceled").canRegenerate, true);
assert.ok(AUDIO_WORKER_PATHS.queueStatePath.endsWith("audio-worker-queue.json"));
assert.ok(AUDIO_WORKER_PATHS.workerStatePath.endsWith("audio-worker-state.json"));

const migration = readFileSync("supabase/migrations/0011_audio_foundation_contracts.sql", "utf8");
for (const table of ["voice_profiles", "dialogue_cues", "voice_inference_jobs", "audio_revisions", "composition_versions", "composition_current_pointers"]) assert.ok(migration.includes(`public.${table}`), `missing ${table}`);
assert.ok(migration.includes("Audio and composition revisions are immutable."), "audio and composition revisions must be immutable");
assert.ok(migration.includes("unique (user_id, idempotency_key)"), "voice inference creation must be idempotent");
assert.ok(migration.includes("on delete restrict"), "reusable voice profiles must survive project deletion");
assert.ok(migration.includes("on delete cascade"), "project and segment-scoped rows must cascade with their parent");
assert.ok(migration.includes("enable row level security"), "audio tables must use RLS");
assert.ok(migration.includes("create_voice_inference_job"), "audio inference job creation RPC must exist");
assert.ok(migration.includes("validate_audio_parent_owner"), "audio records must validate that their media parent has the same owner");
assert.ok(migration.includes("Current composition pointer must match its version owner and media parent."), "current composition pointers must stay scoped to their own media parent");
assert.ok(migration.includes("Dialogue snapshot must be an array."), "inference creation must validate a stable dialogue snapshot");
assert.ok(!migration.includes("output-with-audio.mp4"), "this stage must not add Supabase audio upload semantics");
console.log("Audio foundation contract tests passed.");
