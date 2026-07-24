import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";

import {
  classifyRuntimeFailure,
  HealthMonitor,
  startHealthServer,
} from "../src/health.js";
import { isApplicationCommand, probeLiveness } from "../src/health-check.js";

const readyPreflight = {
  status: "ready",
  ready: true,
  checks: {
    storage: "passed",
    state: "passed",
    singleton: "passed",
    telegram: "passed",
    channel: "skipped",
    browser: "passed",
    list_am: "passed",
    exchange_rates: "passed",
  },
};

function snapshot(fetchedAt) {
  return {
    version: 1,
    type: "cba-exchange-rates",
    fetchedAt,
  };
}

function getJson({ host, port, path }) {
  return new Promise((resolve, reject) => {
    const probe = request({ host, port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          statusCode: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }),
      );
    });
    probe.once("error", reject);
    probe.end();
  });
}

test("runtime failures use stable stage and error codes", () => {
  assert.equal(
    classifyRuntimeFailure(new Error("CBA appeared in untrusted text"), {
      component: "list_am",
    }),
    "list_am",
  );
  assert.equal(
    classifyRuntimeFailure(new Error("request failed"), { component: "cba" }),
    "cba",
  );
  assert.equal(
    classifyRuntimeFailure(
      Object.assign(new Error("rates unavailable"), {
        code: "ERR_PREFLIGHT_EXCHANGE_RATES",
      }),
    ),
    "cba",
  );
  assert.equal(
    classifyRuntimeFailure(
      Object.assign(new Error("write failed"), {
        code: "ENOSPC",
      }),
    ),
    "storage",
  );
  assert.equal(
    classifyRuntimeFailure(
      Object.assign(new Error("delivery failed"), {
        code: "ERR_TELEGRAM_API",
      }),
      { component: "list_am" },
    ),
    "telegram",
  );
  assert.equal(
    classifyRuntimeFailure(
      Object.assign(new Error("challenge"), {
        code: "ERR_BROWSER_VERIFICATION_REQUIRED",
      }),
    ),
    "browser_challenge",
  );
});

test("liveness supervision targets the application, not the probe process", () => {
  assert.equal(isApplicationCommand("node\0src/index.js\0"), true);
  assert.equal(isApplicationCommand("node\0/app/src/health-check.js\0"), false);
});

test("liveness probe accepts only a responsive success status", async (t) => {
  let statusCode = 200;
  let shouldRespond = true;
  const server = createServer((_request, response) => {
    if (!shouldRespond) return;
    response.writeHead(statusCode);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const probeOptions = {
    host: "127.0.0.1",
    port: address.port,
    // Leave enough headroom for architecture-emulated CI while keeping the
    // explicit non-responsive assertion below intentionally short.
    timeoutMs: 2_000,
  };
  const originalHost = process.env.HEALTH_HOST;
  const originalPort = process.env.HEALTH_PORT;
  process.env.HEALTH_HOST = probeOptions.host;
  process.env.HEALTH_PORT = String(probeOptions.port);
  t.after(() => {
    if (originalHost === undefined) delete process.env.HEALTH_HOST;
    else process.env.HEALTH_HOST = originalHost;
    if (originalPort === undefined) delete process.env.HEALTH_PORT;
    else process.env.HEALTH_PORT = originalPort;
  });

  await probeLiveness({ timeoutMs: probeOptions.timeoutMs });
  statusCode = 503;
  await assert.rejects(
    probeLiveness(probeOptions),
    /Liveness probe returned 503/u,
  );
  shouldRespond = false;
  await assert.rejects(
    probeLiveness({ ...probeOptions, timeoutMs: 10 }),
    /Liveness probe timed out/u,
  );
});

test("readiness enforces crawl failure and elapsed-time thresholds", () => {
  let currentTime = new Date("2026-07-25T10:00:00.000Z");
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => currentTime,
  });
  monitor.setConfigurationValid();
  monitor.setPreflight(readyPreflight);
  monitor.recordExchangeRateSnapshot(snapshot(currentTime.toISOString()));
  monitor.setMonitoringState({ active: true, channelConfigured: false });

  assert.deepEqual(monitor.readiness().reasons, ["CRAWL_NEVER_SUCCEEDED"]);
  monitor.recordCrawlSuccess();
  assert.equal(monitor.readiness().ready, true);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    monitor.recordCrawlFailure("list_am", "ERR_LIST_AM");
    assert.equal(monitor.readiness().ready, true);
  }
  monitor.recordCrawlFailure("list_am", "ERR_LIST_AM");
  assert.deepEqual(monitor.readiness().reasons, ["CRAWL_FAILURE_THRESHOLD"]);

  monitor.recordCrawlSuccess();
  currentTime = new Date("2026-07-25T10:10:00.000Z");
  assert.deepEqual(monitor.readiness().reasons, ["CRAWL_STALE"]);
});

