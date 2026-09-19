import { setTimeout as delay } from "node:timers/promises";
import { acquireSingletonLock } from "./singleton-lock.js";
import { openApplicationState } from "./application-state.js";
import { createEventLoopDelayMonitor } from "./event-loop-delay.js";
import { validateStartupConfig } from "./config.js";
import { runStartupPreflight, startupFailureResult } from "./preflight.js";
import { classifyRuntimeFailure } from "./health.js";
import {
  LIST_AM_SOURCE_INTEGRITY_ERROR,
  sourceIntegrityFailureSummary,
} from "./source-integrity.js";

export async function runApplication({
  config,
  logger,
  signalEmitter = process,
  sleep = delay,
  acquireLock = acquireSingletonLock,
  sourceFetcherFactory,
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
  let sourceFetcher;
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

  const reportPreflightFailure = (error) => {
    const preflightResult =
      error.preflightResult || startupFailureResult(startupComponent, error);
    if (preflightResult.status === "source_challenge") {
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
    preflightLogged = true;
  };

  // Observe event-loop stalls across startup, crawling, and delivery.
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
    sourceFetcher = sourceFetcherFactory(config, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.name === "list_am.challenge") {
          healthMonitor?.recordSourceChallenge();
          logger.warn("List.am challenge detected", {
            event: event.name,
            component: "list_am",
            code: event.code,
            httpStatus: event.httpStatus,
            challengeSource: event.challengeSource,
          });
        }
      },
    });
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

    const checkPreflight = async () => {
      try {
        const preflightResult = await preflight(config, {
          storageValidated: true,
          singletonLock,
          sourceFetcher,
          exchangeRateService,
          signal: controller.signal,
          onRetry: (event) =>
            logger.warn("External request retry scheduled", {
              event: "retry.scheduled",
              ...event,
            }),
          onSourceIntegrityChecked: (observation) =>
            recordSourceIntegrityChecked({
              ...observation,
              phase: "preflight",
            }),
          stateAccess,
        });
        logger.info("Startup preflight completed", {
          preflight: preflightResult,
        });
        healthMonitor?.setPreflight(preflightResult);
        healthMonitor?.recordExchangeRateSnapshot(
          exchangeRateService.currentSnapshot?.(),
        );
        preflightLogged = true;
      } catch (error) {
        reportPreflightFailure(error);
        const result = error.preflightResult;
        if (
          result &&
          !result.terminal &&
          result.failure?.component === "list_am"
        )
          return error;
        throw error;
      }
    };
    let sourceFailure = await checkPreflight();
    if (controller.signal.aborted) return;

    logger.info(
      "Telegram bot is running; send /start in a private chat to configure monitoring",
    );
    await runBot(config, {
      beforeMonitoring: async () => {
        while (sourceFailure && !controller.signal.aborted) {
          const retryAfterMs =
            Number.isSafeInteger(sourceFailure.retryAfterMs) &&
            sourceFailure.retryAfterMs >= 0
              ? sourceFailure.retryAfterMs
              : 0;
          const delayMs = Math.max(
            config.pollIntervalMs || 60_000,
            retryAfterMs,
          );
          logger.warn?.("Startup source retry cooling down", {
            event: "startup.cooldown",
            component: "list_am",
            delayMs,
          });
          try {
            // Chunk long Retry-After dates to avoid Node's timer overflow.
            for (let remaining = delayMs; remaining > 0;) {
              const interval = Math.min(remaining, 2_147_483_647);
              await sleep(interval, undefined, { signal: controller.signal });
              remaining -= interval;
            }
            if (!controller.signal.aborted)
              sourceFailure = await checkPreflight();
          } catch (error) {
            if (controller.signal.aborted) return;
            throw error;
          }
        }
      },
      signal: controller.signal,
      stateAccess,
      exchangeRateService,
      pageFetch: (url) => sourceFetcher.fetch(url),
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
            component === "list_am_challenge" ? "list_am" : component,
            component === "list_am_challenge"
              ? "ERR_LIST_AM_CHALLENGE"
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
    controller.abort();
    if (!preflightLogged) reportPreflightFailure(error);
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
      await sourceFetcher?.close();
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
