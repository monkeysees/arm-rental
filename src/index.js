import { runTelegramBot } from "./bot.js";
import { BrowserPageFetcher } from "./browser-fetch.js";
import { getConfig } from "./config.js";
import { ExchangeRateService } from "./exchange-rates.js";
import { createLogger } from "./logger.js";

const logger = createLogger();

try {
  const config = getConfig();
  const controller = new AbortController();
  const browserFetcher = new BrowserPageFetcher(config, {
    signal: controller.signal,
    onStatus: (message) => logger.info(message),
  });
  const exchangeRateService = new ExchangeRateService(config, {
    onRefresh: (snapshot) =>
      logger.info("CBA exchange rates refreshed", {
        fetchedAt: snapshot.fetchedAt,
        effectiveDate: snapshot.effectiveDate,
      }),
    onFetchError: (error, snapshot) =>
      logger.error("CBA exchange-rate refresh failed", error, {
        usingStoredRates: Boolean(snapshot),
        storedRatesFetchedAt: snapshot?.fetchedAt,
      }),
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
      exchangeRateService,
      pageFetch: (url) => browserFetcher.fetch(url),
      onResult: (result) =>
        logger.info("Apartment crawl completed", {
          status: result.status,
          pagesParsed: result.pagesParsed,
          discoveredCount: result.discoveredCount,
          notifiedCount: result.notifiedCount,
          skippedCount: result.skippedCount,
          filteredCount: result.filteredCount,
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
