import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getConfig, validateStartupConfig } from "../src/config.js";
import {
  parseStateBackendSelector,
  requireBridgeJsonBackend,
  stateBackendPaths,
  StateBackendError,
} from "../src/state-backend.js";
import { writeState } from "../src/state.js";

test("selector parsing is strict for every authoritative backend state", () => {
  assert.deepEqual(parseStateBackendSelector(undefined), {
    backend: "json",
    version: 1,
    implicit: true,
  });
  assert.deepEqual(parseStateBackendSelector({ backend: "json", version: 1 }), {
    backend: "json",
    version: 1,
    implicit: false,
  });
  assert.equal(
    parseStateBackendSelector({
      backend: "migrating",
      version: 1,
      migrationId: "migration-1",
      sourceHashes: { apartments: "a".repeat(64) },
    }).backend,
    "migrating",
  );
  assert.equal(
    parseStateBackendSelector({
      backend: "sqlite",
      version: 1,
      migrationId: "migration-1",
      databaseId: "database-1",
    }).backend,
    "sqlite",
  );

  for (const invalid of [
    null,
    { backend: "json", version: 2 },
    { backend: "json", version: 1, databaseId: "surprise" },
    {
      backend: "migrating",
      version: 1,
      migrationId: "migration-1",
      sourceHashes: {},
    },
    {
      backend: "sqlite",
      version: 1,
      migrationId: "migration-1",
      databaseId: "bad identifier/with/path",
    },
  ]) {
    assert.throws(() => parseStateBackendSelector(invalid), StateBackendError);
  }
});

test("bridge startup accepts absent or JSON selectors and refuses migration states", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backend-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, "data");
  const config = getConfig(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_OWNER_ID: "42",
      DATA_DIRECTORY: dataDirectory,
    },
    root,
  );
  const paths = stateBackendPaths(dataDirectory);

  await validateStartupConfig(config);
  await writeState(paths.selector, { backend: "json", version: 1 });
  await validateStartupConfig(config);

  for (const selector of [
    {
      backend: "migrating",
      version: 1,
      migrationId: "migration-1",
      sourceHashes: { apartments: "a".repeat(64) },
    },
    {
      backend: "sqlite",
      version: 1,
      migrationId: "migration-1",
      databaseId: "database-1",
    },
  ]) {
    await writeState(paths.selector, selector);
    await assert.rejects(
      requireBridgeJsonBackend(dataDirectory),
      (error) =>
        error instanceof StateBackendError &&
        error.code === "ERR_STATE_BACKEND_UNSUPPORTED" &&
        error.backend === selector.backend,
    );
    await assert.rejects(validateStartupConfig(config), /bridge release/u);
  }
});

test("future SQLite and migration paths are exact children of data storage", () => {
  assert.deepEqual(stateBackendPaths("/srv/app-data"), {
    selector: "/srv/app-data/state-backend.json",
    database: "/srv/app-data/state.sqlite3",
    databaseWal: "/srv/app-data/state.sqlite3-wal",
    databaseShm: "/srv/app-data/state.sqlite3-shm",
    migrationWorkDirectory: "/srv/app-data/.state-migration",
    migrationDatabase: "/srv/app-data/.state-migration/state.sqlite3.tmp",
  });
});
