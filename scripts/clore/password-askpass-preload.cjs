/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync, readFileSync } = require("node:fs");

const statePath = process.env.CLORE_MANUAL_PARITY_STATE_PATH;
if (!statePath || !existsSync(statePath)) process.exit(1);
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (typeof state.sshPassword !== "string" || !state.sshPassword) process.exit(1);
process.stdout.write(`${state.sshPassword}\n`);
process.exit(0);
