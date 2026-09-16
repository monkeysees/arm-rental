import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createLegacyDatabase } from "./helpers/sqlite-legacy.js";
import { SQLITE_SCHEMA_VERSION } from "../src/sqlite-schema.js";

import { getConfig } from "../src/config.js";
import {
  checkDiskSpace,
  createSnapshot,
  RecoveryValidationError,
  restoreSnapshot,
  validateSnapshot,
} from "../src/recovery.js";
import { acquireSingletonLock } from "../src/singleton-lock.js";
import {
  openStateDatabase,
  stateDatabasePaths,
} from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { writeState } from "../src/state.js";

const DATABASE_ID = "database-1";
const MIGRATION_ID = "migration-1";
const TIME = "2026-07-25T08:00:00.000Z";

test("an older SQLite snapshot validates unchanged and restores through the forward migration", async (t) => {
  const { config } = await fixture(t);
  const backup = await createSnapshot(config, { now: () => new Date(TIME) });
  const dataRoot = path.join(backup.snapshot, "data");
  const filename = stateDatabasePaths(dataRoot).database;
  await rm(filename);
  const legacy = createLegacyDatabase(dataRoot, {
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
  });
  legacy.exec("INSERT INTO private_recipients VALUES ('42', 1)");
  legacy
    .prepare(
      "INSERT INTO private_delivery_decisions VALUES ('42', 'returning', 'skipped', ?)",
    )
    .run("2026-07-25T08:00:00.999Z");
  legacy.close();
  const archived = await readFile(filename);
  const manifestPath = path.join(backup.snapshot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  Object.assign(manifest.summary.database, {
    userVersion: 2,
    databaseId: "legacy-database",
    apartments: 0,
    privateRecipients: 1,
    privateDecisions: 1,
    channelDeliveries: 0,
    telegramUsers: 0,
    exchangeRateSnapshots: 0,
    updateOffset: 0,
  });
  manifest.hashes["state.sqlite3"] = createHash("sha256")
    .update(archived)
    .digest("hex");
  await writeState(manifestPath, manifest);
  const validated = await validateSnapshot(config, backup.snapshot);
  assert.equal(validated.summary.database.userVersion, SQLITE_SCHEMA_VERSION);
  assert.deepEqual(await readFile(filename), archived);
  await restoreSnapshot(config, backup.snapshot);
  const restored = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
  });
  const repository = createSqliteRepositories(restored, {
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
  }).privateDeliveries;
  assert.deepEqual(repository.loadRecipient("42", ["returning"]).skipped, {
    returning: "2026-07-25T08:00:00.999Z",
  });
  restored.close();
  assert.deepEqual(await readFile(filename), archived);
  manifest.summary.database.userVersion = 1;
  await writeState(manifestPath, manifest);
  await assert.rejects(
    validateSnapshot(config, backup.snapshot),
    /do not match its manifest/u,
  );
});

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
 * Builds the only state shape a snapshot can hold: rows in the installed
 * database. HTTP cookies are disposable and excluded.
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
  const database = openStateDatabase({
    dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
    databaseId: DATABASE_ID,
    migrationId: MIGRATION_ID,
    create: true,
  });
  try {
    const repositories = createSqliteRepositories(database, {
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
    });
    repositories.apartments.importState({
      version: 4,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      checkedAt: TIME,
      lastCrawl: { initialRun: true, pagesParsed: 1 },
      apartments: {
        100: {
          itemId: "100",
          kind: "apartment",
          title: "First",
          firstSeenAt: TIME,
        },
        101: {
          itemId: "101",
          kind: "house",
          title: "Second",
          firstSeenAt: TIME,
        },
      },
      apartmentOrder: ["100", "101"],
      sourceIntegrity: {
        recentFirstPageCounts: { apartment: [20, 19, 20] },
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
  await writeFile(config.listAmCookieFile, "session-cookie", { mode: 0o600 });
  return { root, config, dataDirectory, backupDirectory };
}

test("an intact snapshot restores durable state and discards HTTP session cookies", async (t) => {
  const { config, dataDirectory, backupDirectory } = await fixture(t);
  const events = [];
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
    onEvent: (event) => events.push(event.name),
  });

  await assert.rejects(
    lstat(path.join(backup.snapshot, "data", "list-am-cookies.txt")),
    { code: "ENOENT" },
  );
  assert.match(backup.snapshot, /daily/u);
  assert.match(backup.weeklySnapshot, /weekly/u);
  assert.equal(backup.summary.database.databaseId, DATABASE_ID);
  assert.equal(backup.summary.database.apartments, 2);
  assert.equal(backup.summary.database.telegramUsers, 2);
  assert.equal(backup.summary.database.updateOffset, 815);
  assert.deepEqual(Object.keys(backup.summary), ["database"]);
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
  await writeFile(config.listAmCookieFile, "unverified-new-state");

  const restored = await restoreSnapshot(config, backup.snapshot, {
    backupDirectory,
  });
  assert.equal(restored.summary.database.apartments, 2);
  assert.equal(restored.summary.database.updateOffset, 815);
  assert.equal(restored.summary.database.databaseId, DATABASE_ID);
  await assert.rejects(lstat(config.listAmCookieFile), { code: "ENOENT" });
  assert.equal(
    (await validateSnapshot(config, backup.snapshot)).summary.database
      .updateOffset,
    815,
  );
});

test("a snapshot restores from a read-only backup mount without being written to", async (t) => {
  const { config, backupDirectory } = await fixture(t);
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
  });
  const dataRoot = path.join(backup.snapshot, "data");

  // The drill and the break-glass restore both mount the backup read-only, so
  // neither may create the WAL sidecars SQLite needs to open a database in
  // place. Denying writes here reproduces that mount without one.
  await chmod(dataRoot, 0o500);
  try {
    assert.equal(
      (await validateSnapshot(config, backup.snapshot)).summary.database
        .updateOffset,
      815,
    );
    const restored = await restoreSnapshot(config, backup.snapshot, {
      backupDirectory,
    });
    assert.equal(restored.summary.database.apartments, 2);

    // The recovery point is still exactly what was published: validating it
    // left no sidecars behind.
    assert.deepEqual(
      (await readdir(dataRoot)).filter((entry) =>
        entry.startsWith("state.sqlite3"),
      ),
      ["state.sqlite3"],
    );
  } finally {
    await chmod(dataRoot, 0o700);
  }
});

