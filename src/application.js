import { acquireSingletonLock } from "./singleton-lock.js";
import { openApplicationState } from "./application-state.js";
import { createEventLoopDelayMonitor } from "./event-loop-delay.js";
import { validateStartupConfig } from "./config.js";
import { runStartupPreflight, startupFailureResult } from "./preflight.js";
import { classifyRuntimeFailure } from "./health.js";
import {
  ExponentialBackoff,
  isExpectedExternalFailure,
  retryOperation,
} from "./retry.js";
import {
  LIST_AM_SOURCE_INTEGRITY_ERROR,
  sourceIntegrityFailureSummary,
} from "./source-integrity.js";

// The renderer stalled rather than refused. These are load symptoms, so the
// browser they came from is already beyond saving and the host needs a moment
// before the next one launches.
const BROWSER_STALL_ERROR_NAMES = new Set([
  "BrowserContentTimeoutError",
  "ConnectionClosedError",
  "ProtocolError",
  "TargetCloseError",
]);

// Every stall, plus the challenge that a fresh browser can answer at once.
const RETRYABLE_BROWSER_ERROR_NAMES = new Set([
  ...BROWSER_STALL_ERROR_NAMES,
  "BrowserVerificationRequiredError",
]);

// A stalled attempt is now bounded rather than open-ended, so backing off
// costs a fraction of what waiting for one stall used to, and the cap keeps
// three attempts well inside a single crawl.
const BROWSER_RETRY_MAX_DELAY_MS = 8_000;

function isBrowserStallFailure(error) {
  return !error?.terminal && BROWSER_STALL_ERROR_NAMES.has(error?.name);
}

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
  if (error?.name === "BrowserContentTimeoutError") {
    return "BROWSER_CONTENT_TIMEOUT";
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
  eventLoopDelayMonitorFactory = createEventLoopDelayMonitor,
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

  // Started before anything long-running so the record covers preflight and
  // every crawl after it. A browser protocol timeout says only that a CDP call
  // went unanswered; whether this process was in a position to read the answer
  // is a separate question, and this is what answers it.
  // Emitted at info: these records are read as a series against the crawl
  // records sharing their timestamps, and the warning channel collapses
  // repeats of one signature for minutes at a time, which is precisely the
  // series a stall would erase.
  const eventLoopDelay = eventLoopDelayMonitorFactory({
    onMetric: ({ name: event, ...metric }) =>
      logger.info("Event loop delayed", { event, ...metric }),
  });

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
            // Which page, and whether the edge said so or a missing listing
            // container inferred it. `rentalctl logs` projects neither, by
            // design; the raw journal recipe in the runbook shows both. Absent
            // fields are omitted rather than logged as null: a navigation that
            // returned no response has no status to report.
            ...(event.url === undefined ? {} : { url: event.url }),
            ...(event.httpStatus === undefined
              ? {}
              : { httpStatus: event.httpStatus }),
            ...(event.challengeSource === undefined
              ? {}
              : { challengeSource: event.challengeSource }),
          });
          return;
        }
        // A forced exit loses whatever Chrome had not written, the List.am
        // clearance included, so it belongs next to the challenges it causes.
        if (event.name === "browser.forced_exit") {
          logger.warn("Chrome did not exit on request", {
            eventName: event.name,
            component: event.component,
            code: event.code,
            gracefulTimeoutMs: event.gracefulTimeoutMs,
          });
        }
      },
    });
    // Releasing the browser is cleanup, never a reason to fail the work that
    // was using it, so this absorbs its own failures and reports them.
    const endBrowserSession = async () => {
      try {
        await browserFetcher.endSession();
      } catch (error) {
        logger.warn("Browser session release failed", {
          event: "browser.session.release_failed",
          component: "browser",
          reason: error.message,
        });
      }
    };
    const { stateAccess } = applicationState;
    const exchangeRateService = exchangeRateServiceFactory(config, {
      stateStore: stateAccess.exchangeRates,
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
      stateAccess,
    });
    // Preflight is a page run of its own, and the first crawl is a poll
    // interval away. Release its browser rather than idling one until then.
    await endBrowserSession();
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
    // A stalled renderer is the dominant browser failure in production and it
    // never recovers in place, so the page is only ever won back by abandoning
    // the attempt and launching a fresh Chrome. Now that each attempt carries
    // its own budget, a third one costs less than a single stall used to, and
    // it is the attempt that most often returns the page.
    const fetchRuntimePage = (url) => {
      // Per fetch, so one page's stalls cannot lengthen the next page's waits.
      const stallBackoff = new ExponentialBackoff({
        baseDelayMs: config.externalRetryBaseMs || 1_000,
        maxDelayMs: Math.min(
          BROWSER_RETRY_MAX_DELAY_MS,
          config.externalRetryMaxMs || BROWSER_RETRY_MAX_DELAY_MS,
        ),
      });
      return retryOperation(() => browserFetcher.fetch(url), {
        maxAttempts: 3,
        shouldRetry: isRetryableRuntimeBrowserFailure,
        // Only a stall waits. A verification challenge is not a load symptom,
        // and delaying it would just postpone the page.
        retryDelay: (error) =>
          isBrowserStallFailure(error) ? stallBackoff.nextDelay() : 0,
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
    };
    await runBot(config, {
      signal: controller.signal,
      stateAccess,
      exchangeRateService,
      pageFetch: fetchRuntimePage,
      onCrawlSettled: endBrowserSession,
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
          sources: result.sources,
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
      onPrivateHistoryDecision: ({ accepted, count }) =>
        logger.info("Private history offer answered", {
          event: "telegram.private.history.answered",
          accepted,
          count,
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
    // Report whatever the last, unfinished window saw before dropping it: a
    // shutdown that follows a stall is exactly when that window matters.
    eventLoopDelay?.sample?.();
    eventLoopDelay?.stop?.();
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
