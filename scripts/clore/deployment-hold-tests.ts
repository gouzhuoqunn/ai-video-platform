import assert from "node:assert/strict";
import { getCloreDeploymentHold } from "./deployment-hold";
process.env.CLORE_DEPLOYMENT_HOLD = "true";
assert.equal(getCloreDeploymentHold().enabled, true);
delete process.env.CLORE_DEPLOYMENT_HOLD;
console.log("Clore deployment hold tests passed.");
