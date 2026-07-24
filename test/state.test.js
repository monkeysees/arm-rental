import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readState, writeState } from "../src/state.js";

test("state is atomically persisted and malformed JSON is reported clearly", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rental-appts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "nested", "state.json");

  assert.equal(await readState(filename), undefined);
  await writeState(filename, { version: 1, value: "saved" });
  assert.deepEqual(await readState(filename), {
    version: 1,
    value: "saved",
  });
  assert.equal((await lstat(filename)).mode & 0o777, 0o600);

  await writeFile(filename, "{invalid", "utf8");
  await assert.rejects(
    readState(filename),
    (error) =>
      error.code === "ERR_STATE_INVALID_JSON" &&
      /State file is not valid JSON/u.test(error.message),
  );
});

test("state write flushes a mode-0600 temporary file and containing directory", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rental-appts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "state.json");
  const syncs = [];

  await writeState(
    filename,
    { version: 1, value: "durable" },
    {
      operations: {
        open: async (openedPath, flags, mode) => {
          const handle = await open(openedPath, flags, mode);
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            syncs.push(openedPath);
            if (openedPath !== directory) {
              assert.equal((await lstat(openedPath)).mode & 0o777, 0o600);
            }
            await originalSync();
          };
          return handle;
        },
      },
    },
  );

  assert.equal(
    syncs.some((syncedPath) => syncedPath === directory),
    true,
  );
  assert.equal(
    syncs.some((syncedPath) => syncedPath.endsWith(".tmp")),
    true,
  );
  assert.equal((await lstat(filename)).mode & 0o777, 0o600);
});

test("flush, rename, validation, and directory-sync failures preserve prior state", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rental-appts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "state.json");
  const prior = `${JSON.stringify({ version: 1, value: "prior" }, null, 2)}\n`;

  const cases = [
    {
      name: "file flush",
      operations: {
        open: async (openedPath, flags, mode) => {
          const handle = await open(openedPath, flags, mode);
          if (openedPath.endsWith(".tmp")) {
            handle.sync = async () => {
              throw Object.assign(new Error("flush failed"), { code: "EIO" });
            };
          }
          return handle;
        },
      },
    },
    {
      name: "rename",
      operations: {
        rename: async () => {
          throw Object.assign(new Error("rename failed"), { code: "EIO" });
        },
      },
    },
    {
      name: "directory sync",
      operations: {
        open: async (openedPath, flags, mode) => {
          const handle = await open(openedPath, flags, mode);
          if (openedPath === directory) {
            handle.sync = async () => {
              throw Object.assign(new Error("directory sync failed"), {
                code: "EIO",
              });
            };
          }
          return handle;
        },
      },
    },
  ];

  for (const failure of cases) {
    await writeFile(filename, prior, { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      writeState(
        filename,
        { version: 1, value: failure.name },
        { operations: failure.operations },
      ),
    );
    assert.equal(await readFile(filename, "utf8"), prior);
  }

  await assert.rejects(
    writeState(
      filename,
      { version: 2, value: "incompatible" },
      { validateSerialized: ({ version }) => version === 1 },
    ),
    /failed validation/u,
  );
  assert.equal(await readFile(filename, "utf8"), prior);
});
