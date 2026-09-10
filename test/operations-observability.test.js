import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = new URL("../", import.meta.url).pathname;
const rentalctl = join(projectRoot, "ops/rentalctl");
const monitor = join(projectRoot, "ops/monitor");
const fixture = join(projectRoot, "test/fixtures/journal-observability.jsonl");

async function executable(filename, contents) {
  await writeFile(filename, contents);
  await chmod(filename, 0o755);
}

function alertRecord(
  observedAt,
  event = "alert.firing",
  alertName = "browser_challenge",
  details = {},
) {
  const alertDetails =
    typeof details === "string" ? { reason: details } : details;
  return `${JSON.stringify({
    __CURSOR: `${Date.parse(observedAt)}-${event}-${alertName}`,
    __REALTIME_TIMESTAMP: String(Date.parse(observedAt) * 1000),
    CONTAINER_NAME: "rental-apartments-bot",
    PRIORITY: event === "alert.firing" ? "4" : "6",
    MESSAGE: JSON.stringify({
      severity: event === "alert.firing" ? "warn" : "info",
      event,
      alertName,
      alertSeverity: "warn",
      ...alertDetails,
      message: "Browser verification state changed",
    }),
  })}\n`;
}

function applicationRecord(observedAt, record) {
  return `${JSON.stringify({
    __CURSOR: `${Date.parse(observedAt)}-${record.event}`,
    __REALTIME_TIMESTAMP: String(Date.parse(observedAt) * 1000),
    CONTAINER_NAME: "rental-apartments-bot",
    PRIORITY: record.severity === "error" ? "3" : "6",
    MESSAGE: JSON.stringify(record),
  })}\n`;
}

function databaseOperationRecords({
  count,
  durationMs,
  event = "state.transaction.completed",
  operation = "private_delivery_acknowledge",
  errorCode,
  sqliteResultCode,
}) {
  const startedAt = Date.parse("2026-07-25T11:30:00.000Z");
  return Array.from({ length: count }, (_value, index) =>
    applicationRecord(new Date(startedAt + index * 1_000).toISOString(), {
      severity: event.endsWith(".failed") ? "error" : "info",
      event,
      operation,
      rowsChanged: event.endsWith(".failed") ? 0 : 1,
      durationMs,
      databaseBytes: 12_582_912,
      walBytes: 37_080,
      ...(errorCode ? { errorCode } : {}),
      ...(Number.isInteger(sqliteResultCode) ? { sqliteResultCode } : {}),
    }),
  ).join("");
}

