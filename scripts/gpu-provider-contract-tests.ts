import assert from "node:assert/strict";
import { getGpuProvider } from "./gpu-providers";
import type { GpuProviderId } from "./gpu-providers/types";

const methods = ["inspectCredentials", "getBalance", "listCandidates", "createSession", "getSession", "waitForSsh", "stopSession", "terminateSession", "getBilling", "recoverExistingSession"] as const;
for (const id of ["clore", "runpod", "manual_ssh"] satisfies GpuProviderId[]) {
  const provider = getGpuProvider(id);
  assert.equal(provider.id, id);
  for (const method of methods) assert.equal(typeof provider[method], "function", `${id}.${method}`);
}
console.log("GPU provider contract tests passed.");
