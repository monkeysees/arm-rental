import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openApplicationState } from "../src/application-state.js";
import { crawlApartments } from "../src/crawler.js";
import { emptyFilters } from "../src/filters.js";
import {
  openStateDatabase,
  STATE_DATABASE_ABSENT,
  stateDatabasePaths,
} from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";

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

function listPage(...apartments) {
  return `<div id="contentr">${apartments
    .map(
      ([itemId, priceAmd]) => `
        <a class="fav-item-info-container" href="/ru/item/${itemId}">
          <div class="dltitle"><div class="pt">Apartment ${itemId}</div></div>
          <div class="p">${priceAmd} \u058F monthly</div>
          <div class="at">Arabkir, 2 rm., 50 sq.m., 3/5 floor</div>
          <div class="d">Вторник, Август 18, 2026, 09:00</div>
        </a>`,
    )
    .join("")}</div>`;
}

/** Runs the delivery hot path against a real database, as production does. */
async function deliveryCrawl(t, { onMetric = () => {} } = {}) {
  const config = {
    ...(await temporaryConfig(t)),
    initialPageCount: 1,
    initialDeliveryLimit: 10,
  };
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
    create: true,
    onMetric,
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
  });
  const stateAccess = createSqliteStateAccess(database, repositories);
  return {
    config,
    repositories,
    stateAccess,
    crawl: (options) =>
      crawlApartments(config, {
        stateAccess,
        now: () => new Date(TIME),
        ...options,
      }),
  };
}

test("domain stores translate their callers into bounded row writes", async (t) => {
  const config = await temporaryConfig(t);
  const metrics = [];
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
    create: true,
    onMetric: (metric) => metrics.push(metric),
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
  });
  const access = createSqliteStateAccess(database, repositories);

  const { decisions } = access.privateDeliveries;
  await decisions.applyInitialSelection("42", {
    skipped: { old: TIME },
    filtered: { retry: TIME },
  });
  await decisions.readmitFiltered("42", ["retry"]);
  await decisions.acknowledge("42", "fresh", TIME);
  assert.deepEqual(repositories.privateDeliveries.loadRecipient("42"), {
    initialSelectionApplied: true,
    notified: { fresh: TIME },
    skipped: { old: TIME },
    filtered: {},
  });
  assert.deepEqual(await access.privateDeliveries.load(), {
    version: 2,
    type: "telegram-deliveries",
    urlTemplate: LIST_URL,
    recipients: {
      42: {
        initialSelectionApplied: true,
        notified: { fresh: TIME },
        skipped: { old: TIME },
        filtered: {},
      },
    },
  });

  // The Telegram store is still handed a whole bot state, because the poll
  // loop holds one; it has to reach the rows the change actually implies.
  await access.telegram.save({
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

  // A recipient leaves only through the atomic user deletion, which takes the
  // user row and the delivery history together and is safe to replay.
  assert.deepEqual(await access.deleteUserData(42), {
    userDeleted: 1,
    recipientDeleted: 1,
  });
  assert.equal(repositories.privateDeliveries.loadRecipient("42"), undefined);
  assert.equal(repositories.telegram.load().users[42], undefined);
  assert.deepEqual(await access.deleteUserData(42), {
    userDeleted: 0,
    recipientDeleted: 0,
  });

  // Nothing in the domain stores reaches the retired whole-state commit.
  assert.equal(
    metrics.some(
      ({ operation }) => operation === "private_delivery_state_commit",
    ),
    false,
  );
});

test("application state opens an installed database and never creates one", async (t) => {
  const config = await temporaryConfig(t);
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
    create: true,
  });
  database.close();

  const state = await openApplicationState(config);
  assert.equal(state.backend, "sqlite");
  state.close();

  // A database belonging to another target is refused rather than adopted.
  await assert.rejects(
    openApplicationState({
      ...config,
      listUrlTemplate: "https://other/{page}",
    }),
    (error) => error.code === "ERR_STATE_DATABASE_TARGET",
  );

  // A data directory that lost its database must fail closed rather than start
  // on the empty one this release would otherwise create for it. Startup has no
  // way to tell that apart from a fresh host, so only state:init may create.
  await rm(stateDatabasePaths(config.dataDirectory).database);
  await assert.rejects(
    openApplicationState(config),
    (error) =>
      error.code === STATE_DATABASE_ABSENT && /state:init/u.test(error.message),
  );
});

test("bounded Telegram commits compare users by meaning, not key order", async (t) => {
  const config = await temporaryConfig(t);
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
    create: true,
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: config.telegramChannelId,
  });
  const access = createSqliteStateAccess(database, repositories);

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

  await access.telegram.save(botState({ 42: storedOrder(42, true) }, 1));
  await access.telegram.save(
    botState({ 42: storedOrder(42, true), 77: storedOrder(77, true) }, 2),
  );

  // Deactivating one user is a single-user change. The other user is untouched
  // and differs from its stored row only by key order, so the bounded-write
  // guard must not count it as a second mutation and reject the commit.
  await access.telegram.save(
    botState({ 42: memoryOrder(42, true), 77: memoryOrder(77, false) }, 3),
  );

  const stored = repositories.telegram.load();
  assert.equal(stored.updateOffset, 3);
  assert.equal(stored.users[42].active, true);
  assert.equal(stored.users[77].active, false);
});

