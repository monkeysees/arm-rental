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

function alertRecord(observedAt, event = "alert.firing") {
  return `${JSON.stringify({
    __REALTIME_TIMESTAMP: String(Date.parse(observedAt) * 1000),
    CONTAINER_NAME: "rental-apartments-bot",
    PRIORITY: event === "alert.firing" ? "4" : "6",
    MESSAGE: JSON.stringify({
      severity: event === "alert.firing" ? "warn" : "info",
      event,
      alertName: "browser_challenge",
      alertSeverity: "warn",
      message: "Browser verification state changed",
    }),
  })}\n`;
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
  await copyFile(fixture, journal);
  await writeFile(unitJournal, "");

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
if [ "$1" = "exec" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '[{"Image":"sha256:abc","Config":{"Labels":{"org.opencontainers.image.revision":"${"a".repeat(40)}"}},"State":{"Running":true,"StartedAt":"${containerStartedAt}","Health":{"Status":"healthy"}},"RestartCount":0}]'
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
    "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/test 1000 100 900 10%% /test\\n'\n",
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
  assert.deepEqual(result.metrics.stateWrites, [
    {
      state: "apartments.json",
      count: 2,
      failureCount: 0,
      bytes: 260,
      durationMs: { p50: 100, p95: 501 },
    },
  ]);

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
      "rental-maintenance",
      "rental-restore-drill",
      "rental-reboot-check",
    ],
  );
});

test("monitor sends only firing and resolved transitions and keeps redacted fallback logs", async (t) => {
  const host = await fakeHost(t);
  await execute(monitor, [], { env: host.env });
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
  const alertState = JSON.parse(
    await readFile(join(host.state, "alerts.json"), "utf8"),
  );
  assert.deepEqual(alertState.alerts, []);
  const serviceLog = await readFile(host.env.RENTAL_TEST_SYSTEMD_LOG, "utf8");
  assert.doesNotMatch(serviceLog, /abcdefghijklmnopqrstuvwxyz|123456789/u);
  assert.match(serviceLog, /monitor\.succeeded/u);
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