async function fakeHost(
  t,
  {
    containerStartedAt = "2026-07-25T11:00:00Z",
    operationsLockAvailable = true,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "rental-observability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state");
  await executable(join(root, "mkdir-bin"), '#!/bin/sh\nmkdir "$1"\n');
  await execute(join(root, "mkdir-bin"), [bin]);
  await execute(join(root, "mkdir-bin"), [state]);
  const journal = join(root, "journal.jsonl");
  const unitJournal = join(root, "unit-journal.jsonl");
  const diskAvailable = join(root, "disk-available-kb");
  const containerStarted = join(root, "container-started-at");
  const readinessExit = join(root, "readiness-exit-code");
  await copyFile(fixture, journal);
  await writeFile(unitJournal, "");
  await writeFile(diskAvailable, "900\n");
  await writeFile(containerStarted, `${containerStartedAt}\n`);
  await writeFile(readinessExit, "0\n");

  await executable(
    join(bin, "journalctl"),
    `#!/bin/sh
case " $* " in
  *" --unit="*) cat "$RENTAL_TEST_UNIT_JOURNAL" ;;
  *) cat "$RENTAL_TEST_JOURNAL" ;;
esac
`,
  );
  await executable(
    join(bin, "docker"),
    `#!/bin/sh
if [ "$1" = "exec" ]; then
  if [ -n "$RENTAL_TEST_READINESS_JSON" ]; then
    cat "$RENTAL_TEST_READINESS_JSON"
  elif [ "$(cat "$RENTAL_TEST_READINESS_EXIT")" = "0" ]; then
    printf '%s\\n' '{"status":"ready","reasons":[],"alertReasons":[]}'
  else
    printf '%s\\n' '{"status":"not_ready","reasons":["READINESS_PROBE_FAILED"],"alertReasons":["READINESS_PROBE_FAILED"]}'
  fi
  exit "$(cat "$RENTAL_TEST_READINESS_EXIT")"
fi
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '[{"Image":"sha256:abc","Config":{"Labels":{"org.opencontainers.image.revision":"${"a".repeat(40)}"}},"State":{"Running":true,"StartedAt":"'"$(cat "$RENTAL_TEST_CONTAINER_STARTED")"'","Health":{"Status":"healthy"}},"RestartCount":0}]'
  exit 0
fi
exit 1
`,
  );
  await executable(
    join(bin, "systemctl"),
    `#!/bin/sh
case "$2" in
  rental-storage-check.timer) printf 'ActiveState=active\\nLastTriggerUSec=Sat 2026-07-25 11:55:00 UTC\\nNextElapseUSecRealtime=Sat 2026-07-25 12:05:00 UTC\\n' ;;
  rental-storage-check.service) printf 'Result=%s\\nExecMainStatus=%s\\n' "\${RENTAL_TEST_STORAGE_RESULT:-success}" "\${RENTAL_TEST_STORAGE_EXIT_STATUS:-0}" ;;
  *.timer) printf 'ActiveState=active\\nLastTriggerUSec=Sat 2026-07-25 11:55:00 UTC\\nNextElapseUSecRealtime=Sat 2026-07-25 12:05:00 UTC\\n' ;;
  *.service) printf 'Result=success\\nExecMainStatus=0\\n' ;;
esac
`,
  );
  await executable(
    join(bin, "df"),
    `#!/usr/bin/env bash
available=900
case "\${!#}" in
  *rental-apartments-data*) available=$(cat "$RENTAL_TEST_DISK_AVAILABLE") ;;
esac
used=$((1000 - available))
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf '/dev/test 1000 %s %s 10%% /test\\n' "$used" "$available"
`,
  );
  await executable(
    join(bin, "du"),
    "#!/bin/sh\nprintf '10\\t/var/log/journal\\n'\n",
  );
  await executable(
    join(bin, "systemd-cat"),
    '#!/bin/sh\ncat >>"$RENTAL_TEST_SYSTEMD_LOG"\n',
  );
  await executable(
    join(bin, "curl"),
    '#!/bin/sh\ncat >>"$RENTAL_TEST_CURL_PAYLOADS"\nprintf "sent\\n" >>"$RENTAL_TEST_CURL_CALLS"\n',
  );
  await executable(
    join(bin, "flock"),
    `#!/bin/sh
exit ${operationsLockAvailable ? 0 : 1}
`,
  );
  const envFile = join(root, "env");
  await writeFile(
    envFile,
    "TELEGRAM_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_OWNER_ID=123456789\n",
    { mode: 0o600 },
  );

  return {
    root,
    bin,
    state,
    journal,
    unitJournal,
    diskAvailable,
    containerStarted,
    readinessExit,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      JOURNALCTL_BIN: join(bin, "journalctl"),
      DOCKER_BIN: join(bin, "docker"),
      SYSTEMCTL_BIN: join(bin, "systemctl"),
      DF_BIN: join(bin, "df"),
      DU_BIN: join(bin, "du"),
      SYSTEMD_CAT_BIN: join(bin, "systemd-cat"),
      CURL_BIN: join(bin, "curl"),
      RENTAL_TEST_JOURNAL: journal,
      RENTAL_TEST_UNIT_JOURNAL: unitJournal,
      RENTAL_TEST_DISK_AVAILABLE: diskAvailable,
      RENTAL_TEST_CONTAINER_STARTED: containerStarted,
      RENTAL_TEST_READINESS_EXIT: readinessExit,
      READINESS_PROBE_RETRY_DELAY_SECONDS: "0",
      RENTAL_TEST_SYSTEMD_LOG: join(root, "systemd.log"),
      RENTAL_TEST_CURL_CALLS: join(root, "curl.calls"),
      RENTAL_TEST_CURL_PAYLOADS: join(root, "curl.payloads"),
      RENTAL_OPS_STATE_DIR: state,
      RENTAL_OPS_LOCK_FILE: join(root, "operations.lock"),
      RENTAL_ENV_FILE: envFile,
      RENTAL_OBSERVABILITY_NOW_EPOCH: "1784980800",
    },
  };
}

