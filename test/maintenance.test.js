import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordBrowserVerification } from "../src/browser-verification-state.js";
import { getConfig } from "../src/config.js";
import {
  MAINTENANCE_HISTORY_FILENAME,
  runMaintenance,
  sqliteStateAlerts,
  STATE_DATABASE_CRITICAL_BYTES,
  STATE_DATABASE_WARNING_BYTES,
  STATE_WAL_WARNING_BYTES,
  stateSizeStatus,
} from "../src/maintenance.js";
import { acquireSingletonLock } from "../src/singleton-lock.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { SQLITE_SCHEMA_VERSION } from "../src/sqlite-schema.js";

const DATABASE_ID = "maintenance-database";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rental-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = getConfig(
    {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_CHANNEL_ID: "@rentals",
      DATA_DIRECTORY: path.join(root, "data"),
    },
    root,
  );
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
    databaseId: DATABASE_ID,
    create: true,
  });
  database.close();
  await recordBrowserVerification(config, 12, {
    now: () => new Date("2026-07-25T08:05:00.000Z"),
  });
  await Promise.all([
    mkdir(path.join(config.browserProfileDir, "Default", "Cache"), {
      recursive: true,
    }),
    mkdir(path.join(config.browserProfileDir, "Default", "Code Cache"), {
      recursive: true,
    }),
    mkdir(path.join(config.browserProfileDir, "Default", "Local Storage"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      path.join(config.browserProfileDir, "Default", "Cache", "cache.data"),
      "discardable-cache",
    ),
    writeFile(
      path.join(
        config.browserProfileDir,
        "Default",
        "Code Cache",
        "compiled.data",
      ),
      "discardable-code-cache",
    ),
    writeFile(
      path.join(config.browserProfileDir, "Default", "Cookies"),
      "verification-cookie",
    ),
    writeFile(
      path.join(
        config.browserProfileDir,
        "Default",
        "Local Storage",
        "verification-state",
      ),
      "persistent-verification-state",
    ),
  ]);
  return config;
}

async function missing(filename) {
  await assert.rejects(access(filename), { code: "ENOENT" });
}

test("weekly maintenance reports state growth and cleans only reconstructible Chrome caches", async (t) => {
  const config = await fixture(t);
  const events = [];
  const diskCheck = async () => ({
    status: "ok",
    freeBytes: 900,
    totalBytes: 1_000,
    freeFraction: 0.9,
    warningThreshold: 0.2,
  });
  const acquireLock = async (dataDirectory) => {
    events.push(["lease:acquired", dataDirectory]);
    return { release: async () => events.push(["lease:released"]) };
  };

  const first = await runMaintenance(config, {
    now: () => new Date("2026-07-27T03:00:00.000Z"),
    acquireLock,
    diskCheck,
  });

  // Growth is measured over the database plus the verification record beside
  // the profile: those are the only managed state files that remain.
  assert.deepEqual(
    first.stateFiles.map(({ name }) => name),
    ["sqlite", "browserVerification"],
  );
  assert.equal(first.stateFiles[0].schemaVersion, SQLITE_SCHEMA_VERSION);
  assert.equal(
    first.stateFiles.find(({ name }) => name === "browserVerification")
      .entryCount,
    1,
  );
  assert.equal(first.browserProfile.cacheBytesRemoved > 0, true);
  assert.deepEqual(first.browserProfile.cleanedCachePaths, [
    "Default/Cache",
    "Default/Code Cache",
  ]);
  assert.equal(
    first.managedStorage.bytes,
    first.managedStorage.stateBytes -
      first.managedStorage.profileEmbeddedStateBytes +
      first.browserProfile.bytes,
  );
  assert.equal(first.managedStorage.growth.bytes, null);
  assert.deepEqual(first.alerts, []);
  assert.deepEqual(events, [
    ["lease:acquired", config.dataDirectory],
    ["lease:released"],
  ]);

  await missing(path.join(config.browserProfileDir, "Default", "Cache"));
  await missing(path.join(config.browserProfileDir, "Default", "Code Cache"));
  assert.equal(
    await readFile(
      path.join(config.browserProfileDir, "Default", "Cookies"),
      "utf8",
    ),
    "verification-cookie",
  );
  assert.equal(
    await readFile(
      path.join(
        config.browserProfileDir,
        "Default",
        "Local Storage",
        "verification-state",
      ),
      "utf8",
    ),
    "persistent-verification-state",
  );

  await writeFile(
    path.join(config.browserProfileDir, "Default", "persistent-growth"),
    "123456789",
  );
  const second = await runMaintenance(config, {
    now: () => new Date("2026-08-03T03:00:00.000Z"),
    acquireLock,
    diskCheck,
  });
  assert.equal(second.managedStorage.growth.bytes, 9);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(config.dataDirectory, MAINTENANCE_HISTORY_FILENAME),
        "utf8",
      ),
    ).managedBytes,
    second.managedStorage.bytes,
  );
});

