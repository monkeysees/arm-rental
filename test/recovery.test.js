import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordBrowserVerification } from "../src/browser-verification-state.js";
import { getConfig } from "../src/config.js";
import {
  checkDiskSpace,
  createSnapshot,
  RecoveryValidationError,
  restoreSnapshot,
  validateSnapshot,
} from "../src/recovery.js";
import { acquireSingletonLock } from "../src/singleton-lock.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { writeState } from "../src/state.js";
import { stateBackendPaths } from "../src/state-backend.js";

const DATABASE_ID = "database-1";
const MIGRATION_ID = "migration-1";
const TIME = "2026-07-25T08:00:00.000Z";

function rates() {
  return {
    version: 1,
    type: "cba-exchange-rates",
    baseCurrency: "AMD",
    fetchedAt: TIME,
    effectiveDate: "2026-07-25",
    rates: {
      USD: { amount: 1, rate: 382 },
      EUR: { amount: 1, rate: 448 },
      RUB: { amount: 1, rate: 4.8 },
    },
  };
}

/**
 * Builds the only state shape a snapshot can hold: rows in the database named
 * by the selector, beside a verified browser profile.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rental-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, "data");
  const backupDirectory = path.join(root, "independent-backups");
  const config = getConfig(
    {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_CHANNEL_ID: "@rentals",
      DATA_DIRECTORY: dataDirectory,
      BACKUP_DIRECTORY: backupDirectory,
    },
    root,
  );
  await recordBrowserVerification(config, 12, {
    now: () => new Date("2026-07-25T08:05:00.000Z"),
  });
  await writeFile(
    path.join(config.browserProfileDir, "Cookies"),
    "verified-cookie-state",
    { mode: 0o600 },
  );

  const database = openStateDatabase({
    dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
    databaseId: DATABASE_ID,
    migrationId: MIGRATION_ID,
  });
  try {
    const repositories = createSqliteRepositories(database, {
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
    });
    repositories.apartments.importState({
      version: 3,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      checkedAt: TIME,
      lastCrawl: { initialRun: true, pagesParsed: 1 },
      apartments: {
        100: { itemId: "100", title: "First", firstSeenAt: TIME },
        101: { itemId: "101", title: "Second", firstSeenAt: TIME },
      },
      apartmentOrder: ["100", "101"],
      sourceIntegrity: {
        recentFirstPageCounts: [20, 19, 20],
        lastSuccessfulAt: TIME,
      },
    });
    repositories.telegram.importState({
      version: 3,
      type: "telegram-bot",
      updateOffset: 815,
      users: {
        42: { chatId: 42, active: true },
        77: { chatId: 77, active: false, pendingFilterInput: null },
      },
    });
    repositories.exchangeRates.importState(rates());
  } finally {
    database.close();
  }
  await writeState(stateBackendPaths(dataDirectory).selector, {
    backend: "sqlite",
    version: 1,
    migrationId: MIGRATION_ID,
    databaseId: DATABASE_ID,
  });
  return { root, config, dataDirectory, backupDirectory };
}

test("an intact snapshot restores every state and the verified browser profile", async (t) => {
  const { config, dataDirectory, backupDirectory } = await fixture(t);
  const events = [];
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
    onEvent: (event) => events.push(event.name),
  });

  assert.match(backup.snapshot, /daily/u);
  assert.match(backup.weeklySnapshot, /weekly/u);
  assert.equal(backup.summary.database.databaseId, DATABASE_ID);
  assert.equal(backup.summary.database.apartments, 2);
  assert.equal(backup.summary.database.telegramUsers, 2);
  assert.equal(backup.summary.database.updateOffset, 815);
  assert.equal(backup.summary.browser.regularAdsCount, 12);
  assert.deepEqual(events, ["backup.started", "backup.completed"]);
  assert.equal(
    (await lstat(path.join(backup.snapshot, "manifest.json"))).mode & 0o777,
    0o600,
  );

  // Move the live state away from the snapshot in both stores.
  const database = openStateDatabase({
    dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
  });
  try {
    createSqliteRepositories(database, {
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
    }).telegram.setUpdateOffset(999);
  } finally {
    database.close();
  }
  await writeFile(
    path.join(config.browserProfileDir, "Cookies"),
    "unverified-new-state",
  );

  const restored = await restoreSnapshot(config, backup.snapshot, {
    backupDirectory,
  });
  assert.equal(restored.browserVerificationRequired, true);
  assert.equal(restored.summary.database.apartments, 2);
  assert.equal(restored.summary.database.updateOffset, 815);
  assert.equal(restored.summary.database.databaseId, DATABASE_ID);
  assert.equal(
    await readFile(path.join(config.browserProfileDir, "Cookies"), "utf8"),
    "verified-cookie-state",
  );
  assert.equal(
    (await validateSnapshot(config, backup.snapshot)).summary.database
      .updateOffset,
    815,
  );
});

test("backup rejects incompatible source state and validation detects damaged snapshots", async (t) => {
  const { config, dataDirectory } = await fixture(t);
  const paths = stateBackendPaths(dataDirectory);
  await writeState(paths.selector, {
    backend: "sqlite",
    version: 1,
    migrationId: MIGRATION_ID,
    databaseId: "some-other-database",
  });

  await assert.rejects(
    createSnapshot(config, {
      now: () => new Date("2026-07-26T03:15:00.000Z"),
    }),
    (error) =>
      error instanceof RecoveryValidationError &&
      /identities do not match/u.test(error.message),
  );

  await writeState(paths.selector, {
    backend: "sqlite",
    version: 1,
    migrationId: MIGRATION_ID,
    databaseId: DATABASE_ID,
  });
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:16:00.000Z"),
  });
  await writeFile(
    path.join(backup.snapshot, "data", "state-backend.json"),
    '{"tampered":true}\n',
  );
  await assert.rejects(
    validateSnapshot(config, backup.snapshot),
    /checksum failed/u,
  );
});

test("a snapshot taken before the SQLite cutover is refused by name", async (t) => {
  const { config, backupDirectory } = await fixture(t);
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
  });

  // The protected pre-cutover snapshot on the host looks exactly like this: a
  // manifest-v1 body with no state-backend.json beside the JSON state it named.
  // Nothing in this release can read it, and the operator has to be told that
  // rather than left to read it as damage.
  const stranded = path.join(backupDirectory, "protected", "pre-sqlite-2026");
  await rm(path.join(backup.snapshot, "data"), {
    recursive: true,
    force: true,
  });
  await writeState(path.join(backup.snapshot, "manifest.json"), {
    type: "rental-apartments-backup",
    version: 1,
    createdAt: "2026-08-19T07:32:32.202Z",
    summary: {},
    hashes: {},
    snapshotClass: "pre-sqlite",
  });
  await cp(backup.snapshot, stranded, { recursive: true });

  await assert.rejects(
    validateSnapshot(config, stranded),
    (error) =>
      error instanceof RecoveryValidationError &&
      /predates the SQLite cutover/u.test(error.message) &&
      error.details.version === 1,
  );
  await assert.rejects(
    restoreSnapshot(config, stranded, { backupDirectory }),
    /predates the SQLite cutover/u,
  );
});

test("a snapshot with no backend selector is refused before it is read", async (t) => {
  const { config, dataDirectory, backupDirectory } = await fixture(t);
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
  });
  await rm(path.join(backup.snapshot, "data", "state-backend.json"));
  await rm(stateBackendPaths(dataDirectory).selector);

  // Both halves of the same guarantee: a directory that names no backend is
  // never read as an empty SQLite database, whether it is a snapshot or the
  // live data directory.
  await assert.rejects(
    validateSnapshot(config, backup.snapshot),
    /checksum failed/u,
  );
  await assert.rejects(
    createSnapshot(config, {
      backupDirectory,
      now: () => new Date("2026-07-26T03:17:00.000Z"),
    }),
    (error) =>
      error instanceof RecoveryValidationError &&
      /predates the SQLite cutover/u.test(error.message),
  );

  // A selector that is present but unreadable is a damaged directory, not an
  // old one; conflating the two would send an operator hunting for a snapshot
  // that never existed.
  await writeState(stateBackendPaths(dataDirectory).selector, {
    backend: "json",
    version: 1,
  });
  await assert.rejects(
    createSnapshot(config, {
      backupDirectory,
      now: () => new Date("2026-07-26T03:18:00.000Z"),
    }),
    (error) => error.code === "ERR_STATE_BACKEND_UNSUPPORTED",
  );
});

test("backup refuses a live service lease and disk checks expose the warning event", async (t) => {
  const { config } = await fixture(t);
  const liveServiceLease = await acquireSingletonLock(config.dataDirectory);
  try {
    await assert.rejects(
      createSnapshot(config, {
        now: () => new Date("2026-07-26T03:15:00.000Z"),
      }),
      (error) => error.code === "ERR_SINGLETON_LOCKED",
    );
  } finally {
    await liveServiceLease.release();
  }

  const events = [];
  const disk = await checkDiskSpace(config.dataDirectory, {
    warningThreshold: 1.1,
    onEvent: (event) => events.push(event),
  });
  assert.equal(disk.status, "warning");
  assert.equal(events[0].name, "storage.low_disk");
  assert.equal(events[0].component, "storage");
});

test("restore removes every exact managed target before the service restarts", async (t) => {
  const { config, dataDirectory } = await fixture(t);
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
  });
  const paths = stateBackendPaths(dataDirectory);
  await Promise.all([
    writeFile(paths.databaseWal, "stale-wal", { mode: 0o600 }),
    writeFile(paths.databaseShm, "stale-shm", { mode: 0o600 }),
  ]);

  await restoreSnapshot(config, backup.snapshot);

  // The snapshot carries no WAL or shared-memory file, so restoring must leave
  // neither behind: a stale WAL beside a restored database is unread data.
  for (const target of [paths.databaseWal, paths.databaseShm]) {
    await assert.rejects(lstat(target), (error) => error.code === "ENOENT");
  }
  assert.equal((await lstat(paths.database)).mode & 0o777, 0o600);
});

test("routine snapshots hold to their daily and weekly retention", async (t) => {
  const { config, backupDirectory } = await fixture(t);
  for (let day = 1; day <= 8; day += 1) {
    await createSnapshot(config, {
      now: () => new Date(`2026-08-${String(day).padStart(2, "0")}T03:15:00Z`),
    });
  }

  assert.equal((await readdir(path.join(backupDirectory, "daily"))).length, 7);
  assert.equal((await readdir(path.join(backupDirectory, "weekly"))).length, 1);
});