test("rentalctl preserves malformed logs and aggregates bounded journal metrics", async (t) => {
  const host = await fakeHost(t);
  await appendFile(
    host.journal,
    applicationRecord("2026-07-25T11:59:00.000Z", {
      severity: "info",
      event: "source.integrity.checked",
      page: 1,
      parsedCount: 20,
    }) +
      applicationRecord("2026-07-25T11:59:30.000Z", {
        severity: "error",
        event: "source.integrity.failed",
        reason: "IDENTITY_REJECTION",
        page: 1,
        rejectedCount: 1,
      }) +
      applicationRecord("2026-07-25T11:59:40.000Z", {
        severity: "warn",
        event: "alert.firing",
        alertName: "readiness_failure",
        status: "firing",
        reasons: ["BROWSER_VERIFICATION_REQUIRED", "unsafe reason"],
        component: "browser",
        code: "ERR_BROWSER_VERIFICATION_REQUIRED",
        ownerId: "must-not-appear",
        message: "Production alert firing",
      }),
  );
  const logs = await execute(
    rentalctl,
    ["logs", "--since", "30m", "--severity", "error"],
    { env: host.env },
  );
  assert.match(logs.stdout, /crawl\.failed\tApartment crawl failed/u);
  assert.match(
    logs.stdout,
    /unstructured\.message\tnot-json but still visible/u,
  );

  const alertLogs = await execute(
    rentalctl,
    ["logs", "--since", "30m", "--event", "alert.firing"],
    { env: host.env },
  );
  assert.match(
    alertLogs.stdout,
    /Production alert firing\t\{"alertName":"readiness_failure","status":"firing","reasons":\["BROWSER_VERIFICATION_REQUIRED"\],"component":"browser","code":"ERR_BROWSER_VERIFICATION_REQUIRED"\}/u,
  );
  assert.doesNotMatch(alertLogs.stdout, /unsafe reason|must-not-appear/u);

  const databaseLogs = await execute(
    rentalctl,
    ["logs", "--since", "30m", "--event", "state.transaction.failed"],
    { env: host.env },
  );
  assert.match(
    databaseLogs.stdout,
    /"code":"ERR_STATE_DATABASE_BUSY","sqliteResultCode":5/u,
  );

  const { stdout } = await execute(
    rentalctl,
    ["metrics", "--since", "1h", "--json"],
    { env: host.env },
  );
  const result = JSON.parse(stdout);
  assert.deepEqual(result.metrics.crawl, {
    successful: 2,
    failed: 1,
    successRatio: 2 / 3,
    durationMs: { p50: 100, p95: 500 },
    pages: 6,
    discovered: 8,
    updated: 3,
    notified: 5,
    filtered: 3,
    channelSent: 3,
    channelEdited: 1,
  });
  assert.deepEqual(result.metrics.retries, [
    { component: "telegram", operation: "send", count: 1 },
  ]);
  assert.equal(Object.hasOwn(result.metrics, "stateWrites"), false);
  assert.deepEqual(result.metrics.databaseOperations, [
    {
      operation: "private_delivery_acknowledge",
      count: 2,
      failureCount: 1,
      busyFailureCount: 1,
      sqliteResultCodes: [{ code: 5, count: 1 }],
      rowsChanged: 1,
      durationMs: { p50: 3, p95: 9 },
      databaseBytes: 12_582_912,
      walBytes: 37_080,
    },
  ]);
  assert.deepEqual(result.metrics.sourceIntegrity, {
    checkedPages: 1,
    failures: 1,
    failuresByReason: [{ reason: "IDENTITY_REJECTION", count: 1 }],
    lastCheckedAt: "2026-07-25T11:59:00Z",
    lastFailureAt: "2026-07-25T11:59:30Z",
  });

  const timers = await execute(rentalctl, ["timers"], { env: host.env });
  assert.deepEqual(
    timers.stdout
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/u)[0]),
    [
      "rental-deploy",
      "rental-monitor",
      "rental-storage-check",
      "rental-backup",
      "rental-image-cleanup",
      "rental-maintenance",
      "rental-restore-drill",
      "rental-reboot-check",
    ],
  );
});

