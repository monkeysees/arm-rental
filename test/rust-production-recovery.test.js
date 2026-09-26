import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import runTest from "node:test";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSnapshot, validateSnapshot } from "../src/recovery.js";
import { getConfig } from "../src/config.js";
const binary = process.env.RENTAL_APP_BINARY;
const test = (name, check) => runTest(name, { skip: !binary }, check);
const base = { TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_OWNER_ID: "123" };
function setup(t, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rental-rust-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...base,
    DATA_DIRECTORY: path.join(root, "data"),
    BACKUP_DIRECTORY: path.join(root, "backup"),
    ...extra,
  };
  if (env.TELEGRAM_STATE_FILE && !path.isAbsolute(env.TELEGRAM_STATE_FILE))
    env.TELEGRAM_STATE_FILE = path.join(
      env.DATA_DIRECTORY,
      env.TELEGRAM_STATE_FILE,
    );
  const config = getConfig(env);
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    create: true,
  });
  database.prepare("UPDATE telegram_state SET update_offset=42").run();
  database.close();
  const run = (command, snapshot) =>
    spawnSync(
      binary,
      [command, ...(snapshot ? ["--snapshot", snapshot] : [])],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
  return { config, run };
}
test("native SQLite backup is accepted by Node recovery oracle and restores offset", async (t) => {
  const { config, run } = setup(t);
  const backup = run("backup:create");
  assert.equal(backup.status, 0, backup.stderr);
  const result = JSON.parse(backup.stdout);
  const validated = await validateSnapshot(config, result.snapshot);
  assert.equal(validated.summary.database.updateOffset, 42);
  const db = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
  });
  db.prepare("UPDATE telegram_state SET update_offset=99").run();
  db.close();
  const restored = run("backup:restore", result.snapshot);
  assert.equal(restored.status, 0, restored.stderr);
  const restoredDb = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
  });
  try {
    assert.equal(
      restoredDb.prepare("SELECT update_offset FROM telegram_state").get()
        .update_offset,
      42,
    );
  } finally {
    restoredDb.close();
  }
});
test("native validates Node backup without changing archive and rejects tampering", async (t) => {
  const { config, run } = setup(t);
  const result = await createSnapshot(config);
  const filename = path.join(result.snapshot, "data", "state.sqlite3");
  const before = readFileSync(filename);
  const validated = run("backup:validate", result.snapshot);
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(readFileSync(filename), before);
  writeFileSync(path.join(result.snapshot, "data", "extra"), "tampered");
  assert.notEqual(run("backup:restore", result.snapshot).status, 0);
});
test("native maintenance persists growth history and reports production counters", (t) => {
  const { config, run } = setup(t);
  const first = run("maintenance:report");
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.type, "rental-apartments-maintenance-report");
  assert.equal(report.stateFiles[0].schemaVersion, 6);
  assert.equal(report.stateFiles[0].updateOffset, 42);
  assert.equal(report.managedStorage.growth.bytes, null);
  const second = run("maintenance:report");
  assert.equal(second.status, 0, second.stderr);
  const following = JSON.parse(second.stdout);
  assert.equal(
    following.managedStorage.growth.previousSampledAt,
    report.sampledAt,
  );
  assert.equal(
    following.managedStorage.growth.previousManagedBytes,
    report.managedStorage.bytes,
  );
  assert.equal(
    JSON.parse(
      readFileSync(
        path.join(config.dataDirectory, ".maintenance-history.json"),
        "utf8",
      ),
    ).managedBytes,
    following.managedStorage.bytes,
  );
});
test("native restore rolls back files installed before a filesystem failure", async (t) => {
  const { config, run } = setup(t, {
    TELEGRAM_STATE_FILE: "nested/telegram.json",
  });
  writeFileSync(config.apartmentsStateFile, "snapshot sentinel", {
    mode: 0o600,
  });
  const snapshot = await createSnapshot(config);
  writeFileSync(config.apartmentsStateFile, "live sentinel", { mode: 0o600 });
  writeFileSync(
    path.dirname(config.telegramStateFile),
    "blocks restoring nested state",
    { mode: 0o600 },
  );
  const result = run("backup:restore", snapshot.snapshot);
  assert.notEqual(result.status, 0);
  assert.equal(
    readFileSync(config.apartmentsStateFile, "utf8"),
    "live sentinel",
  );
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
  });
  try {
    assert.equal(
      database.prepare("SELECT update_offset FROM telegram_state").get()
        .update_offset,
      42,
    );
  } finally {
    database.close();
  }
});
