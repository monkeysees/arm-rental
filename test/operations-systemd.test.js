import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const immutableImage = `ghcr.io/example/rental-apartments@sha256:${"a".repeat(64)}`;

async function executable(filename, source) {
  await writeFile(filename, source, { mode: 0o755 });
  await chmod(filename, 0o755);
}

async function fixture(t, { backupAgeSeconds = 60 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rental-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = path.join(root, "bin");
  const release = path.join(root, "release");
  const state = path.join(root, "ops-state");
  const backups = path.join(root, "backups");
  const restoreRoot = path.join(state, "restore-drills");
  const log = path.join(root, "commands.log");
  const environmentFile = path.join(root, "production.env");
  const imageFile = path.join(state, "current-image.env");
  const snapshot = path.join(backups, "daily", "2026-07-25T03-15-00-000Z");
  const nowEpoch = 1_785_000_000;

  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(release, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(snapshot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(release, "compose.production.yaml"), "services: {}\n"),
    writeFile(environmentFile, "TELEGRAM_OWNER_ID=42\n"),
    writeFile(imageFile, `RENTAL_APARTMENTS_IMAGE=${immutableImage}\n`),
    writeFile(
      path.join(snapshot, "manifest.json"),
      JSON.stringify({
        createdAt: new Date((nowEpoch - backupAgeSeconds) * 1000).toISOString(),
      }),
    ),
  ]);

  const commandPrelude = `#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "\${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"
command_line="\${0##*/} $*"
if [[ -n "\${FAKE_FAIL_CONTAINS:-}" && "$command_line" == *"$FAKE_FAIL_CONTAINS"* ]]; then
  exit 55
fi
`;
  await executable(
    path.join(fakeBin, "systemctl"),
    `${commandPrelude}
exit 0
`,
  );
  await executable(
    path.join(fakeBin, "flock"),
    `${commandPrelude}
exit 0
`,
  );
  await executable(
    path.join(fakeBin, "systemd-cat"),
    `${commandPrelude}
IFS= read -r record || true
printf 'record %s\\n' "$record" >>"$FAKE_COMMAND_LOG"
`,
  );
  await executable(
    path.join(fakeBin, "date"),
    `${commandPrelude}
case "$*" in
  "+%s") printf '%s\\n' "$FAKE_NOW_EPOCH" ;;
  "--utc +%Y%m%dT%H%M%SZ") printf '%s\\n' "20260725T120000Z" ;;
  --date=*"+%s") printf '%s\\n' "$FAKE_CREATED_EPOCH" ;;
  *) exec /bin/date "$@" ;;
esac
`,
  );
  await executable(
    path.join(fakeBin, "docker"),
    `${commandPrelude}
if [[ "\${1:-}" == "inspect" ]]; then
  name="\${*: -1}"
  if [[ "$name" == rental-apartments-restore-drill-* ]]; then
    run_id="\${name#rental-apartments-restore-drill-}"
    printf '/%s|true|restore-drill|%s\\n' "$name" "$run_id"
  else
    printf '%s\\n' "\${FAKE_HEALTH_STATUS:-healthy}"
  fi
elif [[ "\${1:-}" == "volume" && "\${2:-}" == "inspect" ]]; then
  name="\${*: -1}"
  run_id="\${name#rental-apartments-restore-drill-}"
  temporary=true
  if [[ "\${FAKE_BAD_VOLUME_LABEL:-0}" == "1" ]]; then temporary=false; fi
  printf '%s|%s|restore-drill|%s\\n' "$name" "$temporary" "$run_id"
elif [[ "$*" == *"src/maintenance-cli.js report"* ]]; then
  exit "\${FAKE_MAINTENANCE_STATUS:-0}"
fi
`,
  );

  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_COMMAND_LOG: log,
    FAKE_NOW_EPOCH: String(nowEpoch),
    FAKE_CREATED_EPOCH: String(nowEpoch - backupAgeSeconds),
    RENTAL_RELEASE_DIR: release,
    RENTAL_COMPOSE_FILE: path.join(release, "compose.production.yaml"),
    RENTAL_ENV_FILE: environmentFile,
    RENTAL_IMAGE_ENV_FILE: imageFile,
    RENTAL_OPS_STATE_DIR: state,
    RENTAL_OPS_LOCK_FILE: path.join(state, "operations.lock"),
    RENTAL_BACKUP_ROOT: backups,
    RENTAL_REQUIRE_BACKUP_MOUNT: "0",
    RENTAL_RESTORE_TMP_ROOT: restoreRoot,
    RENTAL_READY_ATTEMPTS: "1",
    RENTAL_READY_INTERVAL_SECONDS: "0",
    RENTAL_CONTAINER_UID: String(process.getuid()),
    RENTAL_CONTAINER_GID: String(process.getgid()),
  };
  return { root, log, restoreRoot, environment };
}

