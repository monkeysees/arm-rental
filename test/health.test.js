import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyRuntimeFailure,
  HealthMonitor,
  startHealthServer,
} from "../src/health.js";
import {
  isApplicationCommand,
  probeLiveness,
  probeReadiness,
  probeReadinessSummary,
  superviseLiveness,
} from "../src/health-check.js";

// The command line captured from production PID 1: the container's minimal
// init passes the application's command through as its own trailing arguments.
const CONTAINER_INIT_COMMAND =
  "/sbin/docker-init\0--\0docker-entrypoint.sh\0node\0src/index.js\0";
const APPLICATION_COMMAND = "node\0src/index.js\0";
// Named by src/health-check.js inside its private state directory.
const FAILURE_COUNTER = "consecutive-liveness-failures";

async function writeProcessTable(root, commandLines) {
  for (const [processId, commandLine] of Object.entries(commandLines)) {
    await mkdir(join(root, processId), { recursive: true });
    await writeFile(join(root, processId, "cmdline"), commandLine);
  }
  // /proc also lists non-numeric entries the walk has to ignore.
  await mkdir(join(root, "self"), { recursive: true });
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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
  assert.equal(isApplicationCommand(APPLICATION_COMMAND), true);
  assert.equal(
    isApplicationCommand(
      "/usr/local/bin/node\0--enable-source-maps\0/app/src/index.js\0",
    ),
    true,
  );
  assert.equal(isApplicationCommand("node\0/app/src/health-check.js\0"), false);
  // PID 1 names the application's script in its own arguments and /proc lists
  // it first, so a predicate that only searches the arguments picks the init
  // the kernel refuses to kill and no restart ever happens.
  assert.equal(isApplicationCommand(CONTAINER_INIT_COMMAND), false);
  assert.equal(
    isApplicationCommand("/bin/sh\0-c\0exec node src/index.js\0"),
    false,
  );
});

