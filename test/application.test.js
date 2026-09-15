import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runApplication } from "../src/application.js";
import {
  ListAmChallengeError,
  ListAmTransportError,
} from "../src/list-am-http.js";
import { HealthMonitor } from "../src/health.js";
import {
  ListAmIntegrityReason,
  ListAmSourceIntegrityError,
} from "../src/source-integrity.js";
import { createMemoryStateAccess } from "../test-support/memory-state.js";

/** Stands in for the opened SQLite backend these lifecycle tests do not own. */
function stateBackendFactory() {
  return {
    stateAccess: createMemoryStateAccess({}),
    close: () => {},
  };
}

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
      sourceFetcherFactory: () => {
        calls.push("source");
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

test("page challenges and transport failures reach the crawl loop without immediate retries", async () => {
  for (const error of [
    new ListAmChallengeError(403, "edge"),
    new ListAmTransportError("request timed out"),
  ]) {
    let fetchAttempts = 0;
    const events = [];
    const warnings = [];
    await runApplication({
      config: { dataDirectory: "/data" },
      logger: {
        info: () => {},
        warn: (message, context) => warnings.push({ message, context }),
        error: () => {},
      },
      validateConfig: async () => {},
      stateBackendFactory,
      acquireLock: async () => ({
        dataDirectory: "/data",
        owner: { pid: 42 },
        release: async () => events.push("released"),
      }),
      sourceFetcherFactory: (_config, callbacks) => ({
        fetch: async () => {
          fetchAttempts += 1;
          if (error.code === "ERR_LIST_AM_CHALLENGE")
            callbacks.onEvent({
              name: "list_am.challenge",
              component: "list_am",
              code: error.code,
              httpStatus: 403,
              challengeSource: "edge",
            });
          throw error;
        },
        close: async () => events.push("closed"),
      }),
      exchangeRateServiceFactory: () => ({}),
      preflight: async () => ({ status: "ready", ready: true, checks: {} }),
      runBot: async (_config, callbacks) => {
        await assert.rejects(
          callbacks.pageFetch("https://www.list.am/"),
          (actual) => actual === error,
        );
        assert.equal(fetchAttempts, 1);
      },
    });
    assert.deepEqual(events, ["closed", "released"]);
    assert.equal(
      warnings.some(({ context }) => context.event === "retry.scheduled"),
      false,
    );
    if (error.code === "ERR_LIST_AM_CHALLENGE")
      assert.deepEqual(warnings, [
        {
          message: "List.am challenge detected",
          context: {
            event: "list_am.challenge",
            component: "list_am",
            code: error.code,
            httpStatus: 403,
            challengeSource: "edge",
          },
        },
      ]);
  }
});

test("transport shutdown failure still closes state and releases the lease", async () => {
  const events = [];
  const failure = new Error("transport shutdown failed");
  await assert.rejects(
    runApplication({
      config: { dataDirectory: "/data" },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      validateConfig: async () => {},
      stateBackendFactory: () => ({
        ...stateBackendFactory(),
        close: () => events.push("state:closed"),
      }),
      acquireLock: async () => ({
        dataDirectory: "/data",
        owner: { pid: 42 },
        release: async () => events.push("lease:released"),
      }),
      sourceFetcherFactory: () => ({
        close: async () => {
          events.push("source:close");
          throw failure;
        },
      }),
      exchangeRateServiceFactory: () => ({}),
      preflight: async () => ({ status: "ready", ready: true, checks: {} }),
      runBot: async () => events.push("bot"),
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, [
    "bot",
    "source:close",
    "state:closed",
    "lease:released",
  ]);
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
    stateBackendFactory,
    acquireLock: async () => ({
      dataDirectory: "/data",
      owner: { pid: 42 },
      release: async () => {},
    }),
    sourceFetcherFactory: (_config, callbacks) => {
      callbacks.onEvent({
        name: "list_am.challenge",
        component: "list_am",
        code: "ERR_LIST_AM_CHALLENGE",
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
          source_transport: "passed",
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
          code: "ERR_LIST_AM_CHALLENGE",
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
      readmitted: 0,
      channelSent: 0,
      channelEdited: 0,
      channelReadmitted: 0,
      total: 0,
      status: "unchanged",
      pagesParsed: 1,
      discoveredCount: 0,
      updatedCount: 0,
      notifiedCount: 0,
      skippedCount: 0,
      filteredCount: 0,
      readmittedCount: 0,
      totalCount: 0,
      sources: undefined,
      channelSentCount: 0,
      channelEditedCount: 0,
      channelFilteredCount: 0,
      channelSkippedCount: 0,
      channelReadmittedCount: 0,
    },
  );
});

test("startup source failures publish readiness before cooling down for supervisor retry", async () => {
  for (const scenario of [
    {
      component: "list_am",
      terminal: false,
      retryAfterMs: undefined,
      expected: 60_000,
    },
    {
      component: "list_am",
      terminal: false,
      retryAfterMs: 120_000,
      expected: 120_000,
    },
    { component: "source_transport", terminal: true, expected: undefined },
    { component: "telegram", terminal: true, expected: undefined },
    { component: "state", terminal: true, expected: undefined },
  ]) {
    const events = [];
    const failure = Object.assign(new Error("startup failed"), {
      retryAfterMs: scenario.retryAfterMs,
      preflightResult: {
        ready: false,
        status: "failed",
        terminal: scenario.terminal,
        failure: { component: scenario.component },
      },
    });
    await assert.rejects(
      runApplication({
        config: { dataDirectory: "/data" },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        healthMonitor: {
          setConfigurationValid: () => {},
          setPreflight: () => events.push("not-ready"),
        },
        validateConfig: async () => {},
        stateBackendFactory,
        acquireLock: async () => ({
          dataDirectory: "/data",
          owner: { pid: 42 },
          release: async () => events.push("released"),
        }),
        sourceFetcherFactory: () => ({
          close: async () => events.push("closed"),
        }),
        exchangeRateServiceFactory: () => ({}),
        preflight: async () => {
          throw failure;
        },
        sleep: async (milliseconds) => events.push(milliseconds),
        runBot: async () => assert.fail("polling must not start"),
      }),
      (error) => error === failure,
    );
    assert.deepEqual(events, [
      "not-ready",
      ...(scenario.expected === undefined ? [] : [scenario.expected]),
      "closed",
      "released",
    ]);
  }
});

test("SIGTERM interrupts startup cooldown and still releases resources", async () => {
  const signalEmitter = new EventEmitter();
  const events = [];
  const failure = Object.assign(new Error("challenge"), {
    preflightResult: {
      ready: false,
      status: "source_challenge",
      terminal: false,
      failure: { component: "list_am" },
    },
  });
  await assert.rejects(
    runApplication({
      config: { dataDirectory: "/data", pollIntervalMs: 75_000 },
      signalEmitter,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      validateConfig: async () => {},
      stateBackendFactory,
      acquireLock: async () => ({
        dataDirectory: "/data",
        owner: { pid: 42 },
        release: async () => events.push("released"),
      }),
      sourceFetcherFactory: () => ({
        close: async () => events.push("closed"),
      }),
      exchangeRateServiceFactory: () => ({}),
      preflight: async () => {
        throw failure;
      },
      sleep: async (milliseconds, _value, { signal }) => {
        assert.equal(milliseconds, 75_000);
        assert.equal(signal.aborted, false);
        signalEmitter.emit("SIGTERM");
        assert.equal(signal.aborted, true);
        throw new DOMException("aborted", "AbortError");
      },
      runBot: async () => assert.fail("polling must not start"),
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["closed", "released"]);
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
});
