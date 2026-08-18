import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { emptyFilters } from "../src/filters.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import {
  SQLITE_APPLICATION_ID,
  SQLITE_SCHEMA_VERSION,
} from "../src/sqlite-schema.js";

const LIST_URL = "https://www.list.am/category/60/{page}";
const CHANNEL_ID = "@apartments_test";
const TIME = "2026-08-18T10:11:12.000Z";
const HASH = "a".repeat(64);

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "arm-rental-sqlite-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function openDatabase(directory, options = {}) {
  return openStateDatabase({
    dataDirectory: directory,
    listUrlTemplate: LIST_URL,
    channelId: CHANNEL_ID,
    ...options,
  });
}

function apartmentState(
  apartments = {
    10: { itemId: "10", title: "First", firstSeenAt: TIME, lastSeenAt: TIME },
    20: { itemId: "20", title: "Second", firstSeenAt: TIME, lastSeenAt: TIME },
  },
) {
  return {
    version: 3,
    type: "list-am-apartments",
    urlTemplate: LIST_URL,
    checkedAt: TIME,
    lastCrawl: { initialRun: true, pagesParsed: 1 },
    apartments,
    apartmentOrder: Object.keys(apartments),
    sourceIntegrity: { recentFirstPageCounts: [2], lastSuccessfulAt: TIME },
  };
}

function rateSnapshot() {
  return {
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
  };
}

function botUser(chatId, overrides = {}) {
  return {
    chatId,
    active: true,
    sendInitialApartments: true,
    filters: emptyFilters(),
    pendingFilterInput: null,
    ...overrides,
  };
}

test("SQLite lifecycle creates a secured, bound schema and reopens it", (t) => {
  const directory = temporaryDirectory(t);
  const metrics = [];
  let database = openDatabase(directory, {
    onMetric: (metric) => metrics.push(metric),
  });
  const filename = path.join(directory, "state.sqlite3");

  assert.equal(lstatSync(filename).mode & 0o777, 0o600);
  assert.equal(
    database.prepare("PRAGMA application_id").get().application_id,
    SQLITE_APPLICATION_ID,
  );
  assert.equal(
    database.prepare("PRAGMA user_version").get().user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.equal(
    database.prepare("PRAGMA journal_mode").get().journal_mode,
    "wal",
  );
  assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5_000);
  assert.deepEqual(
    database
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map(({ version }) => version),
    [1],
  );
  assert.equal(database.validate({ full: true }), true);

  database.close();
  assert.equal(metrics.at(-1).name, "state.checkpoint.completed");
  database = openDatabase(directory);
  assert.deepEqual(database.logicalCounts(), {
    apartments: 0,
    privateRecipients: 0,
    privateDecisions: 0,
    channelDeliveries: 0,
    telegramUsers: 0,
    exchangeRateSnapshots: 0,
  });
  database.close();
});

test("SQLite lifecycle rejects unsafe files, identities, schemas, modes, and targets", async (t) => {
  const symlinkDirectory = temporaryDirectory(t);
  symlinkSync(
    path.join(symlinkDirectory, "missing"),
    path.join(symlinkDirectory, "state.sqlite3"),
  );
  assert.throws(() => openDatabase(symlinkDirectory), {
    code: "ERR_STATE_DATABASE_PATH",
  });

  for (const scenario of ["identity", "schema"]) {
    const directory = temporaryDirectory(t);
    const filename = path.join(directory, "state.sqlite3");
    const raw = new DatabaseSync(filename);
    raw.exec(
      `PRAGMA application_id = ${scenario === "identity" ? 1234 : SQLITE_APPLICATION_ID}`,
    );
    raw.exec(
      `PRAGMA user_version = ${scenario === "schema" ? SQLITE_SCHEMA_VERSION + 1 : 1}`,
    );
    raw.close();
    chmodSync(filename, 0o600);
    assert.throws(() => openDatabase(directory), {
      code:
        scenario === "identity"
          ? "ERR_STATE_DATABASE_APPLICATION_ID"
          : "ERR_STATE_DATABASE_SCHEMA_NEWER",
    });
  }

  const modeDirectory = temporaryDirectory(t);
  const modeDatabase = openDatabase(modeDirectory);
  modeDatabase.close();
  chmodSync(path.join(modeDirectory, "state.sqlite3"), 0o640);
  assert.throws(() => openDatabase(modeDirectory), {
    code: "ERR_STATE_DATABASE_MODE",
  });

  const targetDirectory = temporaryDirectory(t);
  const targetDatabase = openDatabase(targetDirectory);
  targetDatabase.close();
  const filename = path.join(targetDirectory, "state.sqlite3");
  const before = readFileSync(filename);
  assert.throws(
    () =>
      openDatabase(targetDirectory, {
        listUrlTemplate: "https://wrong.invalid/{page}",
      }),
    { code: "ERR_STATE_DATABASE_TARGET" },
  );
  assert.deepEqual(readFileSync(filename), before);
});

