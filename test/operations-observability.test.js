import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
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

async function fakeHost(t) {
  const root = await mkdtemp(join(tmpdir(), "rental-observability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state");
  await executable(join(root, "mkdir-bin"), '#!/bin/sh\nmkdir "$1"\n');
  await execute(join(root, "mkdir-bin"), [bin]);
  await execute(join(root, "mkdir-bin"), [state]);
  const journal = join(root, "journal.jsonl");
  await copyFile(fixture, journal);

  await executable(
    join(bin, "journalctl"),
    '#!/bin/sh\ncat "$RENTAL_TEST_JOURNAL"\n',
  );
  await executable(
    join(bin, "docker"),
    `#!/bin/sh
if [ "$1" = "exec" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '[{"Image":"sha256:abc","Config":{"Labels":{"org.opencontainers.image.revision":"${"a".repeat(40)}"}},"State":{"Running":true,"StartedAt":"2026-07-25T11:00:00Z","Health":{"Status":"healthy"}},"RestartCount":0}]'
  exit 0
fi
exit 1
`,
  );
  await executable(
    join(bin, "systemctl"),
    `#!/bin/sh
case "$2" in
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
    '#!/bin/sh\ncat >/dev/null\nprintf "sent\\n" >>"$RENTAL_TEST_CURL_CALLS"\n',
  );
  await executable(join(bin, "flock"), "#!/bin/sh\nexit 0\n");
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
      RENTAL_TEST_SYSTEMD_LOG: join(root, "systemd.log"),
      RENTAL_TEST_CURL_CALLS: join(root, "curl.calls"),
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
