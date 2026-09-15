import { getConfig } from "./config.js";
import { runSourceSmoke } from "./list-am-operation.js";
import { createLogger } from "./logger.js";

const controller = new AbortController();
const logger = createLogger();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}
try {
  const result = await runSourceSmoke(getConfig(), {
    signal: controller.signal,
  });
  logger.info("List.am HTTP smoke test passed", {
    event: "source.smoke.passed",
    ...result,
  });
} catch (error) {
  logger.error("List.am HTTP smoke test failed", error, {
    event: "source.smoke.failed",
  });
  process.exitCode = 1;
}
