import { runStagingSmoke } from "./staging-smoke.js";

try {
  console.log(JSON.stringify(await runStagingSmoke()));
} catch (error) {
  console.error(
    JSON.stringify({
      type: "rental-apartments-staging-smoke-result",
      version: 1,
      status: "failed",
      error: {
        code: error.code || "ERR_STAGING_SMOKE",
        message: error.message,
      },
    }),
  );
  process.exitCode = 1;
}