test("transaction helper rolls back synchronously and emits sanitized bounded metrics", (t) => {
  const directory = temporaryDirectory(t);
  const metrics = [];
  const database = openDatabase(directory, {
    onMetric: (metric) => metrics.push(metric),
  });
  t.after(() => database.close());

  assert.throws(
    () =>
      database.transaction("fault_injection", () => {
        database
          .prepare("INSERT INTO private_recipients VALUES (?, 0)")
          .run("private-id");
        database
          .prepare("INSERT INTO private_delivery_decisions VALUES (?, ?, ?, ?)")
          .run("private-id", "item-id", "invalid-status", TIME);
      }),
    { code: "ERR_STATE_DATABASE_CONSTRAINT" },
  );
  assert.equal(
    database.prepare("SELECT count(*) count FROM private_recipients").get()
      .count,
    0,
  );
  assert.deepEqual(metrics.at(-1), {
    name: "state.transaction.failed",
    component: "storage",
    operation: "fault_injection",
    rowsChanged: 0,
    durationMs: metrics.at(-1).durationMs,
    databaseBytes: metrics.at(-1).databaseBytes,
    walBytes: metrics.at(-1).walBytes,
    schemaVersion: 1,
    outcome: "failed",
    errorCode: "ERR_STATE_DATABASE_CONSTRAINT",
  });
  assert.equal(JSON.stringify(metrics).includes("private-id"), false);

  assert.throws(() => database.transaction("async_forbidden", async () => {}), {
    code: "ERR_STATE_DATABASE_OPERATION",
  });
});

test("repositories preserve complete logical state across a checkpoint and reopen", (t) => {
  const directory = temporaryDirectory(t);
  let database = openDatabase(directory);
  let repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: CHANNEL_ID,
  });

  const apartments = apartmentState();
  repositories.apartments.commitCrawl(apartments);
  repositories.privateDeliveries.initializeSelection("42", {
    skipped: { 20: TIME },
    filtered: { 30: TIME },
  });
  repositories.privateDeliveries.acknowledge("42", "10", TIME);
  repositories.channelDeliveries.initialize(HASH, {
    10: { status: "pending", classifiedAt: TIME },
    20: { status: "filtered", classifiedAt: TIME },
  });
  repositories.channelDeliveries.acknowledge("10", {
    messageId: 101,
    contentHash: HASH,
    publishedAt: TIME,
  });
  repositories.telegram.importState({
    version: 3,
    type: "telegram-bot",
    updateOffset: 51,
    legacyRecipientId: "42",
    users: { 42: botUser(42) },
  });
  repositories.exchangeRates.save(rateSnapshot());
  database.close();

  database = openDatabase(directory);
  repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: CHANNEL_ID,
  });
  assert.deepEqual(repositories.apartments.load(), apartments);
  assert.deepEqual(repositories.privateDeliveries.loadAllDecisions(), {
    version: 2,
    type: "telegram-deliveries",
    urlTemplate: LIST_URL,
    recipients: {
      42: {
        notified: { 10: TIME },
        skipped: { 20: TIME },
        filtered: { 30: TIME },
        initialSelectionApplied: true,
      },
    },
  });
  assert.deepEqual(repositories.channelDeliveries.load(), {
    version: 1,
    type: "telegram-channel-deliveries",
    channelId: CHANNEL_ID,
    urlTemplate: LIST_URL,
    initialized: true,
    filterFingerprint: HASH,
    apartments: {
      10: {
        status: "published",
        classifiedAt: TIME,
        messageId: 101,
        contentHash: HASH,
        publishedAt: TIME,
      },
      20: { status: "filtered", classifiedAt: TIME },
    },
  });
  assert.deepEqual(repositories.telegram.load(), {
    version: 3,
    type: "telegram-bot",
    updateOffset: 51,
    legacyRecipientId: "42",
    users: { 42: botUser(42) },
  });
  assert.deepEqual(repositories.exchangeRates.load(), rateSnapshot());
  assert.deepEqual(database.logicalCounts(), {
    apartments: 2,
    privateRecipients: 1,
    privateDecisions: 3,
    channelDeliveries: 2,
    telegramUsers: 1,
    exchangeRateSnapshots: 1,
  });
  database.validate({ full: true });
  database.close();
});

