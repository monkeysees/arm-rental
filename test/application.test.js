import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runApplication } from "../src/application.js";
import { HealthMonitor } from "../src/health.js";
import {
  ListAmIntegrityReason,
  ListAmSourceIntegrityError,
} from "../src/source-integrity.js";

test("configuration validation fails before locks, resources, or loops start", async () => {
  const calls = [];
  const configurationError = new Error("invalid persistent configuration");

  await assert.rejects(
    runApplication({
      config: {},
      logger: {},
      validateConfig: async () => {
        calls.push("validate");
        throw configurationError;
      },
      acquireLock: async () => {
        calls.push("lock");
      },
      browserFetcherFactory: () => {
        calls.push("browser");
      },
      exchangeRateServiceFactory: () => {
        calls.push("exchange-rates");
      },
      runBot: async () => {
        calls.push("bot");
      },
    }),
    configurationError,
  );

  assert.deepEqual(calls, ["validate"]);
});

test("application lifecycle drives crawl and exchange-rate readiness", async () => {
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => new Date("2026-07-25T10:00:00.000Z"),
  });
  const exchangeSnapshot = {
    fetchedAt: "2026-07-25T09:00:00.000Z",
  };
  const infoRecords = [];
  const warningRecords = [];
  const errorRecords = [];
  const signalEmitter = new EventEmitter();
  const logger = {
    info: (message, context) => infoRecords.push({ message, context }),
    warn: (message, context) => warningRecords.push({ message, context }),
    error: (message, error, context) =>
      errorRecords.push({ message, error, context }),
  };

  await runApplication({
    config: {
      dataDirectory: "/data",
      telegramChannelId: "@rentals",
    },
    logger,
    signalEmitter,
    healthMonitor: monitor,
    validateConfig: async () => {},
    acquireLock: async () => ({
      dataDirectory: "/data",
      owner: { pid: 42 },
      release: async () => {},
    }),
    browserFetcherFactory: (_config, callbacks) => {
      callbacks.onStatus("Browser is starting");
      callbacks.onEvent({
        name: "browser.challenge",
        component: "browser",
        code: "ERR_BROWSER_VERIFICATION_REQUIRED",
        remediationCommand: "npm run browser:verify",
      });
      return {
        fetch: async () => {},
        close: async () => {},
      };
    },
    exchangeRateServiceFactory: (_config, callbacks) => {
      callbacks.onRefresh({
        ...exchangeSnapshot,
        effectiveDate: "2026-07-25",
      });
      callbacks.onFetchError(new Error("temporary CBA failure"), undefined);
      callbacks.onRetry({ component: "cba", attempt: 1 });
      return {
        currentSnapshot: () => exchangeSnapshot,
      };
    },
    preflight: async (_config, callbacks) => {
      callbacks.onRetry({ component: "telegram", attempt: 1 });
      callbacks.onSourceIntegrityChecked({
        pages: [
          {
            page: 1,
            candidateCount: 2,
            uniqueCandidateCount: 2,
            parsedCount: 2,
            duplicateCount: 0,
            rejectedCount: 0,
            completeness: {
              title: 2,
              date: 2,
              price: 2,
              location: 2,
              rooms: 2,
              areaSqM: 2,
              floor: 2,
            },
          },
        ],
      });
      return {
        status: "ready",
        ready: true,
        checks: {
          storage: "passed",
          telegram: "passed",
          browser: "passed",
          list_am: "passed",
          exchange_rates: "passed",
        },
      };
    },
    runBot: async (_config, callbacks) => {
      callbacks.onPrivateAccessState({
        accessMode: "owner",
        persistedUserCount: 2,
        authorizedUserCount: 1,
        suspendedUserCount: 1,
        activeUserCount: 1,
      });
      callbacks.onPrivateAccessDenied({
        accessMode: "owner",
        reason: "not_authorized",
      });
      callbacks.onPrivateUserRateLimited({ updatesPerMinute: 5 });
      callbacks.onPrivateUserDeletionPending();
      callbacks.onPrivateUserDeletionCancelled();
      callbacks.onPrivateUserDeletionCompleted({ recovered: true });
      callbacks.onMonitoringState({
        active: false,
        channelConfigured: true,
      });
      callbacks.onPrivateMonitoringChanged({
        active: true,
        activeUserCount: 1,
        sendInitialApartments: false,
      });
      callbacks.onError(
        new ListAmSourceIntegrityError(
          ListAmIntegrityReason.IDENTITY_REJECTION,
          {
            page: 1,
            diagnostics: {
              apartments: [{ title: "must-not-leak" }],
              candidateCount: 1,
              uniqueCandidateCount: 0,
              parsedCount: 0,
              duplicateCount: 0,
              rejectedCount: 1,
              completeness: {
                title: 0,
                date: 0,
                price: 0,
                location: 0,
                rooms: 0,
                areaSqM: 0,
                floor: 0,
              },
            },
          },
        ),
        { component: "list_am", crawlFailure: true, crawlId: "safe-crawl" },
      );
      callbacks.onSourceIntegrityChecked({
        crawlId: "safe-crawl",
        pages: [
          {
            page: 1,
            candidateCount: 1,
            uniqueCandidateCount: 1,
            parsedCount: 1,
            duplicateCount: 0,
            rejectedCount: 0,
            completeness: {
              title: 1,
              date: 1,
              price: 1,
              location: 1,
              rooms: 1,
              areaSqM: 1,
              floor: 1,
            },
          },
        ],
      });
      callbacks.onResult({
        crawlId: "69a3b980-24ce-494b-a1e5-cdb4ff9dc659",
        durationMs: 1_234,
        status: "unchanged",
        pagesParsed: 1,
        discoveredCount: 0,
        updatedCount: 0,
        notifiedCount: 0,
        skippedCount: 0,
        filteredCount: 0,
        totalCount: 0,
        channel: {
          sentCount: 0,
          editedCount: 0,
          filteredCount: 0,
          skippedCount: 0,
        },
      });
      callbacks.onError(
        Object.assign(new Error("channel forbidden"), { terminal: true }),
        { component: "telegram-channel" },
      );
      callbacks.onError(
        Object.assign(new Error("bot token rejected"), { terminal: true }),
        { component: "telegram", crawlFailure: true },
      );
      callbacks.onError(
        Object.assign(new Error("challenge"), {
          code: "ERR_BROWSER_VERIFICATION_REQUIRED",
        }),
      );
      callbacks.onTelegramSuccess();
      callbacks.onChannelOperation({
        operation: "edit",
        itemId: "listing-1",
        channelId: "@rentals",
        messageId: 10,
        outcome: "failed",
        error: Object.assign(new Error("edit failed"), {
          code: "ERR_TELEGRAM_API",
        }),
      });
      callbacks.onChannelOperation({
        operation: "send",
        itemId: "listing-2",
        channelId: "@rentals",
        outcome: "sent",
        crawlId: "69a3b980-24ce-494b-a1e5-cdb4ff9dc659",
        durationMs: 12,
      });
      callbacks.onChannelFilterFingerprintChange({
        previous: "old",
        current: "new",
      });
      callbacks.onRetry({ component: "list_am", attempt: 2 });
      signalEmitter.emit("SIGTERM");
    },
  });

  const health = monitor.readiness();
  assert.equal(health.ready, true);
  assert.equal(health.monitoring.channelConfigured, true);
  assert.equal(health.monitoring.lastSuccessAt, "2026-07-25T10:00:00.000Z");
  assert.equal(health.exchangeRates.fetchedAt, exchangeSnapshot.fetchedAt);
  assert.deepEqual(health.privateAccess, {
    accessMode: "owner",
    persistedUserCount: 2,
    authorizedUserCount: 1,
    suspendedUserCount: 1,
    activeUserCount: 1,
  });
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
  assert.ok(
    infoRecords.some(
      ({ message, context }) =>
        message === "Graceful shutdown completed" &&
        context.signal === "SIGTERM",
    ),
  );
  assert.deepEqual(
    infoRecords
      .filter(({ context }) => context?.event?.includes("private.deletion"))
      .map(({ context }) => context),
    [
      { event: "telegram.private.deletion.pending" },
      { event: "telegram.private.deletion.cancelled" },
      { event: "telegram.private.deletion.completed", recovered: true },
    ],
  );
  assert.ok(
    infoRecords.some(
      ({ context }) =>
        context?.event === "telegram.access.denied" &&
        context.accessMode === "owner" &&
        context.reason === "not_authorized" &&
        Object.keys(context).length === 3,
    ),
  );
  assert.ok(
    infoRecords.some(
      ({ context }) =>
        context?.event === "telegram.user.rate_limited" &&
        context.updatesPerMinute === 5 &&
        Object.keys(context).length === 2,
    ),
  );
  assert.ok(
    infoRecords.some(
      ({ context }) =>
        context?.event === "telegram.private.access.changed" &&
        context.persistedUserCount === 2 &&
        JSON.stringify(context).includes("42") === false,
    ),
  );
  assert.ok(
    infoRecords.some(
      ({ context }) =>
        context?.event === "telegram.private.monitoring.changed" &&
        context.active === true &&
        context.activeUserCount === 1 &&
        context.sendInitialApartments === false,
    ),
  );
  assert.ok(
    warningRecords.some(({ context }) => context?.event === "retry.scheduled"),
  );
  assert.ok(
    errorRecords.some(
      ({ message }) => message === "Telegram channel publication failed",
    ),
  );
  assert.ok(
    errorRecords.some(
      ({ context }) =>
        context?.event === "source.integrity.failed" &&
        context.reason === "IDENTITY_REJECTION" &&
        JSON.stringify(context).includes("must-not-leak") === false,
    ),
  );
  assert.ok(
    infoRecords.some(
      ({ context }) =>
        context?.event === "source.integrity.checked" &&
        context.phase === "runtime" &&
        context.crawlId === "safe-crawl" &&
        context.parsedCount === 1,
    ),
  );
  assert.ok(
    infoRecords.some(
      ({ context }) =>
        context?.event === "source.integrity.checked" &&
        context.phase === "preflight" &&
        context.page === 1 &&
        context.parsedCount === 2,
    ),
  );
  const channelOperationRecords = [...infoRecords, ...errorRecords].filter(
    ({ message }) => message.startsWith("Telegram channel operation"),
  );
  assert.equal(channelOperationRecords.length, 2);
  assert.equal(
    JSON.stringify(channelOperationRecords).includes("listing-"),
    false,
  );
  assert.equal(
    JSON.stringify(channelOperationRecords).includes("@rentals"),
    false,
  );
  assert.equal(
    JSON.stringify(channelOperationRecords).includes("messageId"),
    false,
  );
  assert.deepEqual(
    infoRecords.find(({ context }) => context?.event === "crawl.succeeded")
      .context,
    {
      event: "crawl.succeeded",
      crawlId: "69a3b980-24ce-494b-a1e5-cdb4ff9dc659",
      durationMs: 1_234,
      duration: 1_234,
      pages: 1,
      discovered: 0,
      updated: 0,
      notified: 0,
      filtered: 0,
      channelSent: 0,
      channelEdited: 0,
      total: 0,
      status: "unchanged",
      pagesParsed: 1,
      discoveredCount: 0,
      updatedCount: 0,
      notifiedCount: 0,
      skippedCount: 0,
      filteredCount: 0,
      totalCount: 0,
      lastKnownDate: undefined,
      stoppedAtKnownDate: undefined,
      channelSentCount: 0,
      channelEditedCount: 0,
      channelFilteredCount: 0,
      channelSkippedCount: 0,
    },
  );
});
