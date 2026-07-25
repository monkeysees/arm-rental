import { acquireSingletonLock } from "./singleton-lock.js";
import { validateStartupConfig } from "./config.js";
import { runStartupPreflight, startupFailureResult } from "./preflight.js";
import { classifyRuntimeFailure } from "./health.js";
import { observeStateWrites } from "./state.js";

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
  healthMonitor,
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
  const stopObservingStateWrites = observeStateWrites(
    ({ name: event, ...metric }) =>
      logger.info("State write metric", { event, ...metric }),
  );

  try {
    await validateConfig(config);
    healthMonitor?.setConfigurationValid();
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
      onEvent: (event) => {
        if (event.name === "browser.challenge") {
          healthMonitor?.recordBrowserChallenge();
          logger.warn("Browser challenge detected", {
            eventName: event.name,
            component: event.component,
            code: event.code,
            remediationCommand: event.remediationCommand,
          });
        }
      },
    });
    const exchangeRateService = exchangeRateServiceFactory(config, {
      onRefresh: (snapshot) => {
        healthMonitor?.recordExchangeRateSnapshot(snapshot);
        logger.info("CBA exchange rates refreshed", {
          fetchedAt: snapshot.fetchedAt,
          effectiveDate: snapshot.effectiveDate,
        });
      },
      onFetchError: (error, snapshot) => {
        healthMonitor?.recordExchangeRateFailure(snapshot);
        logger.error("CBA exchange-rate refresh failed", error, {
          usingStoredRates: Boolean(snapshot),
          storedRatesFetchedAt: snapshot?.fetchedAt,
        });
      },
      onRetry: (event) =>
        logger.warn("External request retry scheduled", {
          event: "retry.scheduled",
          ...event,
        }),
    });

    const preflightResult = await preflight(config, {
      storageValidated: true,
      singletonLock,
      browserFetcher,
      exchangeRateService,
      signal: controller.signal,
      onRetry: (event) =>
        logger.warn("External request retry scheduled", {
          event: "retry.scheduled",
          ...event,
        }),
    });
    logger.info("Startup preflight completed", {
      preflight: preflightResult,
    });
    healthMonitor?.setPreflight(preflightResult);
    healthMonitor?.recordExchangeRateSnapshot(
      exchangeRateService.currentSnapshot?.(),
    );
    preflightLogged = true;

    logger.info(
      "Telegram bot is running; send /start from the configured owner account",
    );
    await runBot(config, {
      signal: controller.signal,
      exchangeRateService,
      pageFetch: (url) => browserFetcher.fetch(url),
      onResult: (result) => {
        healthMonitor?.recordCrawlSuccess();
        logger.info("Apartment crawl completed", {
          event: "crawl.succeeded",
          crawlId: result.crawlId,
          durationMs: result.durationMs,
          duration: result.durationMs,
          pages: result.pagesParsed,
          discovered: result.discoveredCount,
          updated: result.updatedCount,
          notified: result.notifiedCount,
          filtered: result.filteredCount,
          channelSent: result.channel.sentCount,
          channelEdited: result.channel.editedCount,
          total: result.totalCount,
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
        });
      },
      onError: (error, context) => {
        const component = classifyRuntimeFailure(error, context);
        const failureCode =
          error.terminal && context?.component === "telegram-channel"
            ? "ERR_TELEGRAM_CHANNEL_PERMISSIONS"
            : error.terminal && component === "telegram"
              ? "ERR_TELEGRAM_CREDENTIALS"
              : error.code;
        if (context?.crawlFailure) {
          healthMonitor?.recordCrawlFailure(component, failureCode);
        } else {
          healthMonitor?.recordComponentFailure(
            component === "browser_challenge" ? "browser" : component,
            component === "browser_challenge"
              ? "ERR_BROWSER_VERIFICATION_REQUIRED"
              : failureCode,
          );
        }
        logger.error(
          context?.component === "telegram-channel"
            ? "Telegram channel publication failed"
            : "Apartment crawl failed",
          error,
          {
            event: context?.crawlFailure
              ? "crawl.failed"
              : context?.component === "telegram-channel"
                ? "channel.operation.failed"
                : "runtime.operation.failed",
            ...context,
          },
        );
      },
      onMonitoringState: (state) => healthMonitor?.setMonitoringState(state),
      onTelegramSuccess: () =>
        healthMonitor?.recordComponentSuccess("telegram"),
      onChannelOperation: (event) => {
        const context = {
          operation: event.operation,
          itemId: event.itemId,
          channelId: event.channelId,
          ...(event.messageId ? { messageId: event.messageId } : {}),
          outcome: event.outcome,
          ...(event.crawlId
            ? {
                crawlId: event.crawlId,
                durationMs: event.durationMs,
              }
            : {}),
        };
        if (event.outcome === "failed") {
          healthMonitor?.recordComponentFailure(
            "telegram",
            event.error?.code || "ERR_TELEGRAM_CHANNEL",
          );
          logger.error(
            "Telegram channel operation failed",
            event.error,
            context,
          );
        } else {
          healthMonitor?.recordComponentSuccess("telegram");
          logger.info("Telegram channel operation completed", context);
        }
      },
      onChannelFilterFingerprintChange: (event) =>
        logger.info("Telegram channel filter fingerprint changed", {
          event: "channel.filter.changed",
          ...event,
        }),
      onRetry: (retry) =>
        logger.warn("External request retry scheduled", {
          event: "retry.scheduled",
          ...retry,
        }),
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
      healthMonitor?.setPreflight(preflightResult);
      preflightLogged = true;
    }
    throw error;
  } finally {
    stopObservingStateWrites();
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
