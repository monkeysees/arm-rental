import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  await writeFile(filename, "{invalid", "utf8");
  await assert.rejects(readState(filename), /State file is not valid JSON/);
});
