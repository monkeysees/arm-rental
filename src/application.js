import { acquireSingletonLock } from "./singleton-lock.js";
import { openApplicationState } from "./application-state.js";
import { validateStartupConfig } from "./config.js";
import { runStartupPreflight, startupFailureResult } from "./preflight.js";
import { classifyRuntimeFailure } from "./health.js";
import { observeStateWrites } from "./state.js";
import { isExpectedExternalFailure, retryOperation } from "./retry.js";
import {
  LIST_AM_SOURCE_INTEGRITY_ERROR,
  sourceIntegrityFailureSummary,
} from "./source-integrity.js";

const RETRYABLE_BROWSER_ERROR_NAMES = new Set([
  "BrowserVerificationRequiredError",
  "ConnectionClosedError",
  "ProtocolError",
  "TargetCloseError",
]);

function isRetryableRuntimeBrowserFailure(error) {
  if (error?.terminal) return false;
  return (
    error?.code === "ERR_BROWSER_VERIFICATION_REQUIRED" ||
    RETRYABLE_BROWSER_ERROR_NAMES.has(error?.name) ||
    isExpectedExternalFailure(error)
  );
}

function runtimeBrowserRetryReason(error) {
  if (
    error?.code === "ERR_BROWSER_VERIFICATION_REQUIRED" ||
    error?.name === "BrowserVerificationRequiredError"
  ) {
    return "BROWSER_VERIFICATION_REQUIRED";
  }
  if (error?.name === "ProtocolError") return "BROWSER_PROTOCOL_FAILURE";
  if (error?.name === "TargetCloseError") return "BROWSER_TARGET_CLOSED";
  if (error?.name === "ConnectionClosedError") {
    return "BROWSER_CONNECTION_CLOSED";
  }
  return "BROWSER_EXTERNAL_FAILURE";
}

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
  stateBackendFactory = openApplicationState,
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
  let applicationState;
  const stopObservingStateWrites = observeStateWrites(
    ({ name: event, ...metric }) =>
      logger.info("State write metric", { event, ...metric }),
  );
  const recordSourceIntegrityChecked = ({ pages = [], ...context }) => {
    healthMonitor?.recordSourceIntegritySuccess();
    for (const page of pages) {
      logger.info("List.am source integrity checked", {
        event: "source.integrity.checked",
        ...context,
        ...page,
      });
    }
  };

  try {
    await validateConfig(config, { allowNonJsonBackend: true });
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
    applicationState = await stateBackendFactory(config, {
      onMetric: ({ name: event, ...metric }) =>
        logger.info("State transaction metric", { event, ...metric }),
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
      loadState: applicationState.loadState,
      saveState: applicationState.saveState,
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
      onSourceIntegrityChecked: (observation) =>
        recordSourceIntegrityChecked({ ...observation, phase: "preflight" }),
      loadState: applicationState.loadState,
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
      "Telegram bot is running; send /start in a private chat to configure monitoring",
    );
    const fetchRuntimePage = (url) =>
      retryOperation(() => browserFetcher.fetch(url), {
        maxAttempts: 2,
        shouldRetry: isRetryableRuntimeBrowserFailure,
        retryDelay: () => 0,
        signal: controller.signal,
        onRetry: ({ attempt, delayMs, error }) =>
          logger.warn("Browser page retry scheduled", {
            event: "retry.scheduled",
            component: "browser",
            operation: "fetch_page",
            attempt,
            delayMs,
            reason: runtimeBrowserRetryReason(error),
          }),
      });
    await runBot(config, {
      signal: controller.signal,
      loadState: applicationState.loadState,
      saveState: applicationState.saveState,
      deliveryDecisions: applicationState.deliveryDecisions,
      deleteUserData: applicationState.deleteUserData,
      exchangeRateService,
      pageFetch: fetchRuntimePage,
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
          readmitted: result.readmittedCount ?? 0,
          channelSent: result.channel.sentCount,
          channelEdited: result.channel.editedCount,
          channelReadmitted: result.channel.readmittedCount ?? 0,
          total: result.totalCount,
          status: result.status,
          pagesParsed: result.pagesParsed,
          discoveredCount: result.discoveredCount,
          updatedCount: result.updatedCount,
          notifiedCount: result.notifiedCount,
          skippedCount: result.skippedCount,
          filteredCount: result.filteredCount,
          readmittedCount: result.readmittedCount ?? 0,
          totalCount: result.totalCount,
          lastKnownDate: result.lastKnownDate,
          stoppedAtKnownDate: result.stoppedAtKnownDate,
          channelSentCount: result.channel.sentCount,
          channelEditedCount: result.channel.editedCount,
          channelFilteredCount: result.channel.filteredCount,
          channelSkippedCount: result.channel.skippedCount,
          channelReadmittedCount: result.channel.readmittedCount ?? 0,
        });
      },
      onSourceIntegrityChecked: (observation) =>
        recordSourceIntegrityChecked({ ...observation, phase: "runtime" }),
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
        if (failureCode === LIST_AM_SOURCE_INTEGRITY_ERROR) {
          logger.error("List.am source integrity failed", error, {
            event: "source.integrity.failed",
            ...sourceIntegrityFailureSummary(error),
            ...(context?.crawlId ? { crawlId: context.crawlId } : {}),
          });
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
      onPrivateAccessState: (state) => {
        healthMonitor?.setPrivateAccessState(state);
        logger.info("Private access state changed", {
          event: "telegram.private.access.changed",
          ...state,
        });
      },
      onPrivateAccessDenied: ({ accessMode, reason }) =>
        logger.info("Private Telegram access denied", {
          event: "telegram.access.denied",
          accessMode,
          reason,
        }),
      onPrivateUserRateLimited: ({ updatesPerMinute }) =>
        logger.info("Private Telegram user rate limited", {
          event: "telegram.user.rate_limited",
          updatesPerMinute,
        }),
      onPrivateUserDeletionPending: () =>
        logger.info("Private user deletion started", {
          event: "telegram.private.deletion.pending",
        }),
      onPrivateUserDeletionCancelled: () =>
        logger.info("Private user deletion cancelled", {
          event: "telegram.private.deletion.cancelled",
        }),
      onPrivateUserDeletionCompleted: ({ recovered }) =>
        logger.info("Private user deletion completed", {
          event: "telegram.private.deletion.completed",
          recovered,
        }),
      onPrivateUserDeactivated: ({ reason }) =>
        logger.warn("Unavailable private subscription deactivated", {
          event: "telegram.private.deactivated",
          reason,
        }),
      onTelegramMetadataSynchronized: () =>
        logger.info("Telegram bot metadata synchronized", {
          event: "telegram.metadata.synchronized",
        }),
      onTelegramMetadataSynchronizationFailed: (error, { retryDelayMs }) =>
        logger.error("Telegram bot metadata synchronization failed", error, {
          event: "telegram.metadata.synchronization_failed",
          retryDelayMs,
        }),
      onPrivateMonitoringChanged: ({
        active,
        activeUserCount,
        sendInitialApartments,
      }) =>
        logger.info("Private monitoring state changed", {
          event: "telegram.private.monitoring.changed",
          active,
          activeUserCount,
          sendInitialApartments,
        }),
      onTelegramSuccess: () =>
        healthMonitor?.recordComponentSuccess("telegram"),
      onChannelOperation: (event) => {
        const context = {
          operation: event.operation,
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
      if (preflightResult.failure?.code === LIST_AM_SOURCE_INTEGRITY_ERROR) {
        logger.error?.("List.am source integrity failed", error, {
          event: "source.integrity.failed",
          phase: "preflight",
          ...sourceIntegrityFailureSummary(error),
        });
      }
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
      try {
        applicationState?.close();
      } finally {
        await singletonLock?.release();
      }
    }

    if (receivedSignal) {
      logger.info("Graceful shutdown completed", { signal: receivedSignal });
    }
  }
}