test("SQLite maintenance validates one database and reports logical counts", async (t) => {
  const config = await fixture(t);
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
  });
  database.transaction("maintenance_fixture", () => {
    database
      .prepare("INSERT INTO apartments(item_id, payload_json) VALUES (?, ?)")
      .run("100", JSON.stringify({ itemId: "100" }));
  });
  database.close();

  const report = await runMaintenance(config, {
    acquireLock: async () => ({ release: async () => {} }),
    diskCheck: async () => ({
      status: "ok",
      freeBytes: 900,
      totalBytes: 1_000,
      freeFraction: 0.9,
      warningThreshold: 0.2,
    }),
  });

  assert.deepEqual(
    report.stateFiles.map(({ name }) => name),
    ["sqlite", "browserVerification"],
  );
  assert.equal(report.stateFiles[0].schemaVersion, SQLITE_SCHEMA_VERSION);
  assert.equal(report.stateFiles[0].telegramUsers, 0);
  assert.equal(report.stateFiles[0].bytes > 0, true);
  // An ordinary database is the case production is actually in, and it must
  // not alert. What each threshold means is pinned directly below.
  assert.deepEqual(report.alerts, []);
  assert.equal(report.stateFiles[0].status, "ok");
});

test("database and WAL growth alert at the sizes that bound each of them", () => {
  assert.deepEqual(
    sqliteStateAlerts({
      bytes: STATE_DATABASE_WARNING_BYTES - 1,
      walBytes: STATE_WAL_WARNING_BYTES - 1,
    }),
    [],
  );
  assert.deepEqual(
    sqliteStateAlerts({
      bytes: STATE_DATABASE_WARNING_BYTES,
      walBytes: 0,
    }),
    [
      {
        alertName: "state_database_growth",
        bytes: STATE_DATABASE_WARNING_BYTES,
        thresholdBytes: STATE_DATABASE_WARNING_BYTES,
      },
    ],
  );
  // The WAL is bounded by checkpointing working, not by retained history, so
  // it still alerts far below the database threshold rather than tracking it.
  assert.ok(STATE_WAL_WARNING_BYTES < STATE_DATABASE_WARNING_BYTES);
  assert.deepEqual(
    sqliteStateAlerts({ bytes: 0, walBytes: STATE_WAL_WARNING_BYTES }),
    [
      {
        alertName: "state_wal_growth",
        bytes: STATE_WAL_WARNING_BYTES,
        thresholdBytes: STATE_WAL_WARNING_BYTES,
      },
    ],
  );
  // The installation that prompted the change: 36.8 MiB of legitimate
  // decision history is no longer an alert.
  assert.deepEqual(
    sqliteStateAlerts({ bytes: 37 * 1024 * 1024, walBytes: 0 }),
    [],
  );
});

test("maintenance refuses a live service lease before reading or cleaning the profile", async (t) => {
  const config = await fixture(t);
  const liveLease = await acquireSingletonLock(config.dataDirectory);
  try {
    await assert.rejects(
      runMaintenance(config),
      (error) => error.code === "ERR_SINGLETON_LOCKED",
    );
  } finally {
    await liveLease.release();
  }
  assert.equal(
    await readFile(
      path.join(config.browserProfileDir, "Default", "Cache", "cache.data"),
      "utf8",
    ),
    "discardable-cache",
  );
});

test("state size thresholds distinguish early warning from critical growth", () => {
  assert.equal(stateSizeStatus(STATE_DATABASE_WARNING_BYTES - 1), "ok");
  assert.equal(stateSizeStatus(STATE_DATABASE_WARNING_BYTES), "warning");
  assert.equal(stateSizeStatus(STATE_DATABASE_CRITICAL_BYTES), "critical");
});
