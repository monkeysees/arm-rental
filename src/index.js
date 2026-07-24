import { runTelegramBot } from "./bot.js";
import { BrowserPageFetcher } from "./browser-fetch.js";
import { getConfig } from "./config.js";
import { createLogger } from "./logger.js";

const logger = createLogger();

try {
  const config = getConfig();
  const controller = new AbortController();
  const browserFetcher = new BrowserPageFetcher(config, {
    signal: controller.signal,
    onStatus: (message) => logger.info(message),
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => controller.abort());
  }

  logger.info(
    "Telegram bot is running; send /start from the configured owner account",
  );
  try {
    await runTelegramBot(config, {
      signal: controller.signal,
      pageFetch: (url) => browserFetcher.fetch(url),
      onResult: (result) =>
        logger.info("Apartment crawl completed", {
          status: result.status,
          pagesParsed: result.pagesParsed,
          discoveredCount: result.discoveredCount,
          notifiedCount: result.notifiedCount,
          skippedCount: result.skippedCount,
          totalCount: result.totalCount,
          lastKnownDate: result.lastKnownDate,
          stoppedAtKnownDate: result.stoppedAtKnownDate,
        }),
      onError: (error) => logger.error("Apartment crawl failed", error),
    });
  } finally {
    await browserFetcher.close();
  }
} catch (error) {
  logger.error("Application failed", error);
  process.exitCode = 1;
}
