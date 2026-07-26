import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { writeState } from "../src/state.js";

function rates() {
  return {
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
  };
}

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
      version: 2,
      type: "telegram-deliveries",
      urlTemplate: config.listUrlTemplate,
      recipients: {
        42: {
          notified: { 100: "2026-07-25T08:00:00.000Z" },
          skipped: {},
          filtered: {},
          initialSelectionApplied: true,
        },
        77: {
          notified: {},
          skipped: { 101: "2026-07-25T08:00:00.000Z" },
          filtered: {},
          initialSelectionApplied: true,
        },
      },
    }),
    writeState(config.telegramStateFile, {
      version: 3,
      type: "telegram-bot",
      updateOffset: 815,
      users: {
        42: { chatId: 42, active: true },
        77: {
          chatId: 77,
          active: false,
          pendingFilterInput: null,
          deletionPendingAt: "2026-07-25T08:03:00.000Z",
        },
      },
    }),
    writeState(config.exchangeRatesStateFile, rates()),
    writeState(config.channelDeliveryStateFile, {
      version: 1,
      type: "telegram-channel-deliveries",
      channelId: "@rentals",
      urlTemplate: config.listUrlTemplate,
      initialized: true,
      filterFingerprint: "a".repeat(64),
      apartments: {
        100: {
          status: "filtered",
          classifiedAt: "2026-07-25T08:00:00.000Z",
        },
      },
    }),
  ]);
  await recordBrowserVerification(config, 12, {
    now: () => new Date("2026-07-25T08:05:00.000Z"),
  });
  await writeFile(
    path.join(config.browserProfileDir, "Cookies"),
    "verified-cookie-state",
    { mode: 0o600 },
  );
  return { root, config, dataDirectory, backupDirectory };
}

test("an intact snapshot restores every state and the verified browser profile", async (t) => {
  const { config, backupDirectory } = await fixture(t);
  const events = [];
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:15:00.000Z"),
    onEvent: (event) => events.push(event.name),
  });

  assert.match(backup.snapshot, /daily/u);
  assert.match(backup.weeklySnapshot, /weekly/u);
  assert.deepEqual(backup.summary.apartments, {
    present: true,
    apartments: 2,
    sourceIntegritySampleCount: 3,
    sourceIntegrityLastSuccessfulAt: "2026-07-25T08:00:00.000Z",
  });
  assert.equal(backup.summary.delivery.notified, 1);
  assert.equal(backup.summary.delivery.recipients, 2);
  assert.equal(backup.summary.bot.updateOffset, 815);
  assert.equal(backup.summary.browser.regularAdsCount, 12);
  assert.deepEqual(events, ["backup.started", "backup.completed"]);
  assert.equal(
    (await lstat(path.join(backup.snapshot, "manifest.json"))).mode & 0o777,
    0o600,
  );

  await writeState(config.apartmentsStateFile, {
    version: 2,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    apartments: {},
    apartmentOrder: [],
  });
  await writeState(config.telegramStateFile, {
    version: 1,
    type: "telegram-bot",
    ownerId: 42,
    updateOffset: 999,
  });
  await writeFile(
    path.join(config.browserProfileDir, "Cookies"),
    "unverified-new-state",
  );

  const restored = await restoreSnapshot(config, backup.snapshot, {
    backupDirectory,
  });
  assert.equal(restored.browserVerificationRequired, true);
  assert.equal(restored.summary.apartments.apartments, 2);
  assert.deepEqual(
    JSON.parse(await readFile(config.apartmentsStateFile, "utf8"))
      .sourceIntegrity,
    {
      recentFirstPageCounts: [20, 19, 20],
      lastSuccessfulAt: "2026-07-25T08:00:00.000Z",
    },
  );
  assert.equal(restored.summary.bot.updateOffset, 815);
  assert.deepEqual(
    JSON.parse(await readFile(config.telegramStateFile, "utf8")),
    {
      version: 3,
      type: "telegram-bot",
      updateOffset: 815,
      users: {
        42: { chatId: 42, active: true },
        77: {
          chatId: 77,
          active: false,
          pendingFilterInput: null,
          deletionPendingAt: "2026-07-25T08:03:00.000Z",
        },
      },
    },
  );
  assert.deepEqual(
    JSON.parse(await readFile(config.deliveryStateFile, "utf8")),
    {
      version: 2,
      type: "telegram-deliveries",
      urlTemplate: config.listUrlTemplate,
      recipients: {
        42: {
          notified: { 100: "2026-07-25T08:00:00.000Z" },
          skipped: {},
          filtered: {},
          initialSelectionApplied: true,
        },
        77: {
          notified: {},
          skipped: { 101: "2026-07-25T08:00:00.000Z" },
          filtered: {},
          initialSelectionApplied: true,
        },
      },
    },
  );
  assert.equal(
    await readFile(path.join(config.browserProfileDir, "Cookies"), "utf8"),
    "verified-cookie-state",
  );
  assert.equal(
    (await validateSnapshot(config, backup.snapshot)).summary.bot.updateOffset,
    815,
  );
});

test("backup rejects incompatible source state and validation detects damaged snapshots", async (t) => {
  const { config } = await fixture(t);
  await writeState(config.telegramStateFile, {
    version: 99,
    type: "telegram-bot",
    ownerId: 42,
    updateOffset: 815,
  });

  await assert.rejects(
    createSnapshot(config, {
      now: () => new Date("2026-07-26T03:15:00.000Z"),
    }),
    (error) =>
      error instanceof RecoveryValidationError &&
      /incompatible schema/u.test(error.message),
  );

  await writeState(config.telegramStateFile, {
    version: 1,
    type: "telegram-bot",
    ownerId: 42,
    updateOffset: 815,
  });
  const backup = await createSnapshot(config, {
    now: () => new Date("2026-07-26T03:16:00.000Z"),
  });
  await writeFile(
    path.join(backup.snapshot, "data", "apartments.json"),
    '{"tampered":true}\n',
  );
  await assert.rejects(
    validateSnapshot(config, backup.snapshot),
    /checksum failed/u,
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
