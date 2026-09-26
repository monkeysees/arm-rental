import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireSingletonLock } from "../src/singleton-lock.js";

const binary = process.env.RENTAL_APP_BINARY;
test(
  "native initialization respects the existing Node singleton lease",
  { skip: !binary },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "rust-lease-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const lease = await acquireSingletonLock(directory);
    t.after(() => lease.release());
    const child = spawn(binary, ["state:init", "--data-directory", directory]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    assert.notEqual(
      await new Promise((resolve) => child.on("exit", resolve)),
      0,
    );
    assert.match(stderr, /ERR_SINGLETON_LOCKED/u);
  },
);