test("supervised liveness kills the application only after a sustained run of failures", async (t) => {
  let responsive = true;
  const server = createServer((request, response) => {
    // An unresponsive event loop accepts the connection and never answers,
    // which is the failure the probe times out on in production.
    if (!responsive) return;
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const stateDirectory = await temporaryDirectory(t, "liveness-state-");
  const processTable = await temporaryDirectory(t, "liveness-proc-");
  const application = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { stdio: "ignore" },
  );
  const applicationExit = once(application, "exit");
  t.after(() => application.kill("SIGKILL"));
  await writeProcessTable(processTable, {
    1: CONTAINER_INIT_COMMAND,
    [application.pid]: APPLICATION_COMMAND,
  });

  const supervision = { host: "127.0.0.1", port: server.address().port };
  const failedProbe = () => {
    responsive = false;
    return superviseLiveness({
      ...supervision,
      stateDirectory,
      processTable,
      timeoutMs: 100,
    });
  };
  const successfulProbe = () => {
    responsive = true;
    return superviseLiveness({
      ...supervision,
      stateDirectory,
      processTable,
      // Leave headroom for architecture-emulated CI on the answered probe.
      timeoutMs: 2_000,
    });
  };

  assert.deepEqual(await failedProbe(), {
    live: false,
    failures: 1,
    terminated: false,
  });
  assert.deepEqual(await failedProbe(), {
    live: false,
    failures: 2,
    terminated: false,
  });
  // Docker already reports the container unhealthy here (`retries: 2`), and
  // the application is still running: recovery stays one probe behind the
  // alert so a transient stall is never fatal.
  assert.equal(application.exitCode, null);

  assert.deepEqual(await successfulProbe(), {
    live: true,
    failures: 0,
    terminated: false,
  });
  // A single success ends the run rather than merely pausing it.
  assert.deepEqual(await failedProbe(), {
    live: false,
    failures: 1,
    terminated: false,
  });
  assert.deepEqual(await failedProbe(), {
    live: false,
    failures: 2,
    terminated: false,
  });
  assert.deepEqual(await failedProbe(), {
    live: false,
    failures: 3,
    terminated: true,
  });

  // The signal reached the Node process running the application and not the
  // init listed ahead of it, which a kill of PID 1 could not have achieved.
  const [, signal] = await applicationExit;
  assert.equal(signal, "SIGKILL");
});

test("a process table holding only the container init produces no victim", async (t) => {
  const stateDirectory = await temporaryDirectory(t, "liveness-state-");
  const processTable = await temporaryDirectory(t, "liveness-proc-");
  await writeProcessTable(processTable, { 1: CONTAINER_INIT_COMMAND });
  // Two failures are already recorded, so this probe reaches the threshold and
  // has to choose a target: production's PID 1 is the only candidate, and
  // signalling it would be discarded by the kernel rather than restart
  // anything.
  await writeFile(join(stateDirectory, FAILURE_COUNTER), "2\n");

  await assert.rejects(
    superviseLiveness({
      host: "127.0.0.1",
      port: await unusedLoopbackPort(),
      timeoutMs: 2_000,
      stateDirectory,
      processTable,
    }),
    /Application process was not found/u,
  );
});

test("an untrusted liveness counter is never a reason to kill", async (t) => {
  const stateDirectory = await temporaryDirectory(t, "liveness-counter-");
  const supervision = {
    host: "127.0.0.1",
    port: await unusedLoopbackPort(),
    timeoutMs: 2_000,
  };

  for (const untrusted of ["", "not-a-number", "2 3", "99999999999999999999"]) {
    await writeFile(join(stateDirectory, FAILURE_COUNTER), untrusted);
    // A counter that cannot be believed restarts the run instead of inheriting
    // a length that would bring the next probe to the threshold.
    assert.deepEqual(
      await superviseLiveness({ ...supervision, stateDirectory }),
      {
        live: false,
        failures: 1,
        terminated: false,
      },
    );
  }

  const unwritable = join(stateDirectory, "occupied");
  await writeFile(unwritable, "");
  assert.deepEqual(
    await superviseLiveness({ ...supervision, stateDirectory: unwritable }),
    { live: false, failures: 0, terminated: false },
  );
});

test("liveness probe accepts only a responsive success status", async (t) => {
  let statusCode = 200;
  let shouldRespond = true;
  const requestedPaths = [];
  const server = createServer((request, response) => {
    requestedPaths.push(request.url);
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
  await probeReadiness({ timeoutMs: probeOptions.timeoutMs });
  // Each probe must query its own endpoint. Reporting readiness from /live
  // would call a running-but-unready application ready and silence its alert.
  assert.deepEqual(requestedPaths, ["/live", "/ready"]);

  statusCode = 503;
  await assert.rejects(
    probeLiveness(probeOptions),
    /Probe of \/live returned 503/u,
  );
  // A 503 is exactly how the application reports that it cannot crawl, so the
  // readiness probe has to treat it as a failure rather than a reachable host.
  await assert.rejects(
    probeReadiness(probeOptions),
    /Probe of \/ready returned 503/u,
  );
  shouldRespond = false;
  await assert.rejects(
    probeLiveness({ ...probeOptions, timeoutMs: 10 }),
    /Probe of \/live timed out/u,
  );
});

test("readiness summaries distinguish challenge grace, invalid responses, and timeouts", async (t) => {
  let body = {
    ready: false,
    reasons: ["BROWSER_VERIFICATION_REQUIRED"],
    alertReasons: [],
    privateAccess: { secret: "must not appear" },
  };
  let respond = true;
  const server = createServer((_request, response) => {
    if (!respond) return;
    response.writeHead(503);
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const options = {
    host: "127.0.0.1",
    port: server.address().port,
    timeoutMs: 2000,
  };
  assert.deepEqual(await probeReadinessSummary(options), {
    status: "not_ready",
    reasons: ["BROWSER_VERIFICATION_REQUIRED"],
    alertReasons: [],
  });
  const child = spawn(
    process.execPath,
    [
      new URL("../src/health-check.js", import.meta.url).pathname,
      "--ready",
      "--json",
    ],
    {
      env: {
        ...process.env,
        HEALTH_HOST: options.host,
        HEALTH_PORT: String(options.port),
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(output), await probeReadinessSummary(options));
  assert.doesNotMatch(output, /secret|privateAccess/u);
  body = { ...body, reasons: ["CRAWL_STALE"], alertReasons: ["CRAWL_STALE"] };
  assert.deepEqual((await probeReadinessSummary(options)).alertReasons, [
    "CRAWL_STALE",
  ]);
  body.alertReasons = [];
  assert.deepEqual((await probeReadinessSummary(options)).reasons, [
    "READINESS_RESPONSE_INVALID",
  ]);
  body = {
    ready: false,
    reasons: ["CRAWL_STALE"],
    alertReasons: ["CRAWL_STALE"],
    padding: "x".repeat(20_000),
  };
  assert.deepEqual((await probeReadinessSummary(options)).reasons, [
    "READINESS_RESPONSE_INVALID",
  ]);
  body = { ready: false, reasons: ["secret value"] };
  assert.deepEqual((await probeReadinessSummary(options)).reasons, [
    "READINESS_RESPONSE_INVALID",
  ]);
  respond = false;
  assert.deepEqual(
    (await probeReadinessSummary({ ...options, timeoutMs: 10 })).reasons,
    ["READINESS_PROBE_TIMEOUT"],
  );
});

test("liveness probe rejects malformed canonical health configuration", async () => {
  await assert.rejects(
    probeLiveness({ env: { HEALTH_PORT: "invalid" } }),
    /HEALTH_PORT/u,
  );
  await assert.rejects(
    probeLiveness({ env: { HEALTH_HOST: "0.0.0.0" } }),
    /HEALTH_HOST/u,
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

test("a browser challenge alerts only once it survives five crawls in a row", () => {
  const alerts = [];
  const currentTime = new Date("2026-07-25T10:00:00.000Z");
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => currentTime,
    onAlert: (alert) => alerts.push(alert),
  });
  monitor.setPreflight(readyPreflight);
  monitor.recordExchangeRateSnapshot(snapshot(currentTime.toISOString()));
  monitor.setMonitoringState({ active: true, channelConfigured: false });
  monitor.recordCrawlSuccess();
  const firings = () =>
    alerts.filter(
      ({ name, status }) => name === "browser_challenge" && status === "firing",
    );

  // Four challenged crawls in a row stay silent, and so does the fetch-level
  // challenge that the retry answers before the crawl completes.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    monitor.recordCrawlFailure(
      "browser_challenge",
      "ERR_BROWSER_VERIFICATION_REQUIRED",
    );
  }
  monitor.recordBrowserChallenge();
  assert.deepEqual(monitor.readiness().alertReasons, []);
  monitor.recordCrawlSuccess();
  assert.deepEqual(firings(), []);

  // A challenge seen several times inside one crawl is still one crawl, so the
  // streak counts crawls rather than page fetches.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    monitor.recordBrowserChallenge();
    monitor.recordBrowserChallenge();
    monitor.recordCrawlFailure("list_am", "ERR_LIST_AM");
  }
  assert.deepEqual(firings(), []);

  monitor.recordCrawlFailure(
    "browser_challenge",
    "ERR_BROWSER_VERIFICATION_REQUIRED",
  );
  assert.deepEqual(firings(), [
    {
      name: "browser_challenge",
      status: "firing",
      reason: "BROWSER_VERIFICATION_REQUIRED",
      consecutiveCrawls: 5,
    },
  ]);

  // The complete crawl clears the streak, so the next challenge starts over.
  monitor.recordCrawlSuccess();
  monitor.recordCrawlFailure(
    "browser_challenge",
    "ERR_BROWSER_VERIFICATION_REQUIRED",
  );
  assert.equal(firings().length, 1);
  assert.deepEqual(
    alerts.filter(({ name }) => name === "browser_challenge").at(-1),
    {
      name: "browser_challenge",
      status: "resolved",
      reason: "BROWSER_VERIFICATION_REQUIRED",
    },
  );
});

test("readiness probes do not bypass the runtime challenge alert threshold", () => {
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

  monitor.recordBrowserChallenge();
  assert.deepEqual(monitor.readiness().reasons, [
    "BROWSER_VERIFICATION_REQUIRED",
  ]);
  currentTime = new Date("2026-07-25T10:00:09.000Z");
  monitor.recordCrawlSuccess();
  assert.equal(monitor.readiness().ready, true);
  assert.deepEqual(
    alerts,
    [],
    "a nine-second challenge must send neither edge",
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    monitor.recordCrawlFailure("browser_challenge");
    assert.equal(monitor.readiness().ready, false);
  }
  assert.deepEqual(alerts, []);
  monitor.recordCrawlFailure("browser_challenge");
  assert.deepEqual(monitor.readiness().alertReasons, [
    "BROWSER_VERIFICATION_REQUIRED",
    "CRAWL_FAILURE_THRESHOLD",
  ]);
  assert.deepEqual(
    alerts.find(({ name }) => name === "readiness_failure")?.reasons,
    ["BROWSER_VERIFICATION_REQUIRED", "CRAWL_FAILURE_THRESHOLD"],
  );

  monitor.recordCrawlSuccess();
  monitor.readiness();
  assert.deepEqual(
    alerts
      .filter(({ name }) => name === "readiness_failure")
      .map(({ status }) => status),
    ["firing", "resolved"],
  );
  alerts.length = 0;
  monitor.recordBrowserChallenge();
  currentTime = new Date("2026-07-25T10:10:09.000Z");
  monitor.readiness();
  assert.deepEqual(alerts, [
    {
      name: "readiness_failure",
      status: "firing",
      reasons: ["CRAWL_STALE"],
    },
  ]);
});

test("a preflight challenge alerts on sight because no crawl can clear it", () => {
  const alerts = [];
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => new Date("2026-07-25T10:00:00.000Z"),
    onAlert: (alert) => alerts.push(alert),
  });
  monitor.setPreflight({
    status: "browser_verification_required",
    ready: false,
    checks: {
      ...readyPreflight.checks,
      browser: "browser_verification_required",
    },
    failure: {
      component: "browser",
      code: "ERR_BROWSER_VERIFICATION_REQUIRED",
    },
  });

  assert.deepEqual(
    alerts.filter(({ name }) => name === "browser_challenge"),
    [
      {
        name: "browser_challenge",
        status: "firing",
        reason: "BROWSER_VERIFICATION_REQUIRED",
      },
    ],
  );
  assert.equal(monitor.readiness().components.browser.status, "challenge");
});

test("source integrity fails readiness immediately and resolves on a valid observation", () => {
  const alerts = [];
  const now = () => new Date("2026-07-25T10:00:00.000Z");
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now,
    onAlert: (alert) => alerts.push(alert),
  });
  monitor.setPreflight(readyPreflight);
  monitor.recordExchangeRateSnapshot(snapshot(now().toISOString()));
  monitor.setMonitoringState({ active: true, channelConfigured: false });
  monitor.recordCrawlSuccess();

  monitor.recordCrawlFailure("list_am", "ERR_LIST_AM_SOURCE_INTEGRITY");
  assert.ok(monitor.readiness().reasons.includes("LIST_AM_SOURCE_INTEGRITY"));
  assert.equal(
    alerts.filter(
      ({ name, status }) =>
        name === "list_am_source_integrity" && status === "firing",
    ).length,
    1,
  );

  monitor.recordSourceIntegritySuccess();
  monitor.recordCrawlFailure("telegram", "ERR_TELEGRAM_API");
  assert.equal(
    monitor.readiness().reasons.includes("LIST_AM_SOURCE_INTEGRITY"),
    false,
  );
  assert.equal(monitor.readiness().components.list_am.status, "ok");
  assert.ok(
    alerts.some(
      ({ name, status }) =>
        name === "list_am_source_integrity" && status === "resolved",
    ),
  );
});

test("preflight source-integrity failure exposes the dedicated safe reason", () => {
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => new Date("2026-07-25T10:00:00.000Z"),
  });
  monitor.setPreflight({
    status: "failed",
    ready: false,
    checks: { list_am: "failed" },
    failure: {
      component: "list_am",
      code: "ERR_LIST_AM_SOURCE_INTEGRITY",
      reason: "IDENTITY_REJECTION",
    },
  });
  const readiness = monitor.readiness();
  assert.ok(readiness.reasons.includes("LIST_AM_SOURCE_INTEGRITY"));
  assert.equal(JSON.stringify(readiness).includes("IDENTITY_REJECTION"), false);
});