test("bounded classifications roll back as a unit and acknowledgements touch one row", (t) => {
  const directory = temporaryDirectory(t);
  const metrics = [];
  const database = openDatabase(directory, {
    onMetric: (metric) => metrics.push(metric),
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: CHANNEL_ID,
  });

  repositories.privateDeliveries.addDecisions("42", "filtered", {
    existing: TIME,
  });
  assert.throws(
    () =>
      repositories.privateDeliveries.addDecisions("42", "filtered", {
        fresh: TIME,
        existing: TIME,
      }),
    { code: "ERR_STATE_DATABASE_CONSTRAINT" },
  );
  assert.deepEqual(
    repositories.privateDeliveries.loadRecipient("42").filtered,
    { existing: TIME },
  );

  repositories.privateDeliveries.acknowledge("42", "one", TIME);
  const acknowledgementMetric = metrics.at(-1);
  assert.equal(acknowledgementMetric.operation, "private_delivery_acknowledge");
  assert.equal(acknowledgementMetric.rowsChanged, 1);
  assert.equal(
    database
      .prepare("SELECT count(*) count FROM private_delivery_decisions")
      .get().count,
    2,
  );

  repositories.channelDeliveries.initialize(HASH, {
    one: { status: "pending", classifiedAt: TIME },
  });
  repositories.channelDeliveries.acknowledge("one", {
    messageId: 5,
    contentHash: HASH,
    publishedAt: TIME,
  });
  assert.equal(metrics.at(-1).operation, "channel_acknowledge");
  assert.equal(metrics.at(-1).rowsChanged, 1);
});

test("admission, update, deletion, and rate failures retain their durable boundaries", (t) => {
  const directory = temporaryDirectory(t);
  const database = openDatabase(directory);
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: CHANNEL_ID,
  });

  assert.throws(
    () =>
      repositories.privateDeliveries.initializeSelection("42", {
        skipped: { same: TIME },
        filtered: { same: TIME },
      }),
    /cannot overlap/u,
  );
  assert.equal(repositories.privateDeliveries.loadRecipient("42"), undefined);

  repositories.privateDeliveries.initializeSelection("42", {
    filtered: { readmit: TIME },
  });
  assert.equal(
    repositories.privateDeliveries.removeFilteredDecision("42", "readmit"),
    1,
  );
  assert.equal(
    repositories.privateDeliveries.loadRecipient("42").filtered.readmit,
    undefined,
  );

  repositories.telegram.saveUser(botUser(42));
  repositories.telegram.commitUpdate(8, {
    user: botUser(42, {
      active: false,
      pendingFilterInput: null,
      deletionPendingAt: TIME,
    }),
  });
  assert.equal(repositories.telegram.load().updateOffset, 8);
  assert.equal(repositories.telegram.load().users[42].deletionPendingAt, TIME);
  assert.deepEqual(
    repositories.telegram.deleteUserAndPrivateDeliveries(
      42,
      repositories.privateDeliveries,
    ),
    {
      userDeleted: 1,
      recipientDeleted: 1,
    },
  );
  assert.equal(repositories.telegram.load().users[42], undefined);
  assert.equal(repositories.telegram.load().legacyRecipientId, undefined);
  assert.equal(repositories.privateDeliveries.loadRecipient("42"), undefined);

  repositories.exchangeRates.save(rateSnapshot());
  assert.throws(
    () => repositories.exchangeRates.save({ ...rateSnapshot(), rates: {} }),
    /incompatible schema/u,
  );
  assert.deepEqual(repositories.exchangeRates.load(), rateSnapshot());
});

test("all five domains can import in one outer transaction", (t) => {
  const directory = temporaryDirectory(t);
  const database = openDatabase(directory);
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_URL,
    channelId: CHANNEL_ID,
  });

  database.transaction("state_import", () => {
    repositories.apartments.importState(apartmentState(), {
      transaction: false,
    });
    repositories.privateDeliveries.importState(
      {
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
      },
      { transaction: false },
    );
    repositories.channelDeliveries.importState(
      {
        version: 1,
        type: "telegram-channel-deliveries",
        channelId: CHANNEL_ID,
        urlTemplate: LIST_URL,
        initialized: true,
        filterFingerprint: HASH,
        apartments: {
          10: {
            status: "published",
            classifiedAt: TIME,
            messageId: 1,
            contentHash: HASH,
            publishedAt: TIME,
          },
        },
      },
      { transaction: false },
    );
    repositories.telegram.importState(
      {
        version: 3,
        type: "telegram-bot",
        updateOffset: 1,
        users: { 42: botUser(42) },
      },
      { transaction: false },
    );
    repositories.exchangeRates.importState(rateSnapshot(), {
      transaction: false,
    });
  });
  assert.deepEqual(database.logicalCounts(), {
    apartments: 2,
    privateRecipients: 1,
    privateDecisions: 1,
    channelDeliveries: 1,
    telegramUsers: 1,
    exchangeRateSnapshots: 1,
  });
});