test("monitor sends only firing and resolved transitions and keeps redacted fallback logs", async (t) => {
  const host = await fakeHost(t);
  await execute(monitor, [], { env: host.env });
  let alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.deepEqual(
    alertState.alerts.map(({ name }) => name),
    ["state_database_busy"],
  );
  const statusJson = JSON.parse(
    (await execute(rentalctl, ["status", "--json"], { env: host.env })).stdout,
  );
  assert.deepEqual(
    statusJson.monitorAlerts.map(({ name }) => name),
    ["state_database_busy"],
  );
  const status = await execute(rentalctl, ["status"], { env: host.env });
  assert.match(status.stdout, /firing alerts\s+1/u);
  await execute(monitor, [], { env: host.env });
  assert.equal(
    (await readFile(host.env.RENTAL_TEST_CURL_CALLS, "utf8")).trim().split("\n")
      .length,
    1,
  );

  await writeFile(host.journal, "");
  await execute(monitor, [], { env: host.env });
  assert.equal(
    (await readFile(host.env.RENTAL_TEST_CURL_CALLS, "utf8")).trim().split("\n")
      .length,
    2,
  );
  alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.deepEqual(alertState.alerts, []);
  const serviceLog = await readFile(host.env.RENTAL_TEST_SYSTEMD_LOG, "utf8");
  assert.doesNotMatch(serviceLog, /abcdefghijklmnopqrstuvwxyz|123456789/u);
  assert.match(serviceLog, /monitor\.succeeded/u);
});

