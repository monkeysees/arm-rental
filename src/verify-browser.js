import { BrowserPageFetcher } from "./browser-fetch.js";
import { getConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { pageUrl } from "./target.js";

const controller = new AbortController();
const logger = createLogger();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

try {
  const config = getConfig();
  const browserFetcher = new BrowserPageFetcher(
    {
      ...config,
      browserHeadless: false,
      browserStartMinimized: false,
    },
    {
      signal: controller.signal,
      onStatus: (message) => logger.info(message),
    },
  );

  try {
    logger.info("Opening List.am for browser verification");
    await browserFetcher.fetch(pageUrl(1, config.listUrlTemplate));
    logger.info("Browser verification succeeded");
  } finally {
    await browserFetcher.close();
  }
} catch (error) {
  logger.error("Browser verification failed", error);
  process.exitCode = 1;
}
