import path from "node:path";

import { readState } from "./state.js";

export const STATE_BACKEND_SELECTOR_VERSION = 1;

// "migrating" no longer names anything this release can produce; it stays
// recognised so a selector left behind by an interrupted cutover is refused by
// name instead of being reported as an unreadable file.
const BACKENDS = new Set(["migrating", "sqlite"]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export const STATE_BACKEND_ABSENT = "ERR_STATE_BACKEND_ABSENT";

export class StateBackendError extends Error {
  constructor(message, { backend, cause, code } = {}) {
    super(message, { cause });
    this.name = "StateBackendError";
    this.code = code || "ERR_STATE_BACKEND_UNSUPPORTED";
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
 * Returns the fixed paths that name the state database. None are configurable
 * independently, so state cannot be redirected outside DATA_DIRECTORY.
 */
export function stateBackendPaths(dataDirectory) {
  const root = path.resolve(dataDirectory);
  const database = path.join(root, "state.sqlite3");
  return Object.freeze({
    selector: path.join(root, "state-backend.json"),
    database,
    databaseWal: `${database}-wal`,
    databaseShm: `${database}-shm`,
  });
}

/**
 * Every caller has to name the backend it opens, so an absent selector is
 * refused: this release stores application state only in SQLite, and reading an
 * absent selector as anything else is what used to start the bot on empty state.
 */
export function parseStateBackendSelector(value) {
  if (value === undefined) {
    throw new StateBackendError(
      "State backend selector is absent; this release reads application state only from SQLite",
      { code: STATE_BACKEND_ABSENT },
    );
  }
  if (
    !isRecord(value) ||
    !BACKENDS.has(value.backend) ||
    value.version !== STATE_BACKEND_SELECTOR_VERSION
  ) {
    throw new StateBackendError("State backend selector is incompatible");
  }

  if (value.backend === "migrating") {
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

  return Object.freeze({ ...value });
}

export async function readStateBackendSelector(dataDirectory) {
  const { selector } = stateBackendPaths(dataDirectory);
  let value;
  try {
    value = await readState(selector);
  } catch (cause) {
    throw new StateBackendError("State backend selector is unreadable", {
      cause,
    });
  }
  return parseStateBackendSelector(value);
}
