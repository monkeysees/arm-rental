import { runBrowserOperation } from "./browser-operation.js";
import { getConfig } from "./config.js";
import { createLogger } from "./logger.js";

const controller = new AbortController();
const logger = createLogger();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

try {
  const result = await runBrowserOperation(getConfig(), {
    requireProduction: true,
    logger,
    signal: controller.signal,
  });
  logger.info("Production browser smoke test passed", {
    targetUrl: result.targetUrl,
    regularAdsCount: result.regularAdsCount,
    profileDirectory: result.profileDirectory,
  });
} catch (error) {
  logger.error("Production browser smoke test failed", error);
  process.exitCode = 1;
}
