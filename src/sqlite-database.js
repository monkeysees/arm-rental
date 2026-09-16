import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { finishDecisionCompaction } from "./sqlite-decisions-migration.js";

import {
  applySqliteMigrations,
  SQLITE_APPLICATION_ID,
  SQLITE_SCHEMA_VERSION,
} from "./sqlite-schema.js";

const MINIMUM_WAL_SAFE_SQLITE = [3, 51, 3];
const STATE_DATABASE_BASENAME = "state.sqlite3";

function versionAtLeast(actual, minimum) {
  const parts = String(actual).split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((parts[index] ?? 0) > minimum[index]) return true;
    if ((parts[index] ?? 0) < minimum[index]) return false;
  }
  return true;
}

function canonicalChannelId(channelId) {
  return channelId === undefined || channelId === null || channelId === ""
    ? null
    : String(channelId);
}

function fileBytes(filename) {
  try {
    return statSync(filename).size;
  } catch {
    return 0;
  }
}

function emitMetric(observer, metric) {
  try {
    observer(metric);
  } catch {
    // Observability cannot alter the durability result.
  }
}

function mappedDatabaseError(error, operation) {
  if (error instanceof StateDatabaseError) return error;
  const runtimeCode = String(error?.code || "");
  const sqliteResultCode = Number.isInteger(error?.errcode)
    ? error.errcode
    : undefined;
  const primaryResultCode =
    sqliteResultCode === undefined ? undefined : sqliteResultCode & 0xff;
  const code =
    runtimeCode.startsWith("SQLITE_BUSY") || primaryResultCode === 5
      ? "ERR_STATE_DATABASE_BUSY"
      : runtimeCode.startsWith("SQLITE_CONSTRAINT") || primaryResultCode === 19
        ? "ERR_STATE_DATABASE_CONSTRAINT"
        : "ERR_STATE_DATABASE_OPERATION";
  return new StateDatabaseError(
    `State database ${operation} failed`,
    code,
    sqliteResultCode,
  );
}

export const STATE_DATABASE_ABSENT = "ERR_STATE_DATABASE_ABSENT";

export class StateDatabaseError extends Error {
  constructor(message, code, sqliteResultCode) {
    super(message);
    this.name = "StateDatabaseError";
    this.code = code;
    if (Number.isInteger(sqliteResultCode)) {
      this.sqliteResultCode = sqliteResultCode;
    }
  }
}

export class StateDatabase {
  constructor(
    database,
    filename,
    { onMetric = () => {}, monotonicNow = () => performance.now() } = {},
  ) {
    this.connection = database;
    this.filename = filename;
    this.onMetric = onMetric;
    this.monotonicNow = monotonicNow;
    this.closed = false;
  }

  prepare(sql) {
    if (this.closed)
      throw new StateDatabaseError(
        "State database is closed",
        "ERR_STATE_DATABASE_CLOSED",
      );
    return this.connection.prepare(sql);
  }

