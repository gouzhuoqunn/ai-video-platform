import assert from "node:assert/strict";
import { assertCloreDeploymentAllowed, getCloreDeploymentHold } from "./deployment-hold";
process.env.CLORE_DEPLOYMENT_HOLD = "true";
assert.equal(getCloreDeploymentHold().enabled, true);
assert.throws(() => assertCloreDeploymentAllowed(), /CLORE_DEPLOYMENT_HOLD=true/);
assert.doesNotThrow(() => assertCloreDeploymentAllowed({ provenRtx4090ImageTextRelease: true }));
delete process.env.CLORE_DEPLOYMENT_HOLD;
console.log("Clore deployment hold tests passed.");
