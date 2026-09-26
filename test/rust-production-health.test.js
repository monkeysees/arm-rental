import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { HealthMonitor } from "../src/health.js";
const binary = process.env.RENTAL_APP_BINARY;
const start = Date.parse("2026-09-26T12:00:00.000Z");
function compare(events) {
  let now = start;
  const alerts = [];
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => new Date(now),
    onAlert: (a) => alerts.push(a),
  });
  const observations = [];
  for (const event of events) {
    now = event.at ?? now;
    const args = event.args ?? [];
    const input = args.map((v, index) =>
      index === 0 &&
      ["recordCrawlSuccess", "recordSourceIntegritySuccess"].includes(
        event.method,
      )
        ? new Date(v)
        : v,
    );
    monitor[event.method](...input);
    observations.push(monitor.readiness());
  }
  const expected = { observations, alerts, liveness: monitor.liveness() };
  const result = spawnSync(binary, ["contract"], {
    input:
      JSON.stringify({
        op: "health",
        version: "1.0.0",
        startedMs: start,
        events,
      }) + "\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
}
test(
  "native readiness and deduplicated alert transitions match the Node oracle",
  { skip: !binary },
  () => {
    const ready = {
      ready: true,
      checks: {
        configuration: "passed",
        state: "passed",
        telegram: "passed",
        source_transport: "passed",
        list_am: "passed",
        exchange_rates: "passed",
        channel: "skipped",
      },
    };
    compare([
      { method: "setConfigurationValid" },
      { method: "setPreflight", args: [ready] },
      {
        method: "setMonitoringState",
        args: [{ active: true, channelConfigured: false }],
      },
      {
        method: "recordExchangeRateSnapshot",
        args: [{ fetchedAt: new Date(start).toISOString() }],
      },
      { method: "recordCrawlSuccess" },
      ...Array.from({ length: 5 }, (_, i) => ({
        method: "recordCrawlFailure",
        args: ["list_am_challenge"],
        at: start + (i + 1) * 1000,
      })),
      { method: "recordSourceIntegritySuccess" },
      { method: "recordCrawlSuccess" },
      {
        method: "recordComponentSuccess",
        args: ["telegram"],
        at: start + 600000,
      },
      {
        method: "setMonitoringState",
        args: [{ active: false, channelConfigured: false }],
      },
      {
        method: "recordComponentSuccess",
        args: ["cba"],
        at: start + 48 * 3600000 + 1,
      },
    ]);
  },
);

test(
  "native health preserves preflight recovery, safe codes and aggregate access counts",
  { skip: !binary },
  () => {
    compare([
      {
        method: "setConfigurationFailure",
        args: ["secret token:do-not-expose"],
      },
      {
        method: "setPreflight",
        args: [
          {
            status: "source_challenge",
            checks: {
              configuration: "passed",
              state: "passed",
              telegram: "passed",
              source_transport: "passed",
              list_am: "source_challenge",
              exchange_rates: "not_run",
            },
            failure: {
              component: "list_am",
              code: "ERR_LIST_AM_CHALLENGE",
              message: "secret",
            },
          },
        ],
      },
      {
        method: "setPrivateAccessState",
        args: [
          {
            accessMode: "allowlist",
            persistedUserCount: 3,
            authorizedUserCount: 2,
            suspendedUserCount: 1,
            activeUserCount: 1,
            userIds: ["secret"],
            allowlist: [123],
          },
        ],
      },
      {
        method: "setPreflight",
        args: [
          {
            status: "failed",
            failure: {
              component: "list_am",
              code: "ERR_LIST_AM_SOURCE_INTEGRITY",
            },
          },
        ],
      },
      {
        method: "setPreflight",
        args: [
          {
            ready: true,
            checks: {
              configuration: "passed",
              state: "passed",
              telegram: "passed",
              source_transport: "passed",
              list_am: "passed",
              exchange_rates: "passed",
              channel: "skipped",
            },
          },
        ],
      },
      { method: "recordSourceIntegritySuccess" },
      {
        method: "recordComponentFailure",
        args: ["telegram", "ERR_TELEGRAM_CREDENTIALS"],
      },
      {
        method: "recordComponentFailure",
        args: ["telegram", "ERR_TELEGRAM_CHANNEL_PERMISSIONS"],
      },
      { method: "recordComponentSuccess", args: ["telegram"] },
      {
        method: "recordExchangeRateFailure",
        args: [{ fetchedAt: new Date(start).toISOString() }],
      },
      { method: "recordExchangeRateFailure", args: [{}] },
      {
        method: "recordComponentFailure",
        args: ["storage", "bad-code secret", { warning: true }],
      },
      {
        method: "setPrivateAccessState",
        args: [
          {
            accessMode: "bad",
            persistedUserCount: -1,
            authorizedUserCount: 0.5,
            suspendedUserCount: 9007199254740992,
            activeUserCount: 2,
          },
        ],
      },
    ]);
  },
);

test(
  "native health applies exact crawl and rate-age boundaries",
  { skip: !binary },
  () => {
    compare([
      { method: "setPreflight", args: [{ ready: true }] },
      {
        method: "setMonitoringState",
        args: [{ active: false, channelConfigured: true }],
      },
      {
        method: "recordExchangeRateSnapshot",
        args: [{ fetchedAt: new Date(start).toISOString() }],
      },
      { method: "recordCrawlSuccess" },
      { method: "readiness", at: start + 599999 },
      { method: "readiness", at: start + 600000 },
      { method: "recordCrawlSuccess" },
      { method: "readiness", at: start + 48 * 3600000 },
      { method: "readiness", at: start + 48 * 3600000 + 1 },
      {
        method: "recordExchangeRateSnapshot",
        args: [{ fetchedAt: new Date(start + 48 * 3600000 + 1).toISOString() }],
      },
      { method: "recordCrawlSuccess" },
    ]);
  },
);