test("readiness reports challenges and exchange-rate availability without leaking data", () => {
  const alerts = [];
  let currentTime = new Date("2026-07-25T10:00:00.000Z");
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => currentTime,
    onAlert: (alert) => alerts.push(alert),
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

  monitor.recordCrawlSuccess();
  const recovered = monitor.readiness();
  assert.equal(recovered.ready, true);
  assert.equal(recovered.components.browser.status, "ok");
  // Readiness reports the challenge while it lasts, but a single challenged
  // crawl is below the alert threshold and stays off the owner's phone.
  assert.deepEqual(
    alerts.filter(({ name }) => name === "browser_challenge"),
    [],
  );

  currentTime = new Date("2026-07-27T10:00:00.001Z");
  const stale = monitor.readiness();
  assert.equal(stale.ready, false);
  assert.deepEqual(stale.warnings, ["EXCHANGE_RATES_STALE"]);
  assert.equal(stale.components.cba.status, "warning");
  assert.equal(JSON.stringify(stale).includes("ownerId"), false);
});

test("readiness exposes only aggregate private access state", () => {
  const monitor = new HealthMonitor({
    version: "1.0.0",
    now: () => new Date("2026-07-25T10:00:00.000Z"),
  });
  monitor.setPrivateAccessState({
    accessMode: "allowlist",
    persistedUserCount: 4,
    authorizedUserCount: 2,
    suspendedUserCount: 2,
    activeUserCount: 1,
    allowedUserIds: [42, 99],
  });

  assert.deepEqual(monitor.readiness().privateAccess, {
    accessMode: "allowlist",
    persistedUserCount: 4,
    authorizedUserCount: 2,
    suspendedUserCount: 2,
    activeUserCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(monitor.readiness()), /42|99/u);
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
