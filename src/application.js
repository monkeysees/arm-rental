import { acquireSingletonLock } from "./singleton-lock.js";
import { validateStartupConfig } from "./config.js";
import { runStartupPreflight, startupFailureResult } from "./preflight.js";

export async function runApplication({
  config,
  logger,
  signalEmitter = process,
  acquireLock = acquireSingletonLock,
  browserFetcherFactory,
  exchangeRateServiceFactory,
  runBot,
  preflight = runStartupPreflight,
  validateConfig = validateStartupConfig,
}) {
  // Configuration and persistent-storage checks must finish before acquiring
  // runtime resources or entering any long-running loop.
  let startupComponent = "storage";
  let singletonLock;
  let preflightLogged = false;
  const controller = new AbortController();
  let receivedSignal;
  const signalHandlers = new Map();
  let browserFetcher;

  try {
    await validateConfig(config);
    startupComponent = "singleton";
    singletonLock = await acquireLock(config.dataDirectory);
    startupComponent = "preflight";

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        receivedSignal ??= signal;
        logger.info("Graceful shutdown requested", { signal });
        controller.abort();
      };
      signalHandlers.set(signal, handler);
      signalEmitter.once(signal, handler);
    }

    logger.info("Singleton lease acquired", {
      dataDirectory: singletonLock.dataDirectory,
      processId: singletonLock.owner.pid,
    });
    browserFetcher = browserFetcherFactory(config, {
      signal: controller.signal,
      onStatus: (message) => logger.info(message),
    });
    const exchangeRateService = exchangeRateServiceFactory(config, {
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

    const preflightResult = await preflight(config, {
      storageValidated: true,
      singletonLock,
      browserFetcher,
      exchangeRateService,
      signal: controller.signal,
    });
    logger.info("Startup preflight completed", {
      preflight: preflightResult,
    });
    preflightLogged = true;

    logger.info(
      "Telegram bot is running; send /start from the configured owner account",
    );
    await runBot(config, {
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
  } catch (error) {
    if (!preflightLogged) {
      const preflightResult =
        error.preflightResult || startupFailureResult(startupComponent, error);
      if (preflightResult.status === "browser_verification_required") {
        logger.warn?.("Startup preflight completed", {
          preflight: preflightResult,
        });
      } else {
        logger.error?.("Startup preflight completed", error, {
          preflight: preflightResult,
        });
      }
      preflightLogged = true;
    }
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      signalEmitter.removeListener(signal, handler);
    }

    try {
      await browserFetcher?.close();
    } finally {
      await singletonLock?.release();
    }

    if (receivedSignal) {
      logger.info("Graceful shutdown completed", { signal: receivedSignal });
    }
  }
}
