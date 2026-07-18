import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getLongVideoProject, updateLongVideoProjectGpuPreference } from "../src/lib/long-video/store";
import { readGenerationPool } from "../src/lib/generation/task-pool";

const root = process.cwd();
const read = (file: string) => readFileSync(`${root}/${file}`, "utf8");

const firstFrame = read("src/components/FirstFrameInput.tsx");
assert.match(firstFrame, /onDrop/);
assert.match(firstFrame, /onPaste/);
assert.match(firstFrame, /URL\.createObjectURL/);
assert.match(firstFrame, /URL\.revokeObjectURL/);
assert.match(read("src/components/LongVideoStudio.tsx"), /FirstFrameInput/);
assert.match(read("src/components/LocalCreationStudio.tsx"), /费用情况/);
assert.match(read("src/app/api/local-lab/billing/route.ts"), /searchParams\.get\("refresh"\)/);
assert.match(read("src/lib/local-lab/billing.ts"), /60_000/);

const projectId = "8fff4d9f-39f6-4aee-a02a-d0a6376e4f8b";
const project = getLongVideoProject(projectId);
assert(project, "acceptance project must exist");
assert.deepEqual(project.gpuPreference, ["rtx4090"]);
assert.equal(project.status, "waiting_for_gpu");
const prompts = project.segments.map((segment) => segment.prompt);
assert.throws(() => updateLongVideoProjectGpuPreference(projectId, project.version - 1, ["rtx4090"]), /version_conflict/);
const unchanged = getLongVideoProject(projectId);
assert(unchanged);
assert.equal(unchanged.version, project.version);
assert.deepEqual(unchanged.segments.map((segment) => segment.prompt), prompts);
const queued = readGenerationPool().tasks.filter((task) => task.longVideoProjectId === projectId);
assert(queued.length >= 1);
assert(queued.every((task) => task.gpuPreference.length === 1 && task.gpuPreference[0] === "rtx4090"));

console.log(JSON.stringify({ ok: true, projectVersion: project.version, queuedTasks: queued.length, checks: ["billing", "first_frame", "optimistic_gpu_update"] }));
