import { lstat } from "node:fs/promises";

import { acquireSingletonLock } from "./singleton-lock.js";
import { openStateDatabase, stateDatabasePaths } from "./sqlite-database.js";

export class StateInitializationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StateInitializationError";
    this.code = "ERR_STATE_ALREADY_INITIALIZED";
    this.details = details;
  }
}

async function exists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Creates the empty state database a first installation starts from. This is
 * the only path in the tree allowed to bring one into existence, which is what
 * lets every other caller treat an absent database as a lost data directory
 * rather than a fresh host. It refuses an existing database outright: the
 * decision to discard stored state belongs to an operator and a restore, never
 * to a startup command.
 */
export async function initializeState(
  config,
  { acquireLock = acquireSingletonLock } = {},
) {
  const paths = stateDatabasePaths(config.dataDirectory);
  const lease = await acquireLock(config.dataDirectory);
  try {
    if (await exists(paths.database)) {
      throw new StateInitializationError(
        "State database already exists; refusing to initialize over it",
        { database: paths.database },
      );
    }
    const database = openStateDatabase({
      dataDirectory: config.dataDirectory,
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
      create: true,
    });
    try {
      const metadata = database
        .prepare(
          "SELECT database_id, list_url_template, channel_id FROM application_metadata WHERE singleton = 1",
        )
        .get();
      return {
        database: paths.database,
        databaseId: metadata.database_id,
        listUrlTemplate: metadata.list_url_template,
        channelId: metadata.channel_id,
        schemaVersion: Number(
          database.prepare("PRAGMA user_version").get().user_version,
        ),
      };
    } finally {
      database.close();
    }
  } finally {
    await lease.release();
  }
}
