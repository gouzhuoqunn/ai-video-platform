import assert from "node:assert/strict";
import { buildCloreDeploymentIncident } from "./support-export";
const incident = buildCloreDeploymentIncident();
assert.equal(incident.orders.length, 4);
assert.ok(incident.orders.every((order) => order.payload.autossh_entrypoint && order.payload.ports.join(",") === "22/tcp,8080/http"));
assert.equal(JSON.stringify(incident).match(/CLORE_API_KEY|BEGIN OPENSSH PRIVATE KEY|ssh-ed25519\s+[A-Za-z0-9+/=]{20,}/i), null);
console.log("Clore support evidence redaction tests passed.");
