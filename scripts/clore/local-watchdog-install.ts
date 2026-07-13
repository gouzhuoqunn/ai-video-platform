import { assertNoSecretOutput } from "./client";
import { installLocalWatchdogTask, isLocalWatchdogTaskInstalled, LOCAL_WATCHDOG_TASK_NAME } from "./watchdog-io";

function main() {
  if (!isLocalWatchdogTaskInstalled()) {
    installLocalWatchdogTask();
  }
  const output = JSON.stringify(
    {
      local_watchdog_task: LOCAL_WATCHDOG_TASK_NAME,
      installed: isLocalWatchdogTaskInstalled(),
      interval: "1 minute",
      secrets_printed: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

main();
