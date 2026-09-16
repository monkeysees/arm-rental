import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    database,
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
  assert.deepEqual(
    repositories.privateDeliveries.loadAllDecisions().recipients[42],
    {
      initialSelectionApplied: true,
      notified: { fresh: TIME },
      skipped: { old: TIME },
      filtered: {},
    },
  );
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
  assert.equal(
    repositories.privateDeliveries.loadRecipient("42", []),
    undefined,
  );
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

test("routine private delivery reads no retained history after its work drains", async (t) => {
  const { repositories, stateAccess, crawl } = await deliveryCrawl(t);
  const target = { recipientId: "42", deliverApartment: async () => {} };
  await crawl({
    fetchPage: async () =>
      new Response(listPage(["1", 110_000], ["2", 120_000])),
    privateDeliveries: [target],
  });
  repositories.apartments.load = () => {
    throw new Error("full history read");
  };
  const candidates = [];
  const read = stateAccess.privateDeliveries.loadRecipient;
  stateAccess.privateDeliveries.loadRecipient = (id, ids) => {
    candidates.push(ids);
    return read(id, ids);
  };
  await crawl({
    fetchPage: async () =>
      new Response(listPage(["1", 110_000], ["2", 120_000])),
    privateDeliveries: [target],
  });
  assert.deepEqual(candidates, [[]]);
  await crawl({
    fetchPage: async () =>
      new Response(listPage(["1", 130_000], ["2", 120_000])),
    privateDeliveries: [target],
    now: () => new Date("2026-08-18T10:12:00.000Z"),
  });
  assert.deepEqual(candidates, [[], ["1"]]);
});

test("incremental private selection preserves accepted, declined, and limited history", async (t) => {
  const { config, repositories, stateAccess, crawl } = await deliveryCrawl(t);
  config.initialDeliveryLimit = 1;
  const delivered = [];
  const target = {
    recipientId: "42",
    filters: { ...emptyFilters(), price: { min: null, max: 100_000 } },
    deliverApartment: async ({ itemId }) => delivered.push(itemId),
  };
  const fetchPage = async () =>
    new Response(
      listPage(["1", 110_000], ["2", 120_000], ["3", 130_000], ["4", 140_000]),
    );
  await crawl({ fetchPage, privateDeliveries: [target] });
  target.filters = emptyFilters();
  await crawl({ fetchPage, privateDeliveries: [target] });
  assert.deepEqual(delivered, []);
  stateAccess.privateDeliveries.decisions.readmitFiltered("42", ["1"]);
  stateAccess.privateDeliveries.decisions.declineHistory("42", { 2: TIME });
  await crawl({ fetchPage, privateDeliveries: [target] });
  assert.deepEqual(delivered, ["1"]);
  stateAccess.privateDeliveries.decisions.requestSelection("42");
  await crawl({ fetchPage, privateDeliveries: [target] });
  assert.deepEqual(delivered, ["1", "3"]);
  assert.deepEqual(
    Object.keys(
      repositories.privateDeliveries.loadRecipient("42", ["1", "2", "3", "4"])
        .skipped,
    ),
    ["2", "4"],
  );
  await crawl({
    fetchPage: async () =>
      new Response(
        listPage(
          ["5", 150_000],
          ["1", 110_000],
          ["2", 120_000],
          ["3", 130_000],
          ["4", 140_000],
        ),
      ),
  });
  stateAccess.privateDeliveries.decisions.requestSelection("42");
  await crawl({
    fetchPage,
    privateDeliveries: [{ ...target, sendInitialApartments: false }],
  });
  assert.deepEqual(delivered, ["1", "3"]);
  assert.equal(
    repositories.privateDeliveries.loadRecipient("42", ["5"]).skipped[5],
    TIME,
  );
});

test("a filter edit classifies expired undecided history without sending it", async (t) => {
  const { repositories, crawl } = await deliveryCrawl(t);
  const target = {
    recipientId: "42",
    deliverApartment: async () => assert.fail("expired listing sent"),
  };
  const options = {
    fetchPage: async () => new Response(listPage(["1", 110_000])),
    now: () => new Date("2026-08-21T10:12:00.000Z"),
  };
  await crawl({ ...options, privateDeliveries: [target] });
  assert.deepEqual(
    repositories.privateDeliveries.loadRecipient("42", ["1"]).filtered,
    {},
  );
  const result = await crawl({
    ...options,
    privateDeliveries: [
      {
        ...target,
        filters: { ...emptyFilters(), price: { min: null, max: 100_000 } },
      },
    ],
  });
  assert.equal(result.filteredCount, 1);
  assert.equal(
    repositories.privateDeliveries.loadRecipient("42", ["1"]).filtered[1],
    "2026-08-21T10:12:00.000Z",
  );
});

