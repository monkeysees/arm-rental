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
  STATE_SIZE_MIGRATION_BYTES,
  STATE_SIZE_WARNING_BYTES,
  stateSizeAlerts,
  stateSizeStatus,
} from "../src/maintenance.js";
import { acquireSingletonLock } from "../src/singleton-lock.js";
import { writeState } from "../src/state.js";

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
  await Promise.all([
    writeState(config.apartmentsStateFile, {
      version: 3,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      apartments: {
        100: { itemId: "100" },
        101: { itemId: "101" },
      },
      apartmentOrder: ["100", "101"],
      sourceIntegrity: {
        recentFirstPageCounts: [20, 19, 20],
        lastSuccessfulAt: "2026-07-25T08:00:00.000Z",
      },
    }),
    writeState(config.deliveryStateFile, {
      version: 1,
      type: "telegram-deliveries",
      urlTemplate: config.listUrlTemplate,
      notified: { 100: "2026-07-25T08:00:00.000Z" },
      skipped: { 101: "2026-07-25T08:00:00.000Z" },
      filtered: {},
    }),
    writeState(config.channelDeliveryStateFile, {
      version: 1,
      type: "telegram-channel-deliveries",
      channelId: "@rentals",
      urlTemplate: config.listUrlTemplate,
      initialized: true,
      filterFingerprint: "a".repeat(64),
      apartments: {
        100: {
          status: "published",
          classifiedAt: "2026-07-25T08:00:00.000Z",
          messageId: 12,
          contentHash: "b".repeat(64),
          publishedAt: "2026-07-25T08:01:00.000Z",
        },
      },
    }),
    writeState(config.exchangeRatesStateFile, {
      version: 1,
      type: "cba-exchange-rates",
      baseCurrency: "AMD",
      fetchedAt: "2026-07-25T08:00:00.000Z",
      effectiveDate: "2026-07-25",
      rates: {
        USD: { amount: 1, rate: 382 },
        EUR: { amount: 1, rate: 448 },
        RUB: { amount: 1, rate: 4.8 },
      },
    }),
    writeState(config.telegramStateFile, {
      version: 1,
      type: "telegram-bot",
      ownerId: 42,
      updateOffset: 815,
    }),
  ]);
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

  assert.equal(first.stateFiles.length, 6);
  assert.equal(
    first.stateFiles.find(({ name }) => name === "apartments").entryCount,
    2,
  );
  assert.equal(
    first.stateFiles.find(({ name }) => name === "privateDelivery").entryCount,
    2,
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

test("state size thresholds distinguish early warning and SQLite migration", () => {
  assert.equal(stateSizeStatus(STATE_SIZE_WARNING_BYTES - 1), "ok");
  assert.equal(stateSizeStatus(STATE_SIZE_WARNING_BYTES), "warning");
  assert.equal(
    stateSizeStatus(STATE_SIZE_MIGRATION_BYTES),
    "migration_required",
  );
  assert.deepEqual(
    stateSizeAlerts({
      stateFile: "apartments.json",
      bytes: STATE_SIZE_MIGRATION_BYTES,
    }).map(({ alertName }) => alertName),
    ["state_file_growth", "state_sqlite_migration"],
  );
});