test("backup rejects incompatible source state and validation detects damaged snapshots", async (t) => {
  const { config, dataDirectory } = await fixture(t);
  const paths = stateDatabasePaths(dataDirectory);

  // A database bound to another target is refused rather than backed up under
  // this installation's name.
  const retargeted = new DatabaseSync(paths.database);
  retargeted
    .prepare("UPDATE application_metadata SET list_url_template = ?")
    .run("https://www.list.am/category/99/{page}");
  retargeted.close();
  await assert.rejects(
    createSnapshot(config, {
      now: () => new Date("2026-07-26T03:15:00.000Z"),
    }),
    (error) =>
      error instanceof RecoveryValidationError &&
      error.details.code === "ERR_STATE_DATABASE_TARGET",
  );

  const restored = new DatabaseSync(paths.database);
  restored
    .prepare("UPDATE application_metadata SET list_url_template = ?")
    .run(config.listUrlTemplate);
  restored.close();
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:16:00.000Z"),
  });
  await writeFile(
    path.join(backup.snapshot, "data", "state.sqlite3"),
    "tampered",
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

test("a directory holding no database is refused before it is read", async (t) => {
  const { config, dataDirectory, backupDirectory } = await fixture(t);
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
  });
  const paths = stateDatabasePaths(dataDirectory);
  await rm(path.join(backup.snapshot, "data", "state.sqlite3"));
  await rm(paths.database);

  // Both halves of the same guarantee: a directory holding no database is never
  // read as an empty one, whether it is a snapshot or the live data directory.
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

  // A database that is present but unreadable is a damaged directory, not an
  // old one; conflating the two would send an operator hunting for a snapshot
  // that never existed.
  await writeFile(paths.database, "not-a-database", { mode: 0o600 });
  await assert.rejects(
    createSnapshot(config, {
      backupDirectory,
      now: () => new Date("2026-07-26T03:18:00.000Z"),
    }),
    (error) =>
      error instanceof RecoveryValidationError &&
      /SQLite recovery state is invalid/u.test(error.message),
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
  const paths = stateDatabasePaths(dataDirectory);
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

test("version 2 SQLite snapshots restore durable state without reinstalling their obsolete profile", async (t) => {
  const { config } = await fixture(t);
  const backup = await createSnapshot(config);
  const manifestPath = path.join(backup.snapshot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = 2;
  manifest.summary.browser = {
    present: true,
    verifiedAt: TIME,
    regularAdsCount: 12,
  };
  const legacyDirectory = path.join(backup.snapshot, "data", "chrome-profile");
  await mkdir(legacyDirectory);
  await writeFile(path.join(legacyDirectory, "Cookies"), "legacy-session");
  manifest.hashes["chrome-profile/Cookies"] = createHash("sha256")
    .update("legacy-session")
    .digest("hex");
  manifest.hashes = Object.fromEntries(
    Object.entries(manifest.hashes).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeState(manifestPath, manifest);
  const restored = await restoreSnapshot(config, backup.snapshot);
  assert.equal(restored.summary.database.updateOffset, 815);
  await assert.rejects(
    lstat(path.join(config.dataDirectory, "chrome-profile")),
    { code: "ENOENT" },
  );
  await writeFile(path.join(legacyDirectory, "Cookies"), "damaged-session");
  await assert.rejects(
    validateSnapshot(config, backup.snapshot),
    /checksum failed/u,
  );
});

test("new snapshots exclude retired profile and remain restorable without touching retained backups", async (t) => {
  const { config, backupDirectory } = await fixture(t);
  const profile = path.join(config.dataDirectory, "chrome-profile");
  await mkdir(profile);
  await writeFile(path.join(profile, "Cookies"), "retired browser data");
  const protectedDirectory = path.join(backupDirectory, "protected", "keep");
  await mkdir(protectedDirectory, { recursive: true });
  await writeFile(path.join(protectedDirectory, "evidence"), "preserve");
  const backup = await createSnapshot(config);
  const manifest = JSON.parse(
    await readFile(path.join(backup.snapshot, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, 3);
  assert.ok(
    Object.keys(manifest.hashes).every(
      (name) => !name.includes("chrome-profile"),
    ),
  );
  assert.ok(
    !(await readdir(path.join(backup.snapshot, "data"))).includes(
      "chrome-profile",
    ),
  );
  await validateSnapshot(config, backup.snapshot);
  const restored = await restoreSnapshot(config, backup.snapshot);
  assert.equal(restored.summary.database.updateOffset, 815);
  assert.equal(
    await readFile(path.join(profile, "Cookies"), "utf8"),
    "retired browser data",
  );
  assert.equal(
    await readFile(path.join(protectedDirectory, "evidence"), "utf8"),
    "preserve",
  );
});