test("a concurrent history acceptance survives pruning an older candidate snapshot", async (t) => {
  const { stateAccess, database, crawl } = await deliveryCrawl(t);
  const delivered = [];
  const target = {
    recipientId: "42",
    filters: { ...emptyFilters(), price: { min: null, max: 100_000 } },
    deliverApartment: async ({ itemId }) => delivered.push(itemId),
  };
  const fetchPage = async () => new Response(listPage(["1", 110_000]));
  await crawl({ fetchPage, privateDeliveries: [target] });
  target.filters = emptyFilters();
  const read = stateAccess.privateDeliveries.loadRecipient;
  stateAccess.privateDeliveries.loadRecipient = async (...args) => {
    const snapshot = await read(...args);
    // The menu accepts this exact listing after the worker captured its old rejection.
    stateAccess.privateDeliveries.decisions.readmitFiltered("42", ["1"]);
    return snapshot;
  };
  await crawl({ fetchPage, privateDeliveries: [target] });
  assert.deepEqual(delivered, []);
  assert.equal(
    database.prepare("SELECT count(*) n FROM private_delivery_work").get().n,
    1,
  );
  stateAccess.privateDeliveries.loadRecipient = read;
  await crawl({ fetchPage, privateDeliveries: [target] });
  assert.deepEqual(delivered, ["1"]);
  assert.equal(
    database.prepare("SELECT count(*) n FROM private_delivery_work").get().n,
    0,
  );
});

test("private classification and pending sends resume after reopening the database", async (t) => {
  const { config, database, crawl } = await deliveryCrawl(t);
  const target = {
    recipientId: "42",
    deliverApartment: async () => {
      throw new Error("Telegram interrupted");
    },
  };
  await assert.rejects(
    crawl({
      fetchPage: async () =>
        new Response(listPage(["1", 110_000], ["2", 120_000])),
      privateDeliveries: [target],
    }),
    /Telegram interrupted/,
  );
  assert.equal(
    database.prepare("SELECT count(*) n FROM private_delivery_work").get().n,
    2,
  );
  database.close();
  const reopened = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
  });
  t.after(() => reopened.close());
  const access = createSqliteStateAccess(
    reopened,
    createSqliteRepositories(reopened, { listUrlTemplate: LIST_URL }),
  );
  const delivered = [];
  await crawlApartments(config, {
    stateAccess: access,
    fetchPage: async () =>
      new Response(listPage(["1", 110_000], ["2", 120_000])),
    privateDeliveries: [
      {
        ...target,
        deliverApartment: async ({ itemId }) => delivered.push(itemId),
      },
    ],
    now: () => new Date("2026-08-18T10:12:00.000Z"),
  });
  assert.deepEqual(delivered, ["2", "1"]);
  assert.equal(
    reopened.prepare("SELECT count(*) n FROM private_delivery_work").get().n,
    0,
  );
  // A history answer can enqueue work without any subsequent source change.
  access.privateDeliveries.decisions.classifyFiltered("99", { 1: TIME });
  const { workIds } = access.privateDeliveries.loadCandidates(
    "99",
    emptyFilters(),
  );
  access.privateDeliveries.retainPending("99", [], workIds);
  access.privateDeliveries.decisions.readmitFiltered("99", ["1"]);
  assert.equal(
    reopened
      .prepare(
        "SELECT count(*) n FROM private_delivery_work WHERE recipient_id = '99'",
      )
      .get().n,
    1,
  );
  access.deleteUserData(99);
  assert.equal(
    reopened
      .prepare(
        "SELECT count(*) n FROM private_delivery_work WHERE recipient_id = '99'",
      )
      .get().n,
    0,
  );
});