function runScript(name, environment) {
  return new Promise((resolve) => {
    const child = spawn(path.join(repositoryRoot, "ops", name), {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function commandLog(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function assertLifecycle(log, operation, result) {
  assert.equal(
    log.match(new RegExp(`"event":"${operation}\\.started"`, "gu"))?.length,
    1,
  );
  assert.equal(
    log.match(new RegExp(`"event":"${operation}\\.(completed|failed)"`, "gu"))
      ?.length,
    1,
  );
  assert.match(log, new RegExp(`"result":"${result}"`, "u"));
}

test("backup validates the published snapshot and restores readiness across each failure boundary", async (t) => {
  const scenarios = [
    { name: "success", fail: "", status: 0, result: "success" },
    {
      name: "stop",
      fail: "systemctl stop rental-apartments.service",
      status: 55,
      result: "failure",
    },
    {
      name: "snapshot",
      fail: "src/recovery-cli.js backup",
      status: 55,
      result: "failure",
    },
    {
      name: "restart",
      fail: "systemctl start rental-apartments.service",
      status: 55,
      result: "failure",
    },
    {
      name: "readiness",
      fail: "",
      health: "unhealthy",
      status: 70,
      result: "failure",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { log, environment } = await fixture(t);
      environment.FAKE_FAIL_CONTAINS = scenario.fail;
      environment.FAKE_HEALTH_STATUS = scenario.health || "healthy";
      const result = await runScript("backup", environment);
      const commands = await commandLog(log);
      assert.equal(result.status, scenario.status, result.stderr);
      assert.match(commands, /systemctl start rental-apartments\.service/u);
      if (scenario.name === "success") {
        assert.match(commands, /src\/recovery-cli\.js backup/u);
        assert.match(commands, /src\/recovery-cli\.js validate/u);
        assert.ok(
          commands.indexOf("systemctl stop") <
            commands.indexOf("src/recovery-cli.js backup"),
        );
        assert.ok(
          commands.indexOf("src/recovery-cli.js validate") <
            commands.indexOf("systemctl start"),
        );
      }
      assertLifecycle(commands, "backup", scenario.result);
    });
  }
});

test("maintenance requires a validated backup from the previous two hours and preserves threshold status", async (t) => {
  const recent = await fixture(t);
  recent.environment.FAKE_MAINTENANCE_STATUS = "2";
  const threshold = await runScript("maintain", recent.environment);
  const recentLog = await commandLog(recent.log);
  assert.equal(threshold.status, 2, threshold.stderr);
  assert.match(recentLog, /src\/recovery-cli\.js validate/u);
  assert.match(recentLog, /src\/maintenance-cli\.js report/u);
  assert.match(recentLog, /systemctl start rental-apartments\.service/u);
  assertLifecycle(recentLog, "maintenance", "failure");

  const stale = await fixture(t, { backupAgeSeconds: 7201 });
  const refused = await runScript("maintain", stale.environment);
  const staleLog = await commandLog(stale.log);
  assert.equal(refused.status, 69, refused.stderr);
  assert.doesNotMatch(staleLog, /systemctl stop/u);
  assert.doesNotMatch(staleLog, /maintenance-cli/u);
  assertLifecycle(staleLog, "maintenance", "failure");
});

test("restore drill is networkless, disables Telegram, and removes only exactly labeled resources", async (t) => {
  const successful = await fixture(t);
  const result = await runScript("restore-drill", successful.environment);
  const log = await commandLog(successful.log);
  assert.equal(result.status, 0, result.stderr);
  assert.match(log, /docker create .*--network none/u);
  assert.match(log, /TELEGRAM_BOT_TOKEN=restore-drill-disabled/u);
  assert.match(log, /TELEGRAM_DELIVERY_DISABLED=true/u);
  assert.match(log, /TELEGRAM_POLLING_DISABLED=true/u);
  assert.match(log, /node src\/recovery-cli\.js restore/u);
  assert.doesNotMatch(
    log,
    /sendMessage|editMessage(Text|Caption)?|getUpdates|src\/index\.js/u,
  );
  assert.match(log, /docker inspect --format=/u);
  assert.match(log, /docker volume inspect --format=/u);
  assert.match(log, /docker rm --force/u);
  assert.match(log, /docker volume rm/u);
  assert.deepEqual(await readdir(successful.restoreRoot), []);
  assertLifecycle(log, "restore-drill", "success");

  const mislabeled = await fixture(t);
  mislabeled.environment.FAKE_BAD_VOLUME_LABEL = "1";
  const refused = await runScript("restore-drill", mislabeled.environment);
  const refusedLog = await commandLog(mislabeled.log);
  assert.equal(refused.status, 74, refused.stderr);
  assert.doesNotMatch(refusedLog, /docker volume rm/u);
  assert.equal((await readdir(mislabeled.restoreRoot)).length, 1);
  assertLifecycle(refusedLog, "restore-drill", "failure");
});

test("systemd operations use bounded runtimes, persistent UTC timers, and the declared schedules", async () => {
  const unitDirectory = path.join(repositoryRoot, "infra", "systemd");
  const operationNames = [
    "backup",
    "storage-check",
    "maintenance",
    "monitor",
    "restore-drill",
    "reboot-check",
  ];
  const timers = operationNames.map((name) => `rental-${name}.timer`);
  const services = operationNames.map((name) => `rental-${name}.service`);

  for (const timer of timers) {
    const source = await readFile(path.join(unitDirectory, timer), "utf8");
    assert.match(source, /^Persistent=true$/mu, timer);
    assert.match(source, /^OnCalendar=.* UTC$/mu, timer);
  }
  for (const service of services) {
    const source = await readFile(path.join(unitDirectory, service), "utf8");
    assert.match(source, /^TimeoutStartSec=/mu, service);
    assert.match(source, /^RuntimeMaxSec=/mu, service);
  }

  assert.match(
    await readFile(path.join(unitDirectory, "rental-backup.timer"), "utf8"),
    /OnCalendar=\*-\*-\* 03:15:00 UTC/u,
  );
  assert.match(
    await readFile(
      path.join(unitDirectory, "rental-maintenance.timer"),
      "utf8",
    ),
    /OnCalendar=Sun \*-\*-\* 04:00:00 UTC/u,
  );
  assert.match(
    await readFile(
      path.join(unitDirectory, "rental-restore-drill.timer"),
      "utf8",
    ),
    /OnCalendar=Sun \*-\*-01\.\.07 05:00:00 UTC/u,
  );

  const application = await readFile(
    path.join(unitDirectory, "rental-apartments.service"),
    "utf8",
  );
  assert.match(
    application,
    /EnvironmentFile=\/var\/lib\/rental-apartments-ops\/current-image\.env/u,
  );
  assert.match(application, /up --detach --wait --wait-timeout 240 bot/u);
});
