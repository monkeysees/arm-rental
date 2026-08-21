import path from "node:path";

import { readState } from "./state.js";

export const STATE_BACKEND_SELECTOR_VERSION = 1;
export const JSON_STATE_SCHEMA_VERSION = 0;

const BACKENDS = new Set(["json", "migrating", "sqlite"]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class StateBackendError extends Error {
  constructor(message, { backend, cause } = {}) {
    super(message, { cause });
    this.name = "StateBackendError";
    this.code = "ERR_STATE_BACKEND_UNSUPPORTED";
    this.backend = backend;
  }
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function validSourceHashes(value) {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([name, hash]) =>
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(name) && SHA256.test(hash),
    )
  );
}

/**
 * Returns the fixed paths understood by both the bridge restore and the future
 * SQLite migration. None are configurable independently, so state cannot be
 * redirected outside DATA_DIRECTORY.
 */
export function stateBackendPaths(dataDirectory) {
  const root = path.resolve(dataDirectory);
  const database = path.join(root, "state.sqlite3");
  const migrationWorkDirectory = path.join(root, ".state-migration");
  return Object.freeze({
    selector: path.join(root, "state-backend.json"),
    database,
    databaseWal: `${database}-wal`,
    databaseShm: `${database}-shm`,
    migrationWorkDirectory,
    migrationDatabase: path.join(migrationWorkDirectory, "state.sqlite3.tmp"),
  });
}

/**
 * An absent selector is only meaningful to callers that predate one: the bridge
 * startup check and the JSON→SQLite tooling, which both run before a selector
 * file exists. Every other caller has to name the backend it opens, so an
 * absent selector is refused rather than silently read as JSON.
 */
export function parseStateBackendSelector(value, { allowAbsent = false } = {}) {
  if (value === undefined) {
    if (!allowAbsent) {
      throw new StateBackendError(
        "State backend selector is absent; state must be migrated to SQLite",
      );
    }
    return Object.freeze({ backend: "json", version: 1, implicit: true });
  }
  if (
    !isRecord(value) ||
    !BACKENDS.has(value.backend) ||
    value.version !== STATE_BACKEND_SELECTOR_VERSION
  ) {
    throw new StateBackendError("State backend selector is incompatible");
  }

  if (value.backend === "json") {
    if (!exactKeys(value, ["backend", "version"])) {
      throw new StateBackendError("JSON state backend selector is malformed", {
        backend: value.backend,
      });
    }
  } else if (value.backend === "migrating") {
    if (
      !exactKeys(value, [
        "backend",
        "migrationId",
        "sourceHashes",
        "version",
      ]) ||
      !IDENTIFIER.test(value.migrationId || "") ||
      !validSourceHashes(value.sourceHashes)
    ) {
      throw new StateBackendError(
        "Migrating state backend selector is malformed",
        { backend: value.backend },
      );
    }
  } else if (
    !exactKeys(value, ["backend", "databaseId", "migrationId", "version"]) ||
    !IDENTIFIER.test(value.migrationId || "") ||
    !IDENTIFIER.test(value.databaseId || "")
  ) {
    throw new StateBackendError("SQLite state backend selector is malformed", {
      backend: value.backend,
    });
  }

  return Object.freeze({ ...value, implicit: false });
}

export async function readStateBackendSelector(
  dataDirectory,
  { allowAbsent = false } = {},
) {
  const { selector } = stateBackendPaths(dataDirectory);
  let value;
  try {
    value = await readState(selector);
  } catch (cause) {
    throw new StateBackendError("State backend selector is unreadable", {
      cause,
    });
  }
  return parseStateBackendSelector(value, { allowAbsent });
}

export async function requireBridgeJsonBackend(dataDirectory) {
  // A bridge release predates the selector file, so a fresh install with no
  // selector is the JSON backend it expects.
  const selector = await readStateBackendSelector(dataDirectory, {
    allowAbsent: true,
  });
  if (selector.backend !== "json") {
    throw new StateBackendError(
      `This bridge release cannot open the ${selector.backend} state backend`,
      { backend: selector.backend },
    );
  }
  return selector;
}
