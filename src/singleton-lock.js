import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_SOCKET_NAME = ".singleton.sock";
const LOCK_METADATA_NAME = ".singleton.json";
const RECOVERY_DIRECTORY_NAME = ".singleton-recovery";
const MAX_SOCKET_PATH_BYTES = 100;
const RECOVERY_STALE_MS = 10_000;

export class SingletonLockError extends Error {
  constructor(message, owner) {
    super(message);
    this.name = "SingletonLockError";
    this.code = "ERR_SINGLETON_LOCKED";
    this.owner = owner;
  }
}

function lockPaths(dataDirectory) {
  return {
    socket: path.join(dataDirectory, LOCK_SOCKET_NAME),
    metadata: path.join(dataDirectory, LOCK_METADATA_NAME),
    recovery: path.join(dataDirectory, RECOVERY_DIRECTORY_NAME),
  };
}

async function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function probeSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ live: true }), 1_000);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => {
      try {
        finish({ live: true, owner: JSON.parse(response) });
      } catch {
        finish({ live: true });
      }
    });
    socket.once("connect", () => {
      // A successful connection is already sufficient proof of a live owner.
      // Give its short metadata response a chance to improve the error message.
      socket.setTimeout(250, () => finish({ live: true }));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish({ live: false });
        return;
      }
      reject(error);
    });
  });
}

async function writeMetadata(filename, owner) {
  const temporaryFile = `${filename}.${owner.id}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryFile, filename);
}

async function readOwner(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return undefined;
  }
}

async function recoverStaleSocket(paths) {
  try {
    await mkdir(paths.recovery, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const recoveryState = await lstat(paths.recovery).catch((statError) => {
      if (statError.code === "ENOENT") return undefined;
      throw statError;
    });
    if (!recoveryState) return false;
    if (Date.now() - recoveryState.mtimeMs > RECOVERY_STALE_MS) {
      const quarantine = `${paths.recovery}.${process.pid}.${randomUUID()}`;
      try {
        await rename(paths.recovery, quarantine);
        await rm(quarantine, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError.code !== "ENOENT") throw renameError;
      }
    } else {
      await delay(50);
    }
    return false;
  }

  try {
    const probe = await probeSocket(paths.socket);
    if (probe.live) return false;
    await unlink(paths.socket).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  } finally {
    await rm(paths.recovery, { recursive: true, force: true });
  }
}

function contentionMessage(dataDirectory, owner) {
  const ownerDescription = owner?.pid
    ? ` process ${owner.pid} on ${owner.hostname || "an unknown host"}`
    : " another live process";
  return (
    `Cannot start: persistent data directory ${dataDirectory} is already ` +
    `locked by${ownerDescription}. Stop the existing rental-apartments-bot ` +
    "process before starting another instance."
  );
}

export async function acquireSingletonLock(dataDirectory) {
  const resolvedDirectory = path.resolve(dataDirectory);
  const paths = lockPaths(resolvedDirectory);

  if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Persistent data directory path is too long for the singleton socket: ${resolvedDirectory}`,
    );
  }

  await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
  const owner = {
    id: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };

  for (;;) {
    const server = createServer((socket) => {
      socket.end(JSON.stringify(owner));
    });

    try {
      await listen(server, paths.socket);
      await chmod(paths.socket, 0o600);
      const socketIdentity = await lstat(paths.socket);
      await writeMetadata(paths.metadata, owner);
      let released = false;

      return {
        dataDirectory: resolvedDirectory,
        owner,
        async release() {
          if (released) return;
          released = true;
          await closeServer(server);

          const currentSocket = await lstat(paths.socket).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (
            currentSocket?.dev === socketIdentity.dev &&
            currentSocket.ino === socketIdentity.ino
          ) {
            await unlink(paths.socket);
          }

          const currentOwner = await readOwner(paths.metadata);
          if (currentOwner?.id === owner.id) {
            await rm(paths.metadata, { force: true });
          }
        },
      };
    } catch (error) {
      await closeServer(server).catch(() => {});
      if (error.code !== "EADDRINUSE") throw error;

      const probe = await probeSocket(paths.socket);
      if (probe.live) {
        const recordedOwner = probe.owner || (await readOwner(paths.metadata));
        throw new SingletonLockError(
          contentionMessage(resolvedDirectory, recordedOwner),
          recordedOwner,
        );
      }

      await recoverStaleSocket(paths);
    }
  }
}