test("transaction latency requires a meaningful sample and resolves with hysteresis", async (t) => {
  const host = await fakeHost(t);
  await writeFile(
    host.journal,
    databaseOperationRecords({ count: 19, durationMs: 900 }),
  );
  await execute(monitor, [], { env: host.env });

  let state = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.equal(
    state.alerts.some(({ name }) => name === "state_transaction_latency"),
    false,
  );

  await writeFile(
    host.journal,
    databaseOperationRecords({ count: 20, durationMs: 600 }),
  );
  await execute(monitor, [], { env: host.env });
  state = JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"));
  let latency = state.alerts.find(
    ({ name }) => name === "state_transaction_latency",
  );
  assert.equal(latency?.status, "firing");
  assert.equal(
    latency?.reason,
    "database transaction private_delivery_acknowledge p95 is 600 ms across 20 samples",
  );

  await writeFile(
    host.journal,
    databaseOperationRecords({ count: 20, durationMs: 300 }),
  );
  await execute(monitor, [], { env: host.env });
  state = JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"));
  latency = state.alerts.find(
    ({ name }) => name === "state_transaction_latency",
  );
  assert.equal(latency?.status, "firing");
  assert.match(latency?.reason, /p95 is 300 ms/u);

  await writeFile(
    host.journal,
    databaseOperationRecords({ count: 20, durationMs: 250 }),
  );
  await execute(monitor, [], { env: host.env });
  state = JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"));
  assert.equal(
    state.alerts.some(({ name }) => name === "state_transaction_latency"),
    false,
  );

  const transitions = (await readFile(host.env.RENTAL_TEST_SYSTEMD_LOG, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(({ alertName }) => alertName === "state_transaction_latency");
  assert.deepEqual(
    transitions.map(({ alertStatus }) => alertStatus),
    ["firing", "resolved"],
  );
});

test("database busy exhaustion and other operation failures alert separately", async (t) => {
  const host = await fakeHost(t);
  await writeFile(
    host.journal,
    databaseOperationRecords({
      count: 2,
      durationMs: 5,
      event: "state.transaction.failed",
      operation: "private_delivery_acknowledge",
      errorCode: "ERR_STATE_DATABASE_BUSY",
      sqliteResultCode: 5,
    }) +
      databaseOperationRecords({
        count: 1,
        durationMs: 8,
        event: "state.checkpoint.failed",
        operation: "checkpoint",
        sqliteResultCode: 10,
      }),
  );
  await execute(monitor, [], { env: host.env });

  const state = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.deepEqual(state.alerts.map(({ name }) => name).sort(), [
    "state_database_busy",
    "state_database_operation_failure",
  ]);
  assert.equal(
    state.alerts.find(({ name }) => name === "state_database_busy")?.reason,
    "database busy failure count for private_delivery_acknowledge is 2 (SQLite result codes: 5=2)",
  );
  assert.equal(
    state.alerts.find(({ name }) => name === "state_database_operation_failure")
      ?.reason,
    "database operation failure count for checkpoint is 1 (SQLite result codes: 10=1)",
  );
});

test("filesystem alerts share the free-space calculation and resolve with hysteresis", async (t) => {
  const host = await fakeHost(t);
  await writeFile(host.diskAvailable, "199\n");
  await execute(monitor, [], { env: host.env });

  let state = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  let capacity = state.alerts.find(
    ({ name }) => name === "filesystem_capacity_data",
  );
  assert.equal(capacity?.status, "firing");
  assert.equal(capacity?.reason, "filesystem data has 19.9% free");
  const metrics = JSON.parse(
    await readFile(join(host.state, "metrics-latest.json"), "utf8"),
  );
  assert.equal(metrics.filesystems[0].freeFraction, 0.199);
  assert.equal(metrics.filesystems[0].usedPercent, 80.1);

  await writeFile(host.diskAvailable, "210\n");
  await execute(monitor, [], { env: host.env });
  state = JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"));
  capacity = state.alerts.find(
    ({ name }) => name === "filesystem_capacity_data",
  );
  assert.equal(capacity?.status, "firing");
  assert.equal(capacity?.reason, "filesystem data has 21% free");

  await writeFile(host.diskAvailable, "260\n");
  await execute(monitor, [], { env: host.env });
  state = JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"));
  assert.equal(
    state.alerts.some(({ name }) => name === "filesystem_capacity_data"),
    false,
  );
  const logs = await readFile(host.env.RENTAL_TEST_SYSTEMD_LOG, "utf8");
  const capacityTransitions = logs
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(({ alertName }) => alertName === "filesystem_capacity_data");
  assert.deepEqual(
    capacityTransitions.map(({ alertStatus }) => alertStatus),
    ["firing", "resolved"],
  );
});

test("monitor delivers transient application alert edges exactly once", async (t) => {
  const host = await fakeHost(t);
  await execute(monitor, [], { env: host.env });
  const initialCalls = (await readFile(host.env.RENTAL_TEST_CURL_CALLS, "utf8"))
    .trim()
    .split("\n").length;

  await appendFile(
    host.journal,
    alertRecord(
      "2026-07-25T11:59:10.000Z",
      "alert.firing",
      "list_am_source_integrity",
      "LIST_AM_SOURCE_INTEGRITY",
    ) +
      alertRecord(
        "2026-07-25T11:59:20.000Z",
        "alert.resolved",
        "list_am_source_integrity",
        "LIST_AM_SOURCE_INTEGRITY",
      ),
  );
  await execute(monitor, [], { env: host.env });
  await execute(monitor, [], { env: host.env });

  const calls = (await readFile(host.env.RENTAL_TEST_CURL_CALLS, "utf8"))
    .trim()
    .split("\n");
  assert.equal(calls.length, initialCalls + 2);
  const payloads = await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8");
  assert.match(payloads, /alert firing: list_am_source_integrity/u);
  assert.match(payloads, /alert resolved: list_am_source_integrity/u);
  assert.doesNotMatch(
    await readFile(host.env.RENTAL_TEST_SYSTEMD_LOG, "utf8"),
    /123456789|abcdefghijklmnopqrstuvwxyz/u,
  );
});

test("monitor includes validated readiness reasons in alert notifications", async (t) => {
  const host = await fakeHost(t);
  await appendFile(
    host.journal,
    alertRecord(
      "2026-07-25T11:59:10.000Z",
      "alert.firing",
      "readiness_failure",
      {
        reasons: [
          "CRAWL_STALE",
          "BROWSER_VERIFICATION_REQUIRED",
          "unsafe reason",
        ],
      },
    ),
  );

  await execute(monitor, [], { env: host.env });

  const payloads = await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8");
  assert.match(payloads, /reason: BROWSER_VERIFICATION_REQUIRED, CRAWL_STALE/u);
  assert.doesNotMatch(payloads, /unsafe reason/u);
  const alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.equal(
    alertState.alerts.find(({ name }) => name === "readiness_failure")?.reason,
    "BROWSER_VERIFICATION_REQUIRED, CRAWL_STALE",
  );
});

test("the host readiness alert resolves alongside an application alert of its own", async (t) => {
  const host = await fakeHost(t);
  // The application raises its own readiness_failure. Sharing that name with
  // the monitor's alert once suppressed the host all-clear entirely.
  await appendFile(
    host.journal,
    alertRecord(
      "2026-07-25T11:58:00.000Z",
      "alert.firing",
      "readiness_failure",
      {
        reasons: ["CRAWL_STALE"],
      },
    ) +
      alertRecord(
        "2026-07-25T11:58:30.000Z",
        "alert.resolved",
        "readiness_failure",
      ),
  );

  await writeFile(host.readinessExit, "1\n");
  await execute(monitor, [], { env: host.env });
  await execute(monitor, [], { env: host.env });
  await writeFile(host.readinessExit, "0\n");
  await execute(monitor, [], { env: host.env });

  const payloads = await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8");
  assert.match(payloads, /alert firing: host_readiness_failure/u);
  assert.match(payloads, /2 consecutive readiness probes failed/u);
  assert.match(payloads, /alert resolved: host_readiness_failure/u);

  const alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.equal(alertState.readinessFailureCount, 0);
  assert.equal(
    alertState.alerts.find(({ name }) => name === "host_readiness_failure"),
    undefined,
  );
});

test("host monitoring preserves challenge grace without hiding stale crawling", async (t) => {
  const host = await fakeHost(t);
  const response = join(host.root, "readiness.json");
  host.env.RENTAL_TEST_READINESS_JSON = response;
  await writeFile(host.readinessExit, "1\n");
  await writeFile(
    response,
    JSON.stringify({
      status: "not_ready",
      reasons: ["BROWSER_VERIFICATION_REQUIRED"],
      alertReasons: [],
    }),
  );
  for (let i = 0; i < 4; i += 1) await execute(monitor, [], { env: host.env });
  let state = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.equal(state.readinessFailureCount, 0);
  assert.equal(
    state.alerts.some(({ name }) => name === "host_readiness_failure"),
    false,
  );
  const status = JSON.parse(
    (await execute(rentalctl, ["status", "--json"], { env: host.env })).stdout,
  );
  assert.equal(status.freshReadiness.status, "not_ready");
  assert.deepEqual(status.freshReadiness.reasons, [
    "BROWSER_VERIFICATION_REQUIRED",
  ]);

  await writeFile(
    response,
    JSON.stringify({
      status: "not_ready",
      reasons: ["BROWSER_VERIFICATION_REQUIRED", "CRAWL_STALE"],
      alertReasons: ["CRAWL_STALE"],
    }),
  );
  for (let i = 0; i < 2; i += 1) await execute(monitor, [], { env: host.env });
  state = JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"));
  assert.equal(state.readinessFailureCount, 2);
  assert.match(
    state.alerts.find(({ name }) => name === "host_readiness_failure").reason,
    /CRAWL_STALE/u,
  );
});

test("readiness failures either side of a replaced container are not consecutive", async (t) => {
  const host = await fakeHost(t);
  await writeFile(host.readinessExit, "1\n");

  await execute(monitor, [], { env: host.env });
  let alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.equal(alertState.readinessFailureCount, 1);

  // A deploy replaces the container; the surviving count describes a process
  // that no longer exists.
  await writeFile(host.containerStarted, "2026-07-25T11:56:00Z\n");
  await execute(monitor, [], { env: host.env });

  alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.equal(alertState.readinessFailureCount, 1);
  assert.equal(
    alertState.readinessProbeContainerStartedAt,
    "2026-07-25T11:56:00Z",
  );
  assert.doesNotMatch(
    await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8"),
    /host_readiness_failure/u,
  );

  // A second failure against the same container does complete the pair.
  await execute(monitor, [], { env: host.env });
  assert.match(
    await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8"),
    /alert firing: host_readiness_failure/u,
  );
});

function deployRecord(observedAt, record) {
  return `${JSON.stringify({
    __REALTIME_TIMESTAMP: String(Date.parse(observedAt) * 1000),
    SYSLOG_IDENTIFIER: "rental-deploy",
    PRIORITY: "6",
    MESSAGE: JSON.stringify(record),
  })}\n`;
}

test("a quarantined candidate blocking the pointer alerts until it is cleared", async (t) => {
  const host = await fakeHost(t);
  const digest = `sha256:${"f70af2cd".repeat(8)}`;

  // A skip that names no immutable digest says nothing about which release is
  // blocked, so it must not raise an alert of its own.
  await writeFile(
    host.unitJournal,
    deployRecord("2026-07-25T11:50:00.000Z", {
      event: "deployment.quarantine.skipped",
      result: "success",
      candidateImage: "ghcr.io/owner/repository:latest",
      previousImage: null,
    }),
  );
  await execute(monitor, [], { env: host.env });
  assert.doesNotMatch(
    await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8"),
    /deployment_blocked/u,
  );

  // The deploy timer keeps exiting successfully while it skips the rejected
  // digest, so this record is the only evidence that no release can land.
  await appendFile(
    host.unitJournal,
    deployRecord("2026-07-25T11:55:00.000Z", {
      event: "deployment.quarantine.skipped",
      result: "success",
      candidateImage: `ghcr.io/owner/repository@${digest}`,
      previousImage: "ghcr.io/owner/repository@sha256:2c1be778",
    }),
  );
  const metrics = JSON.parse(
    await execute(monitor, [], { env: host.env }).then(() =>
      readFile(join(host.state, "metrics-latest.json"), "utf8"),
    ),
  );
  assert.deepEqual(metrics.deployment.blockedCandidate, {
    digest,
    observedAt: "2026-07-25T11:55:00Z",
  });

  let payloads = await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8");
  assert.match(payloads, /alert firing: deployment_blocked/u);
  assert.match(payloads, new RegExp(`quarantined candidate ${digest}`, "u"));
  assert.match(payloads, /journalctl -u rental-deploy.service --since -1h/u);
  assert.equal(
    JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"))
      .alerts.filter(({ name }) => name === "deployment_blocked")
      .map(({ status, severity }) => `${status}/${severity}`)
      .join(),
    "firing/error",
  );

  // Clearing the quarantine stops the skips, and the alert resolves with them.
  await writeFile(host.unitJournal, "");
  await execute(monitor, [], { env: host.env });
  payloads = await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8");
  assert.match(payloads, /alert resolved: deployment_blocked/u);
});

test("a rolled-back candidate alerts even though the timer reads success", async (t) => {
  const host = await fakeHost(t);
  const digest = `sha256:${"f0845a6a".repeat(8)}`;

  // The rollback records its own alert under the deploy unit, and the poll
  // queued behind the overrunning deploy skips the freshly quarantined digest
  // and exits successfully seconds later. The timer therefore reads success at
  // every sampling, and this record is the only evidence the release failed.
  await writeFile(
    host.unitJournal,
    deployRecord("2026-07-25T11:52:24.000Z", {
      event: "alert.firing",
      alertName: "deployment_failure",
      alertSeverity: "critical",
      candidateImage: `ghcr.io/owner/repository@${digest}`,
      previousImage: "ghcr.io/owner/repository@sha256:2c1be778",
    }),
  );
  const metrics = JSON.parse(
    await execute(monitor, [], { env: host.env }).then(() =>
      readFile(join(host.state, "metrics-latest.json"), "utf8"),
    ),
  );
  assert.deepEqual(metrics.deployment.alerts, [
    {
      name: "deployment_failure",
      severity: "critical",
      digest,
      observedAt: "2026-07-25T11:52:24Z",
    },
  ]);

  let payloads = await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8");
  assert.match(payloads, /alert firing: deployment_failure/u);
  assert.match(payloads, /severity: critical/u);
  assert.match(payloads, new RegExp(`for candidate ${digest}`, "u"));
  assert.equal(
    JSON.parse(await readFile(join(host.state, "alerts.json"), "utf8"))
      .alerts.filter(({ name }) => name === "deployment_failure")
      .map(({ status, severity }) => `${status}/${severity}`)
      .join(),
    "firing/critical",
  );

  // The record ages out of the window once deployments stop failing.
  await writeFile(host.unitJournal, "");
  await execute(monitor, [], { env: host.env });
  payloads = await readFile(host.env.RENTAL_TEST_CURL_PAYLOADS, "utf8");
  assert.match(payloads, /alert resolved: deployment_failure/u);
});

test("scheduled-job alerts explain the latest structured failure reason", async (t) => {
  const host = await fakeHost(t);
  await writeFile(
    host.unitJournal,
    `${JSON.stringify({
      MESSAGE: JSON.stringify({
        severity: "warn",
        event: "alert.firing",
        alertName: "low_disk",
        freeFraction: 0.125,
        warningThreshold: 0.2,
      }),
    })}\n${JSON.stringify({
      MESSAGE: JSON.stringify({
        event: "storage-check.failed",
        result: "failure",
        exitCode: 2,
        durationMs: 1000,
        step: "check-disk-capacity",
      }),
    })}\n`,
  );
  const env = {
    ...host.env,
    RENTAL_TEST_STORAGE_RESULT: "exit-code",
    RENTAL_TEST_STORAGE_EXIT_STATUS: "2",
  };

  const timers = await execute(rentalctl, ["timers"], { env });
  assert.match(
    timers.stdout,
    /rental-storage-check.*exit-code.*low disk: 12\.5% free is below the 20% threshold/u,
  );

  await writeFile(
    join(host.state, "alerts.json"),
    JSON.stringify({
      schemaVersion: 1,
      readinessFailureCount: 0,
      alerts: [
        {
          name: "scheduled_job_rental-storage-check",
          severity: "error",
          runbook: "rentalctl timers",
          status: "firing",
          firstObservedAt: "2026-07-25T11:56:00Z",
          lastObservedAt: "2026-07-25T11:56:00Z",
          sourceRevision: "a".repeat(40),
        },
      ],
    }),
  );
  await execute(monitor, [], { env });
  const alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  const scheduledJob = alertState.alerts.find(
    ({ name }) => name === "scheduled_job_rental-storage-check",
  );
  assert.equal(
    scheduledJob.reason,
    "low disk: 12.5% free is below the 20% threshold",
  );
  const telegramPayload = await readFile(
    host.env.RENTAL_TEST_CURL_PAYLOADS,
    "utf8",
  );
  assert.match(
    telegramPayload,
    /reason: low disk: 12\.5% free is below the 20% threshold/u,
  );
  const serviceLog = await readFile(host.env.RENTAL_TEST_SYSTEMD_LOG, "utf8");
  assert.match(serviceLog, /"event":"monitor\.alert\.firing"/u);
  assert.match(serviceLog, /"reason":"low disk: 12\.5% free/u);

  await writeFile(
    host.unitJournal,
    `${JSON.stringify({
      MESSAGE: JSON.stringify({
        event: "storage-check.failed",
        result: "failure",
        exitCode: 1,
        durationMs: 0,
        step: "verify-backup-mount",
      }),
    })}\n`,
  );
  const fallback = await execute(rentalctl, ["timers"], { env });
  assert.match(
    fallback.stdout,
    /rental-storage-check.*failed during verify-backup-mount/u,
  );
});

test("monitor ignores application alerts from an earlier container lifecycle", async (t) => {
  const host = await fakeHost(t, {
    containerStartedAt: "2026-07-25T11:00:00.123456789Z",
  });
  await appendFile(host.journal, alertRecord("2026-07-25T10:59:59.000Z"));

  await execute(monitor, [], { env: host.env });
  let metrics = JSON.parse(
    await readFile(join(host.state, "metrics-latest.json"), "utf8"),
  );
  assert.deepEqual(metrics.applicationAlerts, []);
  assert.equal(metrics.deployment.uptimeSeconds, 3599);

  await appendFile(host.journal, alertRecord("2026-07-25T11:00:01.000Z"));
  await execute(monitor, [], { env: host.env });
  metrics = JSON.parse(
    await readFile(join(host.state, "metrics-latest.json"), "utf8"),
  );
  assert.deepEqual(
    metrics.applicationAlerts.map(({ name, status }) => ({ name, status })),
    [{ name: "browser_challenge", status: "firing" }],
  );
});

test("monitor defers successfully while a production operation owns the lock", async (t) => {
  const host = await fakeHost(t, { operationsLockAvailable: false });
  await execute(monitor, [], { env: host.env });

  await assert.rejects(
    readFile(join(host.state, "metrics-latest.json"), "utf8"),
    { code: "ENOENT" },
  );
  await assert.rejects(readFile(host.env.RENTAL_TEST_CURL_CALLS, "utf8"), {
    code: "ENOENT",
  });
  const serviceLog = await readFile(host.env.RENTAL_TEST_SYSTEMD_LOG, "utf8");
  assert.match(serviceLog, /monitor\.started/u);
  assert.match(serviceLog, /monitor\.skipped/u);
  assert.doesNotMatch(serviceLog, /monitor\.(succeeded|failed)/u);
});
