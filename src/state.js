/**
 * The atomic, fsynced, 0600 read/write primitive for the small control files
 * that sit beside the state database: the backend selector, the singleton
 * lease, maintenance history, backup manifests, and operational
 * records. Application state itself lives in SQLite and never comes through
 * here, so a write is a handful of bytes and a failed one rolls itself back.
 */
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

const defaultOperations = {
  link,
  mkdir,
  open,
  rename,
  rm,
};

async function syncDirectory(directory, operations) {
  let handle;
  try {
    handle = await operations.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function serializeState(state, validateSerialized) {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  const parsed = JSON.parse(serialized);
  if (validateSerialized && !validateSerialized(parsed)) {
    throw new Error("Serialized state failed validation");
  }
  return serialized;
}

export async function readState(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      const invalidStateError = new Error(
        `State file is not valid JSON: ${filename}`,
        { cause: error },
      );
      invalidStateError.code = "ERR_STATE_INVALID_JSON";
      throw invalidStateError;
    }
    throw error;
  }
}

export async function writeState(
  filename,
  state,
  { validateSerialized, operations: operationOverrides = {} } = {},
) {
  const operations = { ...defaultOperations, ...operationOverrides };
  const directory = path.dirname(filename);
  let serialized;
  let outcome = "failed";
  const suffix = `${process.pid}.${randomUUID()}`;
  const temporaryFile = `${filename}.${suffix}.tmp`;
  const rollbackFile = `${filename}.${suffix}.previous`;
  let temporaryHandle;
  let priorStateLinked = false;
  let replacementInstalled = false;

  try {
    serialized = serializeState(state, validateSerialized);
    await operations.mkdir(directory, { recursive: true, mode: 0o700 });
    temporaryHandle = await operations.open(temporaryFile, "wx", 0o600);
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.writeFile(serialized, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await operations.link(filename, rollbackFile);
      priorStateLinked = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await operations.rename(temporaryFile, filename);
    replacementInstalled = true;
    await syncDirectory(directory, operations);
    outcome = "completed";
  } catch (error) {
    await temporaryHandle?.close().catch(() => {});

    if (replacementInstalled) {
      try {
        if (priorStateLinked) {
          await operations.rename(rollbackFile, filename);
        } else {
          await operations.rm(filename, { force: true });
        }
        await syncDirectory(directory, operations);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `State write failed and the prior state could not be restored: ${filename}`,
          { cause: rollbackError },
        );
      }
    }

    await operations.rm(temporaryFile, { force: true }).catch(() => {});
    await operations.rm(rollbackFile, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (outcome === "completed" && priorStateLinked) {
      // The renamed entry is already committed, so cleaning up the rollback
      // link is deliberately best effort.
      await operations.rm(rollbackFile, { force: true }).catch(() => {});
    }
  }
}
