import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statfsSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import runTest from "node:test";
import { checkDiskSpace } from "../src/recovery.js";
import { getConfig } from "../src/config.js";
import { openStateDatabase } from "../src/sqlite-database.js";

const binary = process.env.RENTAL_APP_BINARY;
const test = (name, check) => runTest(name, { skip: !binary }, check);

function fixture(t, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rust-maintenance-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "123:test",
    TELEGRAM_OWNER_ID: "123",
    DATA_DIRECTORY: root,
    ...extra,
  };
  const run = (command) =>
    spawnSync(binary, [command], { env, encoding: "utf8" });
  const events = (result) =>
    result.stderr
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  return { root, env, run, events };
}

test("native storage check matches the Node disk oracle and emits healthy and low disk transitions", async (t) => {
  const { root, env, run, events } = fixture(t);
  const filesystem = statfsSync(root);
  const freePercent = (filesystem.bavail / filesystem.blocks) * 100;
  assert.ok(freePercent > 0 && freePercent < 99.99);
  env.DISK_FREE_WARNING_PERCENT = String(freePercent / 2);
  const healthy = run("storage:check");
  assert.equal(healthy.status, 0, healthy.stderr);
  const expected = await checkDiskSpace(root, {
    warningThreshold: freePercent / 200,
  });
  const result = JSON.parse(healthy.stdout);
  assert.equal(result.status, expected.status);
  assert.equal(result.totalBytes, expected.totalBytes);
  assert.ok(result.freeBytes > 0);
  assert.ok(result.freeBytes <= result.totalBytes);
  assert.deepEqual(
    events(healthy).map(({ event }) => event),
    ["storage.disk_ok", "alert.resolved"],
  );
  assert.equal(events(healthy)[1].alertName, "low_disk");

  const warning = fixture(t, { DISK_FREE_WARNING_PERCENT: "99.99" });
  const low = warning.run("storage:check");
  assert.equal(low.status, 2, low.stderr);
  assert.equal(JSON.parse(low.stdout).status, "warning");
  assert.deepEqual(
    warning.events(low).map(({ event }) => event),
    ["storage.low_disk", "alert.firing"],
  );
  assert.equal(warning.events(low)[1].alertName, "low_disk");
  assert.equal(warning.events(low)[0].component, "storage");
});

test("native maintenance emits report and resolved alerts, then warns for sparse 256 MiB database", (t) => {
  const { root, env, run, events } = fixture(t);
  const config = getConfig(env);
  const db = openStateDatabase({
    dataDirectory: root,
    listUrlTemplate: config.listUrlTemplate,
    create: true,
  });
  db.close();

  const healthy = run("maintenance:report");
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.deepEqual(
    events(healthy).map(({ event }) => event),
    ["maintenance.report", "alert.resolved", "alert.resolved"],
  );
  assert.deepEqual(
    events(healthy)
      .slice(1)
      .map(({ alertName }) => alertName),
    ["state_database_growth", "state_wal_growth"],
  );

  truncateSync(path.join(root, "state.sqlite3"), 256 * 1024 * 1024);
  const warning = run("maintenance:report");
  assert.equal(warning.status, 2, warning.stderr);
  const report = JSON.parse(warning.stdout);
  assert.equal(report.stateFiles[0].status, "warning");
  assert.deepEqual(
    report.alerts.map(({ alertName }) => alertName),
    ["state_database_growth"],
  );
  assert.deepEqual(
    events(warning).map(({ event }) => event),
    ["maintenance.report", "alert.firing", "alert.resolved"],
  );
  assert.equal(events(warning)[1].alertName, "state_database_growth");
});

test("native storage and maintenance command failures exit 1", (t) => {
  const { root, run } = fixture(t);
  assert.equal(run("maintenance:report").status, 1);
  rmSync(root, { recursive: true });
  assert.equal(run("storage:check").status, 1);
});
