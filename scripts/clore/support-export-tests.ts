import assert from "node:assert/strict";
import { buildCloreDeploymentIncident } from "./support-export";
const incident = buildCloreDeploymentIncident();
assert.equal(incident.orders.length, 11);
assert.ok(incident.orders.every((order) => "created_at" in order && "cancelled_at" in order && "image_digest" in order && "spend_usd" in order));
assert.equal(JSON.stringify(incident).match(/CLORE_API_KEY|BEGIN OPENSSH PRIVATE KEY|ssh-ed25519\s+[A-Za-z0-9+/=]{20,}/i), null);
console.log("Clore support evidence redaction tests passed.");
