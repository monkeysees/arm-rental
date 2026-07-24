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
          updatedCount: result.updatedCount,
          notifiedCount: result.notifiedCount,
          skippedCount: result.skippedCount,
          filteredCount: result.filteredCount,
          totalCount: result.totalCount,
          lastKnownDate: result.lastKnownDate,
          stoppedAtKnownDate: result.stoppedAtKnownDate,
          channelSentCount: result.channel.sentCount,
          channelEditedCount: result.channel.editedCount,
          channelFilteredCount: result.channel.filteredCount,
          channelSkippedCount: result.channel.skippedCount,
        }),
      onError: (error, context) =>
        logger.error(
          context?.component === "telegram-channel"
            ? "Telegram channel publication failed"
            : "Apartment crawl failed",
          error,
          context,
        ),
      onChannelOperation: (event) => {
        const context = {
          operation: event.operation,
          itemId: event.itemId,
          channelId: event.channelId,
          ...(event.messageId ? { messageId: event.messageId } : {}),
          outcome: event.outcome,
        };
        if (event.outcome === "failed") {
          logger.error(
            "Telegram channel operation failed",
            event.error,
            context,
          );
        } else {
          logger.info("Telegram channel operation completed", context);
        }
      },
      onChannelFilterFingerprintChange: (event) =>
        logger.info("Telegram channel filter fingerprint changed", event),
    });
  } finally {
    await browserFetcher.close();
  }
} catch (error) {
  logger.error("Application failed", error);
  process.exitCode = 1;
}