  transaction(operation, callback) {
    if (
      typeof operation !== "string" ||
      !/^[a-z][a-z0-9_]*$/u.test(operation)
    ) {
      throw new TypeError(
        "Database transaction operation must be a stable identifier",
      );
    }
    if (typeof callback !== "function")
      throw new TypeError("Database transaction callback is required");
    const startedAt = this.monotonicNow();
    const changesBefore = Number(
      this.connection.prepare("SELECT total_changes() AS count").get().count,
    );
    let outcome = "failed";
    let errorCode;
    let sqliteResultCode;
    try {
      this.connection.exec("BEGIN IMMEDIATE");
      const result = callback();
      if (result && typeof result.then === "function") {
        throw new TypeError(
          "Database transactions cannot use asynchronous callbacks",
        );
      }
      this.connection.exec("COMMIT");
      outcome = "completed";
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // The original failure remains the actionable one.
      }
      const mapped = mappedDatabaseError(error, "transaction");
      errorCode = mapped.code;
      sqliteResultCode = mapped.sqliteResultCode;
      throw mapped;
    } finally {
      emitMetric(this.onMetric, {
        name: `state.transaction.${outcome}`,
        component: "storage",
        operation,
        rowsChanged:
          outcome === "completed"
            ? Math.max(
                0,
                Number(
                  this.connection
                    .prepare("SELECT total_changes() AS count")
                    .get().count,
                ) - changesBefore,
              )
            : 0,
        durationMs: Math.max(0, this.monotonicNow() - startedAt),
        databaseBytes: fileBytes(this.filename),
        walBytes: fileBytes(`${this.filename}-wal`),
        schemaVersion: SQLITE_SCHEMA_VERSION,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        ...(Number.isInteger(sqliteResultCode) ? { sqliteResultCode } : {}),
      });
    }
  }

  validate({ full = false } = {}) {
    const pragma = full ? "integrity_check" : "quick_check";
    const rows = this.connection.prepare(`PRAGMA ${pragma}`).all();
    const valid = rows.length === 1 && Object.values(rows[0])[0] === "ok";
    if (!valid) {
      throw new StateDatabaseError(
        "State database integrity validation failed",
        "ERR_STATE_DATABASE_INTEGRITY",
      );
    }
    const foreignKeys = this.connection
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeys.length > 0) {
      throw new StateDatabaseError(
        "State database foreign-key validation failed",
        "ERR_STATE_DATABASE_FOREIGN_KEYS",
      );
    }
    return true;
  }

  logicalCounts() {
    const count = (table) =>
      Number(
        this.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()
          .count,
      );
    return {
      apartments: count("apartments"),
      privateRecipients: count("private_recipients"),
      privateDecisions: count("private_delivery_decisions"),
      channelDeliveries: count("channel_deliveries"),
      telegramUsers: count("telegram_users"),
      exchangeRateSnapshots: count("exchange_rate_state"),
    };
  }

  checkpoint(mode = "TRUNCATE") {
    if (!new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]).has(mode)) {
      throw new TypeError("Unsupported SQLite checkpoint mode");
    }
    const startedAt = this.monotonicNow();
    let outcome = "failed";
    let errorCode;
    let sqliteResultCode;
    try {
      const result = this.connection
        .prepare(`PRAGMA wal_checkpoint(${mode})`)
        .get();
      if (Number(result.busy) !== 0) {
        throw new StateDatabaseError(
          "State database checkpoint remained busy",
          "ERR_STATE_DATABASE_CHECKPOINT_BUSY",
        );
      }
      outcome = "completed";
      return result;
    } catch (error) {
      const mapped = mappedDatabaseError(error, "checkpoint");
      errorCode = mapped.code;
      sqliteResultCode = mapped.sqliteResultCode;
      throw mapped;
    } finally {
      emitMetric(this.onMetric, {
        name: `state.checkpoint.${outcome}`,
        component: "storage",
        operation: "checkpoint",
        durationMs: Math.max(0, this.monotonicNow() - startedAt),
        databaseBytes: fileBytes(this.filename),
        walBytes: fileBytes(`${this.filename}-wal`),
        schemaVersion: SQLITE_SCHEMA_VERSION,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        ...(Number.isInteger(sqliteResultCode) ? { sqliteResultCode } : {}),
      });
    }
  }

  close({ checkpoint = true } = {}) {
    if (this.closed) return;
    if (checkpoint) this.checkpoint("TRUNCATE");
    this.connection.close();
    this.closed = true;
  }
}

function secureDataDirectory(dataDirectory) {
  const resolved = path.resolve(dataDirectory);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const details = lstatSync(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new StateDatabaseError(
      "State data directory must be a real directory",
      "ERR_STATE_DATABASE_PATH",
    );
  }
  return resolved;
}

/**
 * Returns the fixed paths that name the state database. None are configurable
 * independently, so state cannot be redirected outside DATA_DIRECTORY.
 */
export function stateDatabasePaths(dataDirectory) {
  const database = path.join(
    path.resolve(dataDirectory),
    STATE_DATABASE_BASENAME,
  );
  return Object.freeze({
    database,
    databaseWal: `${database}-wal`,
    databaseShm: `${database}-shm`,
  });
}

function validateExistingFile(filename) {
  const details = lstatSync(filename);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new StateDatabaseError(
      "State database path must be a regular file",
      "ERR_STATE_DATABASE_PATH",
    );
  }
  if ((details.mode & 0o777) !== 0o600) {
    throw new StateDatabaseError(
      "State database permissions must be 0600",
      "ERR_STATE_DATABASE_MODE",
    );
  }
}