test("a process crash after one private acknowledgement resumes only the unsent work", async (t) => {
  const { config, database } = await deliveryCrawl(t);
  database.close();
  const html = listPage(["1", 110_000], ["2", 120_000]);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { openStateDatabase } from './src/sqlite-database.js';
    import { createSqliteRepositories } from './src/sqlite-repositories.js';
    import { createSqliteStateAccess } from './src/sqlite-state-access.js';
    import { crawlApartments } from './src/crawler.js';
    const [config, html] = JSON.parse(process.argv[1]);
    const database = openStateDatabase(config);
    const stateAccess = createSqliteStateAccess(database, createSqliteRepositories(database, config));
    let attempts = 0;
    await crawlApartments(config, {
      stateAccess,
      fetchPage: async () => new Response(html),
      now: () => new Date('${TIME}'),
      privateDeliveries: [{ recipientId: '42', deliverApartment: async () => {
        if (++attempts === 2) process.exit(23);
      } }],
    });
  `,
      JSON.stringify([config, html]),
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 23, child.stderr);
  const reopened = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
  });
  t.after(() => reopened.close());
  const repositories = createSqliteRepositories(reopened, {
    listUrlTemplate: LIST_URL,
  });
  assert.deepEqual(
    repositories.privateDeliveries.loadRecipient("42", ["1", "2"]).notified,
    { 2: TIME },
  );
  const delivered = [];
  await crawlApartments(config, {
    stateAccess: createSqliteStateAccess(reopened, repositories),
    fetchPage: async () => new Response(html),
    now: () => new Date(TIME),
    privateDeliveries: [
      {
        recipientId: "42",
        deliverApartment: async ({ itemId }) => delivered.push(itemId),
      },
    ],
  });
  assert.deepEqual(delivered, ["1"]);
  assert.equal(
    reopened.prepare("SELECT count(*) n FROM private_delivery_work").get().n,
    0,
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
    // The decision, durable work token, and temporary batch item commit together.
    [3, 3],
  );
  assert.equal(
    metrics.some(
      ({ operation }) => operation === "private_delivery_state_commit",
    ),
    false,
  );
  assert.equal(
    Object.keys(privateDeliveries.loadAllDecisions().recipients[99].skipped)
      .length,
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
        repositories.privateDeliveries.loadAllDecisions().recipients[
          recipientId
        ].notified,
      ),
      ["1", "2", "3"],
    );
  }
});

test("a crawl never materializes decisions for absent listings", async (t) => {
  const { repositories, stateAccess, crawl } = await deliveryCrawl(t);
  repositories.privateDeliveries.addDecisions("42", "filtered", {
    absent: TIME,
  });
  const loadRecipient = stateAccess.privateDeliveries.loadRecipient;
  stateAccess.privateDeliveries.loadRecipient = async (...args) => {
    const recipient = await loadRecipient(...args);
    assert.deepEqual(Object.keys(recipient.filtered), []);
    return recipient;
  };
  const delivered = [];
  await crawl({
    fetchPage: async () => new Response(listPage(["1", 110_000])),
    privateDeliveries: [
      {
        recipientId: "42",
        deliverApartment: async ({ itemId }) => delivered.push(itemId),
      },
    ],
  });
  assert.deepEqual(delivered, ["1"]);
  assert.equal(
    repositories.privateDeliveries.loadAllDecisions().recipients[42].filtered
      .absent,
    TIME,
  );
});

test("returning listings recover retained decisions before source updates release them", async (t) => {
  const { repositories, crawl } = await deliveryCrawl(t);
  const historyAt = "2026-08-01T00:00:00.000Z";
  const delivered = { notified: [], skipped: [], filtered: [] };
  const announcements = [];
  const targets = Object.keys(delivered).map((recipientId) => ({
    recipientId,
    deliverApartment: async ({ itemId }) => delivered[recipientId].push(itemId),
    announceDelivery: async (batch) => announcements.push([recipientId, batch]),
  }));
  for (const status of Object.keys(delivered)) {
    repositories.privateDeliveries.initializeSelection(status, {});
    if (status === "notified")
      repositories.privateDeliveries.acknowledge(status, "2", historyAt);
    else
      repositories.privateDeliveries.addDecisions(status, status, {
        2: historyAt,
      });
  }
  await crawl({
    fetchPage: async () => new Response(listPage(["1", 110_000])),
    privateDeliveries: targets,
  });
  for (const status of Object.keys(delivered)) {
    assert.equal(
      repositories.privateDeliveries.loadAllDecisions().recipients[status][
        status
      ][2],
      historyAt,
    );
  }
  await crawl({
    fetchPage: async () =>
      new Response(listPage(["2", 120_000], ["1", 110_000])),
    privateDeliveries: targets,
  });
  assert.deepEqual(delivered, {
    notified: ["1"],
    skipped: ["1"],
    filtered: ["1"],
  });
  await crawl({
    fetchPage: async () =>
      new Response(listPage(["2", 130_000], ["1", 110_000])),
    privateDeliveries: targets,
    now: () => new Date("2026-08-18T10:12:00.000Z"),
  });
  assert.deepEqual(delivered, {
    notified: ["1", "2"],
    skipped: ["1"],
    filtered: ["1", "2"],
  });
  assert.deepEqual(announcements, []);
  // Expired stored listings still carry decisions during classification.
  const result = await crawl({
    fetchPage: async () =>
      new Response(listPage(["2", 130_000], ["1", 110_000])),
    privateDeliveries: targets.map((target) => ({
      ...target,
      filters: { ...emptyFilters(), price: { min: null, max: 1 } },
    })),
    now: () => new Date("2026-08-21T10:12:00.000Z"),
  });
  assert.equal(result.filteredCount, 0);
  assert.equal(result.notifiedCount, 0);
  assert.equal(
    repositories.privateDeliveries.loadAllDecisions().recipients.skipped
      .skipped[2],
    historyAt,
  );
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
  assert.deepEqual(
    repositories.privateDeliveries.loadAllDecisions().recipients[42],
    {
      initialSelectionApplied: true,
      notified: { 51: "2026-08-18T10:12:00.000Z" },
      skipped: {},
      filtered: { 52: "2026-08-18T10:12:00.000Z" },
    },
  );
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
      ["private_delivery_readmit", 2],
      ["private_delivery_classify", 1],
    ],
  );
});

test("bounded private batches survive slow sends, failure, deletion, shutdown and restart", async (t) => {
  const fixture = await deliveryCrawl(t);
  const { config, database, repositories } = fixture;
  let access = fixture.stateAccess;
  const { PrivateDeliveryBarrier } = await import("../src/rate-limit.js");
  const barrier = new PrivateDeliveryBarrier();
  const controller = new AbortController();
  const authorized = new Set(
    Array.from({ length: 40 }, (_, i) => String(i + 1)),
  );
  const sent = new Map([...authorized].map((id) => [id, []]));
  const announcements = new Map();
  let active = 0;
  let peak = 0;
  let successes = 0;
  let failures = 0;
  let deleting;
  const html = listPage(...[5, 4, 3, 2, 1].map((id) => [String(id), 100000]));
  const targets = (restart = false) =>
    [...authorized].map((recipientId) => ({
      recipientId,
      isAuthorized: () => authorized.has(recipientId),
      runDeliveryWorker: (operation) => barrier.run(recipientId, operation),
      announceDelivery: async ({ count }) => {
        announcements.set(
          recipientId,
          (announcements.get(recipientId) || 0) + 1,
        );
        assert.ok(count > 0 && count <= 5);
      },
      deliverApartment: async ({ itemId }) => {
        assert.ok(announcements.get(recipientId) > 0);
        if (!restart && recipientId === "1") {
          failures += 1;
          throw new Error("send failed");
        }
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) =>
            setTimeout(resolve, recipientId === "2" ? 15 : 1),
          );
          if (!restart && recipientId === "4" && !deleting) {
            authorized.delete("3");
            barrier.block("3");
            deleting = barrier.drain("3").then(() => access.deleteUserData(3));
            await deleting;
          }
          sent.get(recipientId).push(itemId);
          successes += 1;
          if (!restart && successes === 60) controller.abort();
        } finally {
          active -= 1;
        }
      },
    }));
  await assert.rejects(
    fixture.crawl({
      fetchPage: async () => new Response(html),
      privateDeliveries: targets(),
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  await deleting;
  assert.equal(active, 0);
  assert.ok(peak <= 8);
  assert.equal(failures, 1);
  assert.equal(
    repositories.privateDeliveries.loadRecipient("3", []),
    undefined,
  );
  const beforeRestart = successes;
  database.close();
  const reopened = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: LIST_URL,
  });
  t.after(() => reopened.close());
  const restored = createSqliteRepositories(reopened, {
    listUrlTemplate: LIST_URL,
  });
  access = createSqliteStateAccess(reopened, restored);
  await crawlApartments(config, {
    stateAccess: access,
    fetchPage: async () => new Response(html),
    now: () => new Date(TIME),
    privateDeliveries: targets(true),
  });
  assert.ok(successes > beforeRestart);
  for (const id of authorized)
    assert.deepEqual(sent.get(id), ["1", "2", "3", "4", "5"]);
  assert.equal(restored.privateDeliveries.loadRecipient("3", []), undefined);
  const result = await crawlApartments(config, {
    stateAccess: access,
    fetchPage: async () => new Response(html),
    now: () => new Date(TIME),
    privateDeliveries: targets(true),
  });
  assert.equal(result.notifiedCount, 0);
});
