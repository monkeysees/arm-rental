import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getConfig, validateStartupConfig } from "../src/config.js";
import {
  parseStateBackendSelector,
  readStateBackendSelector,
  stateBackendPaths,
  StateBackendError,
} from "../src/state-backend.js";
import { writeState } from "../src/state.js";

test("selector parsing is strict for every authoritative backend state", () => {
  // No caller may read an absent selector any more: with JSON gone there is no
  // backend an absent selector could name, and reading one as empty SQLite is
  // exactly the silent data loss the selector exists to prevent.
  assert.throws(
    () => parseStateBackendSelector(undefined),
    (error) =>
      error instanceof StateBackendError &&
      /selector is absent/u.test(error.message),
  );
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
    { backend: "json", version: 1 },
    { backend: "sqlite", version: 2 },
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

test("storage validation no longer decides which backend may be opened", async (t) => {
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

  // Storage validation secures paths; the selector is read by whoever opens
  // state. Every command shares one reading of it, so a backup, a maintenance
  // report and startup can no longer disagree about which backend is live.
  await validateStartupConfig(config);
  await assert.rejects(
    readStateBackendSelector(dataDirectory),
    /selector is absent/u,
  );

  await writeState(paths.selector, { backend: "json", version: 1 });
  await validateStartupConfig(config);
  await assert.rejects(
    readStateBackendSelector(dataDirectory),
    (error) =>
      error instanceof StateBackendError &&
      error.code === "ERR_STATE_BACKEND_UNSUPPORTED" &&
      /selector is incompatible/u.test(error.message),
  );

  await writeState(paths.selector, {
    backend: "sqlite",
    version: 1,
    migrationId: "migration-1",
    databaseId: "database-1",
  });
  assert.equal(
    (await readStateBackendSelector(dataDirectory)).databaseId,
    "database-1",
  );
});

test("SQLite paths are exact children of data storage", () => {
  assert.deepEqual(stateBackendPaths("/srv/app-data"), {
    selector: "/srv/app-data/state-backend.json",
    database: "/srv/app-data/state.sqlite3",
    databaseWal: "/srv/app-data/state.sqlite3-wal",
    databaseShm: "/srv/app-data/state.sqlite3-shm",
  });
});
