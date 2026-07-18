import { writeDeploymentResolution } from "./deployment-resolution";

const batchId = process.argv.find((value) => value.startsWith("--batch-id="))?.slice("--batch-id=".length) ?? "";
if (!/^[A-Za-z0-9._-]{8,120}$/.test(batchId)) throw new Error("--batch-id must be a stable batch identifier");
const value = writeDeploymentResolution({ batchId, operatorDecision: "User explicitly authorized exactly one final RTX5090 acceptance batch; provider holds remain enabled by default." });
console.log(JSON.stringify({ resolved: value.resolved, historicalPauseReason: value.historicalPauseReason, batchId: value.batchId, resolutionNonce: "<redacted>", resolvedAt: value.resolvedAt, providerHoldsRemainEnabled: true }, null, 2));
