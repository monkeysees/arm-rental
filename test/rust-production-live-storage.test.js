import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireSingletonLock } from "../src/singleton-lock.js";

const binary = process.env.RENTAL_APP_BINARY;

test(
  "native disk check reads storage while the application is live, but maintenance stays locked",
  { skip: !binary },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "rust-live-storage-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const lease = await acquireSingletonLock(directory);
    t.after(() => lease.release());
    const env = {
      ...process.env,
      DATA_DIRECTORY: directory,
      DISK_FREE_WARNING_PERCENT: "1",
      TELEGRAM_BOT_TOKEN: "123:test",
      TELEGRAM_OWNER_ID: "123",
    };
    const run = (command) =>
      spawnSync(binary, [command], { env, encoding: "utf8" });

    const disk = run("storage:check");
    assert.equal(disk.status, 0, disk.stderr || String(disk.error));
    const result = JSON.parse(disk.stdout);
    const filesystem = statfsSync(directory, { bigint: true });
    assert.equal(
      result.totalBytes,
      Number(filesystem.blocks * filesystem.bsize),
    );
    assert.ok(result.freeBytes > 0);
    assert.ok(result.freeBytes <= result.totalBytes);
    assert.equal(result.status, "ok");

    const maintenance = run("maintenance:report");
    assert.equal(maintenance.status, 1);
    assert.match(maintenance.stderr, /ERR_SINGLETON_LOCKED/u);
  },
);
