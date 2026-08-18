import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { emptyFilters } from "../src/filters.js";
import {
  createSnapshot,
  restoreSnapshot,
  validateSnapshot,
} from "../src/recovery.js";
import {
  migrateState,
  planStateMigration,
  validateMigratedState,
} from "../src/state-migration.js";
import { readState, writeState } from "../src/state.js";
import { stateBackendPaths } from "../src/state-backend.js";

const LIST_URL = "https://www.list.am/category/60/{page}";
const TIME = "2026-08-18T10:11:12.000Z";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "arm-rental-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, "data");
  const backupDirectory = path.join(root, "backups");
  const browserProfileDir = path.join(dataDirectory, "chrome-profile");
  await mkdir(browserProfileDir, { recursive: true });
  const config = {
    dataDirectory,
    backupDirectory,
    backupDailyRetention: 7,
    backupWeeklyRetention: 4,
    listUrlTemplate: LIST_URL,
    telegramChannelId: null,
    telegramOwnerId: 42,
    browserProfileDir,
    apartmentsStateFile: path.join(dataDirectory, "apartments.json"),
    deliveryStateFile: path.join(dataDirectory, "telegram-deliveries.json"),
    channelDeliveryStateFile: path.join(
      dataDirectory,
      "telegram-channel-deliveries.json",
    ),
    telegramStateFile: path.join(dataDirectory, "telegram-bot.json"),
    exchangeRatesStateFile: path.join(dataDirectory, "exchange-rates.json"),
  };
  await Promise.all([
    writeState(config.apartmentsStateFile, {
      version: 3,
      type: "list-am-apartments",
      urlTemplate: LIST_URL,
      checkedAt: TIME,
      lastCrawl: { initialRun: true, pagesParsed: 1 },
      apartments: {
        10: {
          itemId: "10",
          title: "Synthetic apartment",
          firstSeenAt: TIME,
          lastSeenAt: TIME,
        },
      },
      apartmentOrder: ["10"],
      sourceIntegrity: {
        recentFirstPageCounts: [1],
        lastSuccessfulAt: TIME,
      },
    }),
    writeState(config.deliveryStateFile, {
      version: 2,
      type: "telegram-deliveries",
      urlTemplate: LIST_URL,
      recipients: {
        42: {
          initialSelectionApplied: true,
          notified: { 10: TIME },
          skipped: {},
          filtered: {},
        },
      },
    }),
    writeState(config.telegramStateFile, {
      version: 3,
      type: "telegram-bot",
      updateOffset: 11,
      users: {
        42: {
          chatId: 42,
          active: true,
          sendInitialApartments: true,
          filters: emptyFilters(),
          pendingFilterInput: null,
        },
      },
    }),
    writeState(config.exchangeRatesStateFile, {
      version: 1,
      type: "cba-exchange-rates",
      baseCurrency: "AMD",
      fetchedAt: TIME,
      effectiveDate: "2026-08-18",
      rates: {
        USD: { amount: 1, rate: 385 },
        EUR: { amount: 1, rate: 420 },
        RUB: { amount: 1, rate: 4.8 },
      },
    }),
    writeState(
      path.join(browserProfileDir, ".rental-apartments-verification.json"),
      {
        version: 1,
        type: "list-am-browser-verification",
        urlTemplate: LIST_URL,
        verifiedAt: TIME,
        regularAdsCount: 1,
      },
    ),
  ]);
  await createSnapshot(config, {
    snapshotClass: "pre-sqlite",
    acquireLock: async () => ({ release: async () => {} }),
    now: () => new Date(TIME),
  });
  return config;
}

test("migration plans, imports, installs sentinels, and validates semantically", async (t) => {
  const config = await fixture(t);
  const plan = await planStateMigration(config);
  assert.equal(plan.status, "planned");
  assert.equal(plan.logicalCounts.apartments, 1);
  assert.equal(plan.logicalCounts.privateDecisions, 1);

  const migrated = await migrateState(config, {
    migrationId: "migration-test",
  });
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.logicalCounts.telegramUsers, 1);
  assert.equal((await validateMigratedState(config)).status, "valid");

  const sqliteSnapshot = await createSnapshot(config, {
    acquireLock: async () => ({ release: async () => {} }),
    now: () => new Date("2026-08-19T10:11:12.000Z"),
  });
  const validatedSnapshot = await validateSnapshot(
    config,
    sqliteSnapshot.snapshot,
  );
  assert.equal(validatedSnapshot.manifest.version, 2);
  assert.equal(validatedSnapshot.summary.database.userVersion, 1);
  assert.equal(
    Object.keys(validatedSnapshot.manifest.hashes).some((name) =>
      /state\.sqlite3-(?:wal|shm)$/u.test(name),
    ),
    false,
  );

  const paths = stateBackendPaths(config.dataDirectory);
  await rm(paths.database);
  await restoreSnapshot(config, sqliteSnapshot.snapshot, {
    acquireLock: async () => ({ release: async () => {} }),
  });
  assert.equal((await validateMigratedState(config)).status, "valid");
  assert.deepEqual(await readState(paths.selector), {
    backend: "sqlite",
    version: 1,
    migrationId: "migration-test",
    databaseId: migrated.databaseId,
  });
  for (const filename of [
    config.apartmentsStateFile,
    config.deliveryStateFile,
    config.channelDeliveryStateFile,
    config.telegramStateFile,
    config.exchangeRatesStateFile,
  ]) {
    const sentinel = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(sentinel.type, "sqlite-migrated");
    assert.equal(
      JSON.stringify(sentinel).includes("Synthetic apartment"),
      false,
    );
  }

  await writeState(paths.selector, {
    backend: "migrating",
    version: 1,
    migrationId: "migration-test",
    sourceHashes: {
      apartments: "a".repeat(64),
      privateDeliveries: "b".repeat(64),
      channelDeliveries: "c".repeat(64),
      telegram: "d".repeat(64),
      exchangeRates: "e".repeat(64),
    },
  });
  const resumed = await migrateState(config);
  assert.equal(resumed.resumed, true);
  assert.equal((await readState(paths.selector)).backend, "sqlite");
});

test("invalid overlapping decisions cannot advance the backend selector", async (t) => {
  const config = await fixture(t);
  await writeState(config.deliveryStateFile, {
    version: 2,
    type: "telegram-deliveries",
    urlTemplate: LIST_URL,
    recipients: {
      42: {
        initialSelectionApplied: true,
        notified: { same: TIME },
        skipped: {},
        filtered: { same: TIME },
      },
    },
  });

  await assert.rejects(
    migrateState(config, { migrationId: "invalid-migration" }),
    { code: "ERR_STATE_MIGRATION_DOMAIN" },
  );
  assert.equal((await readStateBackend(config)).backend, "json");
  await assert.rejects(
    readFile(stateBackendPaths(config.dataDirectory).database),
  );
});

async function readStateBackend(config) {
  const value = await readState(
    stateBackendPaths(config.dataDirectory).selector,
  );
  return value || { backend: "json", version: 1 };
}