export function openStateDatabase({
  dataDirectory,
  listUrlTemplate,
  channelId = null,
  create = false,
  databaseId = randomUUID(),
  migratedFrom = null,
  migrationId = null,
  sourceRevision,
  now = () => new Date(),
  onMetric = () => {},
  monotonicNow,
} = {}) {
  if (typeof dataDirectory !== "string" || dataDirectory.length === 0) {
    throw new TypeError("State data directory is required");
  }
  if (typeof listUrlTemplate !== "string" || listUrlTemplate.length === 0) {
    throw new TypeError("List.am URL template is required");
  }
  const directory = secureDataDirectory(dataDirectory);
  const filename = path.join(directory, STATE_DATABASE_BASENAME);
  let created = false;
  try {
    validateExistingFile(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Only an explicit initialization may bring a database into existence.
    // Every runtime caller opens what is already there, so a data directory
    // that lost its state fails closed instead of starting on empty rows.
    if (!create) {
      throw new StateDatabaseError(
        "State database is absent; initialize one with state:init",
        STATE_DATABASE_ABSENT,
      );
    }
    created = true;
    // Establish the final mode before SQLite can write a header or journal.
    closeSync(openSync(filename, "wx", 0o600));
  }

  let connection;
  try {
    connection = new DatabaseSync(filename, {
      enableForeignKeyConstraints: false,
      timeout: 5_000,
    });
    const sqliteVersion = connection
      .prepare("SELECT sqlite_version() AS version")
      .get().version;
    if (!versionAtLeast(sqliteVersion, MINIMUM_WAL_SAFE_SQLITE)) {
      throw new StateDatabaseError(
        "Bundled SQLite is too old for WAL",
        "ERR_STATE_DATABASE_SQLITE_VERSION",
      );
    }
    const applicationId = Number(
      connection.prepare("PRAGMA application_id").get().application_id,
    );
    const userVersion = Number(
      connection.prepare("PRAGMA user_version").get().user_version,
    );
    if (!created && applicationId !== SQLITE_APPLICATION_ID) {
      throw new StateDatabaseError(
        "State database has an unexpected application identity",
        "ERR_STATE_DATABASE_APPLICATION_ID",
      );
    }
    if (!created && userVersion === 0) {
      throw new StateDatabaseError(
        "Existing state database has no schema version",
        "ERR_STATE_DATABASE_SCHEMA_MISSING",
      );
    }
    if (userVersion > SQLITE_SCHEMA_VERSION) {
      throw new StateDatabaseError(
        "State database schema is newer than this application",
        "ERR_STATE_DATABASE_SCHEMA_NEWER",
      );
    }

    const normalizedChannelId = canonicalChannelId(channelId);
    if (!created) {
      const metadata = connection
        .prepare("SELECT * FROM application_metadata WHERE singleton = 1")
        .get();
      if (!metadata) {
        throw new StateDatabaseError(
          "State database metadata is missing",
          "ERR_STATE_DATABASE_METADATA",
        );
      }
      if (
        metadata.list_url_template !== listUrlTemplate ||
        metadata.channel_id !== normalizedChannelId
      ) {
        throw new StateDatabaseError(
          "State database belongs to a different target",
          "ERR_STATE_DATABASE_TARGET",
        );
      }
    }

    if (created)
      connection.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID}`);
    const journal = connection
      .prepare("PRAGMA journal_mode = WAL")
      .get().journal_mode;
    if (String(journal).toLowerCase() !== "wal") {
      throw new StateDatabaseError(
        "State database could not enable WAL",
        "ERR_STATE_DATABASE_JOURNAL_MODE",
      );
    }
    connection.exec("PRAGMA synchronous = FULL");
    connection.exec("PRAGMA foreign_keys = ON");
    connection.exec("PRAGMA busy_timeout = 5000");
    if (
      Number(connection.prepare("PRAGMA foreign_keys").get().foreign_keys) !== 1
    ) {
      throw new StateDatabaseError(
        "State database foreign keys are disabled",
        "ERR_STATE_DATABASE_PRAGMA",
      );
    }
    if (
      Number(connection.prepare("PRAGMA synchronous").get().synchronous) !== 2
    ) {
      throw new StateDatabaseError(
        "State database durability mode is not FULL",
        "ERR_STATE_DATABASE_PRAGMA",
      );
    }

    applySqliteMigrations(connection, { sourceRevision, now });
    if (created) {
      const createdAt = now().toISOString();
      connection
        .prepare(
          `INSERT INTO application_metadata(
          singleton, database_id, list_url_template, channel_id, created_at, migrated_from, migration_id
        ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          databaseId,
          listUrlTemplate,
          normalizedChannelId,
          createdAt,
          migratedFrom,
          migrationId,
        );
      connection
        .prepare(
          "INSERT INTO telegram_state(singleton, update_offset) VALUES (1, 0)",
        )
        .run();
    }

    finishDecisionCompaction(connection);
    const result = new StateDatabase(connection, filename, {
      onMetric,
      monotonicNow,
    });
    result.validate();
    return result;
  } catch (error) {
    try {
      connection?.close();
    } catch {
      // Opening error remains authoritative.
    }
    if (created) {
      for (const candidate of [
        filename,
        `${filename}-wal`,
        `${filename}-shm`,
      ]) {
        rmSync(candidate, { force: true });
      }
    }
    if (error instanceof StateDatabaseError || error instanceof TypeError)
      throw error;
    throw mappedDatabaseError(error, "open");
  }
}