test("a private delivery write never reads a peer recipient's decisions", async (t) => {
  const metrics = [];
  const { repositories, crawl } = await deliveryCrawl(t, {
    onMetric: (metric) => metrics.push(metric),
  });
  const privateDeliveries = repositories.privateDeliveries;
  // A peer history large enough that a whole-state write would have to read it.
  privateDeliveries.initializeSelection("99", {
    skipped: Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`peer-${index}`, TIME]),
    ),
  });
  let scans = 0;
  const loadAllDecisions =
    privateDeliveries.loadAllDecisions.bind(privateDeliveries);
  privateDeliveries.loadAllDecisions = () => {
    scans += 1;
    return loadAllDecisions();
  };

  const delivered = [];
  let scansWhenDeliveryStarted;
  await crawl({
    fetchPage: async () =>
      new Response(listPage(["2", 120_000], ["1", 110_000])),
    privateDeliveries: [
      {
        recipientId: "42",
        deliverApartment: async ({ itemId }) => {
          scansWhenDeliveryStarted ??= scans;
          delivered.push(itemId);
        },
      },
    ],
  });

  assert.deepEqual(delivered, ["1", "2"]);
  assert.equal(scans, scansWhenDeliveryStarted);
  const acknowledgements = metrics.filter(
    ({ name, operation }) =>
      name === "state.transaction.completed" &&
      operation === "private_delivery_acknowledge",
  );
  assert.deepEqual(
    acknowledgements.map(({ rowsChanged }) => rowsChanged),
    [1, 1],
  );
  assert.equal(
    metrics.some(
      ({ operation }) => operation === "private_delivery_state_commit",
    ),
    false,
  );
  assert.equal(
    Object.keys(privateDeliveries.loadRecipient("99").skipped).length,
    500,
  );
});

test("interleaved recipients keep each other's acknowledgements", async (t) => {
  const { repositories, crawl } = await deliveryCrawl(t);
  let peerCompleted;
  const peerFinished = new Promise((resolve) => {
    peerCompleted = resolve;
  });
  let deliveryWrites = Promise.resolve();

  await crawl({
    fetchPage: async () =>
      new Response(listPage(["3", 130_000], ["2", 120_000], ["1", 110_000])),
    // The bot serializes crawl writes against user deletion through this chain.
    deliveryStateMutation: (operation) => {
      const pending = deliveryWrites.then(operation);
      deliveryWrites = pending.catch(() => {});
      return pending;
    },
    privateDeliveries: [
      {
        recipientId: "42",
        deliverApartment: async ({ itemId }) => {
          if (itemId === "1") await peerFinished;
        },
      },
      {
        recipientId: "99",
        deliverApartment: async ({ itemId }) => {
          if (itemId === "3") peerCompleted();
        },
      },
    ],
  });

  for (const recipientId of ["42", "99"]) {
    assert.deepEqual(
      Object.keys(
        repositories.privateDeliveries.loadRecipient(recipientId).notified,
      ),
      ["1", "2", "3"],
    );
  }
});

test("re-admission and later classification stay one bounded write each", async (t) => {
  const metrics = [];
  const { repositories, crawl } = await deliveryCrawl(t, {
    onMetric: (metric) => metrics.push(metric),
  });
  const delivered = [];
  const recipient = {
    recipientId: "42",
    filters: { ...emptyFilters(), price: { min: null, max: 250_000 } },
    deliverApartment: async ({ itemId }) => delivered.push(itemId),
  };

  await crawl({
    fetchPage: async () => new Response(listPage(["51", 300_000])),
    privateDeliveries: [recipient],
  });
  assert.deepEqual(delivered, []);

  // The price drop readmits 51 while the unseen 52 is classified for the first
  // time, so one crawl exercises both remaining bounded decision writes.
  const result = await crawl({
    fetchPage: async () =>
      new Response(listPage(["51", 220_000], ["52", 300_000])),
    privateDeliveries: [recipient],
    now: () => new Date("2026-08-18T10:12:00.000Z"),
  });

  assert.deepEqual(delivered, ["51"]);
  assert.equal(result.readmittedCount, 1);
  assert.equal(result.filteredCount, 1);
  assert.deepEqual(repositories.privateDeliveries.loadRecipient("42"), {
    initialSelectionApplied: true,
    notified: { 51: "2026-08-18T10:12:00.000Z" },
    skipped: {},
    filtered: { 52: "2026-08-18T10:12:00.000Z" },
  });
  assert.deepEqual(
    metrics
      .filter(
        ({ name, operation }) =>
          name === "state.transaction.completed" &&
          ["private_delivery_readmit", "private_delivery_classify"].includes(
            operation,
          ),
      )
      .map(({ operation, rowsChanged }) => [operation, rowsChanged]),
    [
      ["private_delivery_readmit", 1],
      ["private_delivery_classify", 1],
    ],
  );
});
