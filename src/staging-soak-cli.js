import path from "node:path";
import { mkdir } from "node:fs/promises";

import { runStagingSoak } from "./staging-soak.js";
import {
  launchStagingService,
  sampleSoakResources,
  sleepForSoak,
  waitForReadiness,
} from "./staging-soak-runtime.js";
import { writeState } from "./state.js";

try {
  const { report, resultFilename } = await runStagingSoak(process.env, {
    launch: launchStagingService,
    ready: waitForReadiness,
    sample: sampleSoakResources,
    sleep: sleepForSoak,
  });
  await mkdir(path.dirname(resultFilename), { recursive: true, mode: 0o700 });
  await writeState(resultFilename, report);
  console.log(JSON.stringify(report));
  if (report.status !== "passed") process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      type: "rental-apartments-staging-soak-result",
      version: 1,
      status: "failed",
      error: {
        code: error.code || "ERR_STAGING_SOAK",
        message: error.message,
      },
    }),
  );
  process.exitCode = 1;
}
