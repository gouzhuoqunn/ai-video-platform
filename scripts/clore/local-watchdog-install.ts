import { assertNoSecretOutput } from "./client";
import { installLocalWatchdogTask, isLocalWatchdogTaskInstalled, LOCAL_WATCHDOG_TASK_NAME } from "./watchdog-io";

function main() {
  installLocalWatchdogTask();
  const output = JSON.stringify(
    {
      local_watchdog_task: LOCAL_WATCHDOG_TASK_NAME,
      installed: isLocalWatchdogTaskInstalled(),
      interval: "1 minute",
      action_mode: "hidden_wscript_wrapper",
      secrets_printed: false,
    },
    null,
  2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

main();
