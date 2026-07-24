import assert from "node:assert/strict";
import test from "node:test";

import { runApplication } from "../src/application.js";
import { HealthMonitor } from "../src/health.js";

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
  const logger = {
    info: (message, context) => infoRecords.push({ message, context }),
    warn: () => {},
    error: () => {},
  };

  await runApplication({
    config: {
      dataDirectory: "/data",
      telegramChannelId: "@rentals",
    },
    logger,
    healthMonitor: monitor,
    validateConfig: async () => {},
    acquireLock: async () => ({
      dataDirectory: "/data",
      owner: { pid: 42 },
      release: async () => {},
    }),
    browserFetcherFactory: () => ({
      fetch: async () => {},
      close: async () => {},
    }),
    exchangeRateServiceFactory: () => ({
      currentSnapshot: () => exchangeSnapshot,
    }),
    preflight: async () => ({
      status: "ready",
      ready: true,
      checks: {
        storage: "passed",
        telegram: "passed",
        browser: "passed",
        list_am: "passed",
        exchange_rates: "passed",
      },
    }),
    runBot: async (_config, callbacks) => {
      callbacks.onMonitoringState({
        active: false,
        channelConfigured: true,
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
    },
  });

  const health = monitor.readiness();
  assert.equal(health.ready, true);
  assert.equal(health.monitoring.channelConfigured, true);
  assert.equal(health.monitoring.lastSuccessAt, "2026-07-25T10:00:00.000Z");
  assert.equal(health.exchangeRates.fetchedAt, exchangeSnapshot.fetchedAt);
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
