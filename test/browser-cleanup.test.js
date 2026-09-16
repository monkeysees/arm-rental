import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { acquireSingletonLock } from "../src/singleton-lock.js";
import {
  cleanupBrowserProfile,
  assertNoProfileMounts,
} from "../src/browser-cleanup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, "chrome-profile");
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await writeFile(path.join(profile, "Default", "Cookies"), "retired session");
  for (const name of [
    "state.sqlite3",
    "state.sqlite3-wal",
    "list-am-cookies.txt",
    "unrelated",
  ]) {
    await writeFile(path.join(root, name), name);
  }
  return { root, profile };
}

function cli(root, args = []) {
  return spawnSync(process.execPath, ["src/browser-cleanup-cli.js", ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      DATA_DIRECTORY: root,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
    },
    encoding: "utf8",
  });
}

test("public CLI defaults to dry run, removes only profile on apply, and repeats safely", async (t) => {
  const { root, profile } = await fixture(t);
  const dry = cli(root);
  assert.equal(dry.status, 0, dry.stderr);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.mode, "dry-run");
  assert.ok(report.candidateBytes > 0);
  assert.equal(report.reclaimedBytes, 0);
  assert.equal(report.candidate, profile);
  assert.equal(
    await readFile(path.join(profile, "Default", "Cookies"), "utf8"),
    "retired session",
  );
  const applied = cli(root, ["--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(
    JSON.parse(applied.stdout).reclaimedBytes,
    report.candidateBytes,
  );
  assert.deepEqual((await readdir(root)).sort(), [
    "list-am-cookies.txt",
    "state.sqlite3",
    "state.sqlite3-wal",
    "unrelated",
  ]);
  for (const name of await readdir(root))
    assert.equal(await readFile(path.join(root, name), "utf8"), name);
  const repeated = cli(root, ["--apply"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).reclaimedBytes, 0);
  assert.equal(JSON.parse(repeated.stdout).missing, true);
});

test("rejects symlink trees, hardlinks, non-directory candidate, and symlink ancestors before deletion", async (t) => {
  const { root, profile } = await fixture(t);
  const unsafe = path.join(profile, "unsafe");
  await symlink(path.join(root, "state.sqlite3"), unsafe);
  assert.notEqual(cli(root, ["--apply"]).status, 0);
  await rm(unsafe);
  await link(path.join(root, "state.sqlite3"), unsafe);
  assert.notEqual(cli(root, ["--apply"]).status, 0);
  await rm(unsafe);
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { force: true }));
  await symlink(root, alias);
  assert.notEqual(cli(alias, ["--apply"]).status, 0);
  assert.equal(
    await readFile(path.join(profile, "Default", "Cookies"), "utf8"),
    "retired session",
  );
  await rm(profile, { recursive: true });
  await writeFile(profile, "unknown file");
  assert.notEqual(cli(root, ["--apply"]).status, 0);
  assert.equal(await readFile(profile, "utf8"), "unknown file");
});

test("live singleton lease blocks cleanup without disturbing its owner", async (t) => {
  const { root, profile } = await fixture(t);
  const lease = await acquireSingletonLock(root);
  try {
    await assert.rejects(cleanupBrowserProfile(root, { apply: true }), {
      code: "ERR_SINGLETON_LOCKED",
    });
    assert.equal(
      await readFile(path.join(profile, "Default", "Cookies"), "utf8"),
      "retired session",
    );
    await assert.rejects(acquireSingletonLock(root), {
      code: "ERR_SINGLETON_LOCKED",
    });
  } finally {
    await lease.release();
  }
});

test("backup inventory separates legacy browser bytes and preserves all snapshots", async (t) => {
  const { root } = await fixture(t);
  const backup = path.join(root, "backups");
  for (const [name, manifest] of [
    ["daily/old", { version: 2, hashes: { "chrome-profile/Cookies": "hash" } }],
    ["daily/new", { version: 3, hashes: { "state.sqlite3": "hash" } }],
    ["protected/rollback", { version: 1 }],
  ]) {
    const directory = path.join(backup, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest),
    );
    await writeFile(path.join(directory, "data"), "retained");
  }
  const { browserBackupUsage } = await import("../src/browser-cleanup.js");
  const report = await browserBackupUsage(backup);
  assert.equal(report.snapshots.length, 3);
  assert.ok(report.legacyBrowserBytes > 0);
  assert.ok(report.browserFreeBytes > 0);
  assert.ok(report.legacyOrUnknownBytes > 0);
  for (const entry of report.snapshots)
    assert.equal(
      await readFile(path.join(entry.path, "data"), "utf8"),
      "retained",
    );
  await symlink(root, path.join(backup, "outside"));
  await assert.rejects(browserBackupUsage(backup), /Unsafe backup entry/u);
});

test("mount boundaries reject same-device bind mounts and escaped paths", () => {
  const candidate = "/data/service space/chrome-profile";
  const line = (mountpoint) =>
    `101 20 8:1 / ${mountpoint} rw - ext4 /dev/root rw`;
  const root = line("/data/service\\040space");
  assert.doesNotThrow(() => assertNoProfileMounts(candidate, root));
  assert.doesNotThrow(() =>
    assertNoProfileMounts(
      candidate,
      `${root}\n${line("/data/service\\040space/chrome-profile-other")}`,
    ),
  );
  for (const mounted of [
    "/data/service\\040space/chrome-profile",
    "/data/service\\040space/chrome-profile/Default",
    "/data/service\\040space/chrome-profile/Default/Cookies",
  ]) {
    assert.throws(
      () => assertNoProfileMounts(candidate, `${root}\n${line(mounted)}`),
      /Unsafe mounted profile entry/u,
    );
  }
  assert.throws(() => assertNoProfileMounts(candidate, ""), /Cannot verify/u);
  assert.throws(
    () => assertNoProfileMounts(candidate, "unexpected format"),
    /Cannot verify/u,
  );
});
