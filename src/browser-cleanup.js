import {
  lstat,
  readdir,
  readFile,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { acquireSingletonLock } from "./singleton-lock.js";

// Only the retired, fixed-name profile is eligible. Never accept a caller path.
export async function cleanupBrowserProfile(
  dataDirectory,
  { apply = false } = {},
) {
  const root = path.resolve(dataDirectory);
  if (root === path.parse(root).root || (await realpath(root)) !== root) {
    throw new Error("Unsafe data directory: symbolic link or filesystem root");
  }
  const owner = await lstat(root);
  if (!owner.isDirectory() || owner.uid !== process.getuid()) {
    throw new Error("Data directory is not owned by the service account");
  }
  const candidate = path.join(root, "chrome-profile");
  const lease = await acquireSingletonLock(root);
  try {
    const entries = [];
    async function inspect(filename, top = false) {
      let stat;
      try {
        stat = await lstat(filename);
      } catch (error) {
        if (top && error.code === "ENOENT") return;
        throw error;
      }
      if (
        stat.uid !== owner.uid ||
        stat.dev !== owner.dev ||
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1) ||
        (top && !stat.isDirectory())
      ) {
        throw new Error(
          `Unsafe or ambiguously owned profile entry: ${filename}`,
        );
      }
      if (stat.isDirectory()) {
        for (const name of await readdir(filename))
          await inspect(path.join(filename, name));
      }
      entries.push({ filename, stat });
    }
    await inspect(candidate, true);
    const candidateBytes = entries.reduce(
      (sum, { stat }) => sum + stat.blocks * 512,
      0,
    );
    if (apply) {
      // Validate the whole tree first; then recheck each inode before unlinking.
      for (const { filename, stat } of entries) {
        const current = await lstat(filename);
        if (
          current.ino !== stat.ino ||
          current.dev !== stat.dev ||
          current.uid !== stat.uid ||
          current.mode !== stat.mode ||
          (current.isFile() && current.nlink !== 1)
        ) {
          throw new Error(`Profile changed during cleanup: ${filename}`);
        }
        if (stat.isDirectory()) await rmdir(filename);
        else await unlink(filename);
      }
    }
    return {
      mode: apply ? "apply" : "dry-run",
      candidate,
      paths: entries.map(({ filename }) => filename),
      candidateBytes,
      reclaimedBytes: apply ? candidateBytes : 0,
      missing: entries.length === 0,
    };
  } finally {
    await lease.release();
  }
}

export async function browserBackupUsage(backupDirectory) {
  const root = path.resolve(backupDirectory);
  if (root === path.parse(root).root || (await realpath(root)) !== root) {
    throw new Error("Unsafe backup directory");
  }
  const rootStat = await lstat(root);
  async function bytes(filename) {
    const stat = await lstat(filename);
    if (
      stat.isSymbolicLink() ||
      stat.dev !== rootStat.dev ||
      (!stat.isDirectory() && !stat.isFile())
    )
      throw new Error(`Unsafe backup entry: ${filename}`);
    let total = stat.blocks * 512;
    if (stat.isDirectory()) {
      for (const name of await readdir(filename))
        total += await bytes(path.join(filename, name));
    }
    return total;
  }
  const retainedBackupBytes = await bytes(root);
  const snapshots = [];
  for (const category of ["daily", "weekly", "protected"]) {
    const directory = path.join(root, category);
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      const snapshot = path.join(directory, name);
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(path.join(snapshot, "manifest.json"), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      const browser = Object.keys(manifest?.hashes || {}).some((entry) =>
        /chrome-profile|chromium/i.test(entry),
      );
      const kind = browser
        ? "legacy-browser"
        : manifest?.version === 3
          ? "browser-free"
          : "legacy-or-unknown";
      snapshots.push({ path: snapshot, kind, bytes: await bytes(snapshot) });
    }
  }
  return {
    retainedBackupBytes,
    snapshots,
    legacyBrowserBytes: snapshots
      .filter(({ kind }) => kind === "legacy-browser")
      .reduce((sum, item) => sum + item.bytes, 0),
    browserFreeBytes: snapshots
      .filter(({ kind }) => kind === "browser-free")
      .reduce((sum, item) => sum + item.bytes, 0),
    legacyOrUnknownBytes: snapshots
      .filter(({ kind }) => kind === "legacy-or-unknown")
      .reduce((sum, item) => sum + item.bytes, 0),
  };
}
