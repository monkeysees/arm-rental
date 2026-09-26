import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupBrowserProfile,
  browserBackupUsage,
} from "../src/browser-cleanup.js";
const binary = process.env.RENTAL_APP_BINARY;
test(
  "native retired browser cleanup matches Node inventory and rejects symlinks",
  { skip: !binary },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "native-browser-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const data = path.join(root, "data");
    const backup = path.join(root, "backup");
    const profile = path.join(data, "chrome-profile");
    await mkdir(path.join(profile, "nested"), { recursive: true });
    await writeFile(path.join(profile, "nested", "cache"), "old browser data");
    const run = (option) =>
      spawnSync(binary, ["browser:cleanup", option], {
        env: {
          TELEGRAM_BOT_TOKEN: "123:test",
          TELEGRAM_OWNER_ID: "123",
          DATA_DIRECTORY: data,
          BACKUP_DIRECTORY: backup,
        },
        encoding: "utf8",
      });
    const expected = await cleanupBrowserProfile(data);
    let result = run("--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      event: "browser-cleanup.report",
      ...expected,
    });
    await symlink(
      path.join(profile, "nested", "cache"),
      path.join(profile, "unsafe"),
    );
    assert.notEqual(run("--apply").status, 0);
    await access(path.join(profile, "nested", "cache"));
    await rm(path.join(profile, "unsafe"));
    result = run("--apply");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      event: "browser-cleanup.report",
      ...expected,
      mode: "apply",
      reclaimedBytes: expected.candidateBytes,
    });
    assert.equal(JSON.parse(run("--dry-run").stdout).missing, true);
    for (const [name, manifest] of [
      ["old", { version: 2, hashes: { "chrome-profile/cache": "x" } }],
      ["new", { version: 3, hashes: { "state.sqlite3": "x" } }],
    ]) {
      const directory = path.join(backup, "daily", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(manifest),
      );
    }
    const usage = await browserBackupUsage(backup);
    result = run("--backup-report");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      event: "browser-cleanup.backup-usage",
      ...usage,
    });
  },
);
