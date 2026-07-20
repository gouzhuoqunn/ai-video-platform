import { execFileSync } from "node:child_process";
execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ status: "ok", runtime: "stage2-mock-1", model_execution: "disabled" }) + "\n");
