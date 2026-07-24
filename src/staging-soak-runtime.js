import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { CHROME_CACHE_PATHS } from "./maintenance.js";

const executeFile = promisify(execFile);

async function treeSize(root) {
  let details;
  try {
    details = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  if (details.isSymbolicLink()) {
    throw new Error(`Soak measurement refuses symbolic links: ${root}`);
  }
  if (details.isFile()) return details.size;
  if (!details.isDirectory()) return 0;

  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) bytes += await treeSize(filename);
    else if (entry.isFile()) bytes += (await lstat(filename)).size;
  }
  return bytes;
}

async function cacheSize(profileDirectory) {
  const sizes = await Promise.all(
    CHROME_CACHE_PATHS.map((relative) =>
      treeSize(path.join(profileDirectory, relative)),
    ),
  );
  return sizes.reduce((total, bytes) => total + bytes, 0);
}

function processTree(rows, rootProcessId) {
  const descendants = new Set([rootProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parentProcessId) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(({ pid }) => descendants.has(pid));
}

async function processRows() {
  const { stdout } = await executeFile("ps", ["-axo", "pid=,ppid=,rss=,comm="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentProcessId: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      command: match[4],
    }));
}

export async function sampleSoakResources(
  processId,
  { profileDirectory, logFilename },
) {
  const processes = processTree(await processRows(), processId);
  if (!processes.some(({ pid }) => pid === processId)) {
    throw new Error("The staging service exited before the soak completed");
  }
  const [profileBytes, cacheBytes, logBytes] = await Promise.all([
    treeSize(profileDirectory),
    cacheSize(profileDirectory),
    treeSize(logFilename),
  ]);
  return {
    rssBytes: processes.reduce((total, row) => total + row.rssBytes, 0),
    chromeProcessCount: processes.filter(({ command }) =>
      /(?:chrome|chromium)/iu.test(command),
    ).length,
    profileBytes,
    cacheBytes,
    logBytes,
  };
}

export async function launchStagingService(_config, env, settings) {
  await mkdir(path.dirname(settings.logFilename), {
    recursive: true,
    mode: 0o700,
  });
  await chmod(path.dirname(settings.logFilename), 0o700);
  const logHandle = await open(settings.logFilename, "a", 0o600);
  await logHandle.chmod(0o600);
  const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: projectDirectory,
    env: { ...env },
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    pid: child.pid,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    async terminate(timeoutMs) {
      if (!this.isRunning()) {
        const result = await exited;
        await logHandle.close();
        return { ...result, forced: false };
      }
      child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        delay(timeoutMs).then(() => undefined),
      ]);
      if (result) {
        await logHandle.close();
        return { ...result, forced: false };
      }
      child.kill("SIGKILL");
      const forcedResult = await exited;
      await logHandle.close();
      return { ...forcedResult, forced: true };
    },
  };
}

export async function waitForReadiness(
  service,
  settings,
  fetchImpl = globalThis.fetch,
) {
  const deadline = Date.now() + settings.readinessTimeoutMs;
  while (Date.now() < deadline) {
    if (!service.isRunning()) {
      throw new Error("The staging service exited before becoming ready");
    }
    try {
      const response = await fetchImpl(settings.healthUrl, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = await response.json();
      if (response.ok && body.ready === true) return;
    } catch {
      // Startup and its external checks are expected to take some time.
    }
    await delay(2_000);
  }
  throw new Error("The staging service did not become ready before timeout");
}

export const sleepForSoak = delay;
