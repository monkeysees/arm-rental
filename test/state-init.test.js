import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openApplicationState } from "../src/application-state.js";
import { getConfig } from "../src/config.js";
import { acquireSingletonLock } from "../src/singleton-lock.js";
import { stateDatabasePaths } from "../src/sqlite-database.js";
import { initializeState } from "../src/state-init.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rental-state-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return getConfig(
    {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_CHANNEL_ID: "@rentals",
      DATA_DIRECTORY: path.join(root, "data"),
    },
    root,
  );
}

test("state initialization creates the one database a first install starts from", async (t) => {
  const config = await fixture(t);
  const result = await initializeState(config);

  assert.equal(
    result.database,
    stateDatabasePaths(config.dataDirectory).database,
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.listUrlTemplate, config.listUrlTemplate);
  assert.equal(result.channelId, config.telegramChannelId);
  assert.match(result.databaseId, /^[0-9a-f-]{36}$/u);

  // The application refuses to create a database, so a host is startable only
  // because initialization ran: this is the whole first-install path.
  const state = await openApplicationState(config);
  assert.equal(state.backend, "sqlite");
  assert.deepEqual(await state.stateAccess.telegram.load(), {
    version: 3,
    type: "telegram-bot",
    updateOffset: 0,
    users: {},
  });
  state.close();
});

test("state initialization refuses an installed database and a live service", async (t) => {
  const config = await fixture(t);
  const { databaseId } = await initializeState(config);
  const paths = stateDatabasePaths(config.dataDirectory);
  const before = await readFile(paths.database);

  // Discarding stored state is an operator decision made through a restore,
  // never a side effect of re-running initialization.
  await assert.rejects(
    initializeState(config),
    (error) => error.code === "ERR_STATE_ALREADY_INITIALIZED",
  );
  assert.deepEqual(await readFile(paths.database), before);
  const reopened = await openApplicationState(config);
  assert.equal(
    reopened.database
      .prepare(
        "SELECT database_id FROM application_metadata WHERE singleton = 1",
      )
      .get().database_id,
    databaseId,
  );
  reopened.close();

  const fresh = await fixture(t);
  const liveServiceLease = await acquireSingletonLock(fresh.dataDirectory);
  try {
    await assert.rejects(
      initializeState(fresh),
      (error) => error.code === "ERR_SINGLETON_LOCKED",
    );
  } finally {
    await liveServiceLease.release();
  }
  // A refused initialization leaves nothing behind for startup to adopt.
  await assert.rejects(
    lstat(stateDatabasePaths(fresh.dataDirectory).database),
    (error) => error.code === "ENOENT",
  );
});
