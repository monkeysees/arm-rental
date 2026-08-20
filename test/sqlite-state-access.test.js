import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openApplicationState } from "../src/application-state.js";
import { emptyFilters } from "../src/filters.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";
import { writeState } from "../src/state.js";
import { stateBackendPaths } from "../src/state-backend.js";

const LIST_URL = "https://www.list.am/category/60/{page}";
const TIME = "2026-08-18T10:11:12.000Z";

async function temporaryConfig(t) {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "arm-rental-state-access-"),
  );
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return {
    dataDirectory,
    listUrlTemplate: LIST_URL,
    telegramChannelId: "@apartments_test",
    apartmentsStateFile: path.join(dataDirectory, "apartments.json"),
    deliveryStateFile: path.join(dataDirectory, "telegram-deliveries.json"),
    channelDeliveryStateFile: path.join(
      dataDirectory,
      "telegram-channel-deliveries.json",
    ),
    telegramStateFile: path.join(dataDirectory, "telegram-bot.json"),
    exchangeRatesStateFile: path.join(dataDirectory, "exchange-rates.json"),
  };
}

test("SQLite state access translates whole-domain callers into bounded writes", async (t) => {
  const config = await temporaryConfig(t);
  const metrics = [];
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
    onMetric: (metric) => metrics.push(metric),
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
  });
  const access = createSqliteStateAccess(config, database, repositories);

  await access.saveState(config.deliveryStateFile, {
    version: 2,
    type: "telegram-deliveries",
    urlTemplate: LIST_URL,
    recipients: {
      42: {
        initialSelectionApplied: true,
        notified: {},
        skipped: { old: TIME },
        filtered: { retry: TIME },
      },
    },
  });
  const delivery = await access.loadState(config.deliveryStateFile);
  delete delivery.recipients[42].filtered.retry;
  delivery.recipients[42].notified.fresh = TIME;
  await access.saveState(config.deliveryStateFile, delivery);
  assert.deepEqual(repositories.privateDeliveries.loadRecipient("42"), {
    initialSelectionApplied: true,
    notified: { fresh: TIME },
    skipped: { old: TIME },
    filtered: {},
  });

  await access.saveState(config.telegramStateFile, {
    version: 3,
    type: "telegram-bot",
    updateOffset: 9,
    users: {
      42: {
        chatId: 42,
        active: true,
        sendInitialApartments: false,
        filters: emptyFilters(),
        pendingFilterInput: null,
      },
    },
  });
  assert.equal(repositories.telegram.load().updateOffset, 9);
  assert.equal(
    metrics.some(
      ({ operation, rowsChanged }) =>
        operation === "private_delivery_state_commit" && rowsChanged === 2,
    ),
    true,
  );
});

test("application state follows only the authoritative selector identity", async (t) => {
  const config = await temporaryConfig(t);
  const databaseId = "database-test-id";
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
    databaseId,
  });
  database.close();
  await writeState(stateBackendPaths(config.dataDirectory).selector, {
    backend: "sqlite",
    version: 1,
    migrationId: "migration-test-id",
    databaseId,
  });

  const state = await openApplicationState(config);
  assert.equal(state.backend, "sqlite");
  state.close();

  await writeState(stateBackendPaths(config.dataDirectory).selector, {
    backend: "sqlite",
    version: 1,
    migrationId: "migration-test-id",
    databaseId: "wrong-database-id",
  });
  await assert.rejects(openApplicationState(config), /does not identify/u);
});

test("bounded Telegram commits compare users by meaning, not key order", async (t) => {
  const config = await temporaryConfig(t);
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
  });
  const access = createSqliteStateAccess(config, database, repositories);

  // The order SqliteTelegramRepository.load() rebuilds from stored rows.
  const storedOrder = (chatId, active) => ({
    chatId,
    active,
    sendInitialApartments: true,
    filters: emptyFilters(),
    pendingFilterInput: null,
  });
  // The order defaultUser() produces for a user first seen in memory, which it
  // then keeps for the life of the process.
  const memoryOrder = (chatId, active) => ({
    active,
    chatId,
    sendInitialApartments: true,
    filters: emptyFilters(),
    pendingFilterInput: null,
  });
  const botState = (users, updateOffset) => ({
    version: 3,
    type: "telegram-bot",
    updateOffset,
    users,
  });

  await access.saveState(
    config.telegramStateFile,
    botState({ 42: storedOrder(42, true) }, 1),
  );
  await access.saveState(
    config.telegramStateFile,
    botState({ 42: storedOrder(42, true), 77: storedOrder(77, true) }, 2),
  );

  // Deactivating one user is a single-user change. The other user is untouched
  // and differs from its stored row only by key order, so the bounded-write
  // guard must not count it as a second mutation and reject the commit.
  await access.saveState(
    config.telegramStateFile,
    botState({ 42: memoryOrder(42, true), 77: memoryOrder(77, false) }, 3),
  );

  const stored = repositories.telegram.load();
  assert.equal(stored.updateOffset, 3);
  assert.equal(stored.users[42].active, true);
  assert.equal(stored.users[77].active, false);
});