test("health transitions emit each production alert once until resolved", () => {
  const alerts = [];
  let currentTime = new Date("2026-07-25T10:00:00.000Z");
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => currentTime,
    onAlert: (alert) => alerts.push(alert),
  });
  monitor.setPreflight(readyPreflight);
  monitor.recordExchangeRateSnapshot(snapshot(currentTime.toISOString()));
  monitor.setMonitoringState({ active: true, channelConfigured: false });
  monitor.recordCrawlSuccess();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    monitor.recordCrawlFailure("list_am", "ERR_LIST_AM");
  }
  monitor.readiness();
  monitor.readiness();
  assert.equal(
    alerts.filter(
      ({ name, status }) =>
        name === "five_consecutive_crawl_failures" && status === "firing",
    ).length,
    1,
  );
  assert.equal(
    alerts.filter(
      ({ name, status }) => name === "readiness_failure" && status === "firing",
    ).length,
    1,
  );

  monitor.recordCrawlSuccess();
  monitor.readiness();
  assert.ok(
    alerts.some(
      ({ name, status }) =>
        name === "five_consecutive_crawl_failures" && status === "resolved",
    ),
  );

  currentTime = new Date("2026-07-27T10:00:00.001Z");
  monitor.readiness();
  assert.ok(
    alerts.some(
      ({ name, status }) =>
        name === "stale_exchange_rates" && status === "firing",
    ),
  );
});

test("readiness reports challenges and exchange-rate availability without leaking data", () => {
  let currentTime = new Date("2026-07-25T10:00:00.000Z");
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => currentTime,
  });
  monitor.setPreflight(readyPreflight);
  monitor.setMonitoringState({ active: false, channelConfigured: true });
  monitor.recordCrawlSuccess();

  assert.deepEqual(monitor.readiness().reasons, ["EXCHANGE_RATES_UNAVAILABLE"]);
  monitor.recordExchangeRateSnapshot(snapshot(currentTime.toISOString()));
  monitor.recordCrawlFailure(
    "browser_challenge",
    "ERR_BROWSER_VERIFICATION_REQUIRED",
  );
  assert.ok(
    monitor.readiness().reasons.includes("BROWSER_VERIFICATION_REQUIRED"),
  );
  assert.equal(monitor.readiness().components.browser.status, "challenge");

  monitor.setPreflight(readyPreflight);
  monitor.recordCrawlSuccess();
  currentTime = new Date("2026-07-27T10:00:00.001Z");
  const stale = monitor.readiness();
  assert.equal(stale.ready, false);
  assert.deepEqual(stale.warnings, ["EXCHANGE_RATES_STALE"]);
  assert.equal(stale.components.cba.status, "warning");
  assert.equal(JSON.stringify(stale).includes("ownerId"), false);
});

test("loopback server separates responsive liveness from readiness", async (t) => {
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => new Date("2026-07-25T10:00:00.000Z"),
  });
  const server = await startHealthServer(monitor, {
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => server.close());

  const address = {
    host: "127.0.0.1",
    port: server.address.port,
  };
  const live = await getJson({ ...address, path: "/live" });
  assert.equal(live.statusCode, 200);
  assert.equal(live.body.status, "live");
  assert.equal(live.body.version, "1.0.0");

  const unready = await getJson({ ...address, path: "/ready" });
  assert.equal(unready.statusCode, 503);
  assert.deepEqual(unready.body.reasons, ["PREFLIGHT_INCOMPLETE"]);

  monitor.setPreflight(readyPreflight);
  const ready = await getJson({ ...address, path: "/health" });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.ready, true);
  assert.doesNotMatch(
    JSON.stringify(ready.body),
    /credential|owner|apartment|stack/iu,
  );
});
