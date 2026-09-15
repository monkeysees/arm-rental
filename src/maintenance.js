import { lstat } from "node:fs/promises";
import path from "node:path";

import { checkDiskSpace } from "./recovery.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import { openStateDatabase, stateDatabasePaths } from "./sqlite-database.js";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.js";
import { readState, writeState } from "./state.js";

// 25 MiB was set for a smaller installation than this one became. The database
// holds one delivery decision per apartment per recipient - 245,932 rows for 74
// recipients - and grew past the threshold by simply being used, so the weekly
// alert reported the passage of time rather than a problem. Daily snapshots put
// growth at about 1 MiB/day, which makes 256 MiB roughly seven months of
// headroom and about 1% of the host's free disk: high enough that routine use
// does not reach it, low enough that a tenfold change in growth is visible
// within weeks. A red timer nobody believes is worse than no timer at all.
export const STATE_DATABASE_WARNING_BYTES = 256 * 1024 * 1024;
// Once the only escape hatch was migrating off JSON; now it names the point at
// which the database itself needs an operator, not a backend change.
export const STATE_DATABASE_CRITICAL_BYTES = 512 * 1024 * 1024;
// The WAL is checkpointed on every maintenance run, so it is bounded by
// checkpointing working rather than by how much history the database holds.
// It keeps the original threshold: a WAL this large means checkpointing
// stopped, and that is worth waking someone for at a far smaller size.
export const STATE_WAL_WARNING_BYTES = 25 * 1024 * 1024;
export const MAINTENANCE_HISTORY_FILENAME = ".maintenance-history.json";

export class MaintenanceValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MaintenanceValidationError";
    this.code = "ERR_MAINTENANCE_VALIDATION";
    this.details = details;
  }
}

export function stateSizeStatus(bytes) {
  if (bytes >= STATE_DATABASE_CRITICAL_BYTES) return "critical";
  if (bytes >= STATE_DATABASE_WARNING_BYTES) return "warning";
  return "ok";
}

/** The database and WAL are bounded by different things, so they alert at
 * different sizes. Exported because proving that no longer means writing a
 * quarter-gigabyte fixture. */
export function sqliteStateAlerts(stateFile) {
  const alerts = [];
  if (stateFile.bytes >= STATE_DATABASE_WARNING_BYTES) {
    alerts.push({
      alertName: "state_database_growth",
      bytes: stateFile.bytes,
      thresholdBytes: STATE_DATABASE_WARNING_BYTES,
    });
  }
  if (stateFile.walBytes >= STATE_WAL_WARNING_BYTES) {
    alerts.push({
      alertName: "state_wal_growth",
      bytes: stateFile.walBytes,
      thresholdBytes: STATE_WAL_WARNING_BYTES,
    });
  }
  return alerts;
}

async function regularFileBytes(filename) {
  try {
    const details = await lstat(filename);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new MaintenanceValidationError(
        `Managed state is not a safe regular file: ${filename}`,
        { filename },
      );
    }
    return details.size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function sqliteStateReport(config) {
  const paths = stateDatabasePaths(config.dataDirectory);
  let database;
  try {
    database = openStateDatabase({
      dataDirectory: config.dataDirectory,
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
    });
    database.validate({ full: true });
    database.checkpoint("TRUNCATE");
    const counts = database.logicalCounts();
    const updateOffset = Number(
      database
        .prepare("SELECT update_offset FROM telegram_state WHERE singleton = 1")
        .get().update_offset,
    );
    const databaseBytes = await regularFileBytes(paths.database);
    const walBytes = await regularFileBytes(paths.databaseWal);
    const bytes = databaseBytes + walBytes;
    return {
      name: "sqlite",
      stateFile: path.basename(paths.database),
      present: true,
      bytes,
      databaseBytes,
      walBytes,
      entryCount:
        counts.apartments +
        counts.privateDecisions +
        counts.channelDeliveries +
        counts.telegramUsers +
        counts.exchangeRateSnapshots,
      ...counts,
      updateOffset,
      schemaVersion: SQLITE_SCHEMA_VERSION,
      status: stateSizeStatus(bytes),
    };
  } catch (error) {
    if (error instanceof MaintenanceValidationError) throw error;
    throw new MaintenanceValidationError("SQLite state validation failed", {
      code: error.code,
      cause: error.message,
    });
  } finally {
    database?.close({ checkpoint: false });
  }
}

async function previousHistory(filename) {
  try {
    let details;
    try {
      details = await lstat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (details && (!details.isFile() || details.isSymbolicLink())) {
      throw new MaintenanceValidationError(
        `Maintenance history is not a safe regular file: ${filename}`,
        { filename },
      );
    }
    const history = await readState(filename);
    if (
      history?.type === "rental-apartments-maintenance-history" &&
      history.version === 1 &&
      Number.isSafeInteger(history.managedBytes) &&
      history.managedBytes >= 0 &&
      !Number.isNaN(Date.parse(history.sampledAt))
    ) {
      return history;
    }
    if (history !== undefined) {
      throw new MaintenanceValidationError(
        `Maintenance history has an incompatible schema: ${filename}`,
        { filename },
      );
    }
    return undefined;
  } catch (error) {
    if (error instanceof MaintenanceValidationError) throw error;
    throw new MaintenanceValidationError(
      `Maintenance history is unreadable: ${filename}`,
      { filename, cause: error.message },
    );
  }
}

/**
 * Runs the stop-the-service weekly maintenance boundary. Acquiring the same
 * singleton lease as the application makes checkpointing and all samples
 * point-in-time consistent.
 */
export async function runMaintenance(
  config,
  {
    now = () => new Date(),
    acquireLock = acquireSingletonLock,
    diskCheck = checkDiskSpace,
    saveState = writeState,
  } = {},
) {
  const lease = await acquireLock(config.dataDirectory);
  try {
    const sampledAt = now();
    const historyFilename = path.join(
      config.dataDirectory,
      MAINTENANCE_HISTORY_FILENAME,
    );
    const previous = await previousHistory(historyFilename);
    const stateFiles = [await sqliteStateReport(config)];
    const cookieBytes = await regularFileBytes(config.listAmCookieFile);
    const stateBytes = stateFiles.reduce(
      (total, file) => total + file.bytes,
      0,
    );
    const managedBytes = stateBytes + cookieBytes;
    const disk = await diskCheck(config.dataDirectory, {
      warningThreshold: config.diskFreeWarningFraction,
    });
    const growth = {
      previousSampledAt: previous?.sampledAt,
      previousManagedBytes: previous?.managedBytes,
      bytes:
        previous === undefined ? null : managedBytes - previous.managedBytes,
      percent:
        previous === undefined || previous.managedBytes === 0
          ? null
          : ((managedBytes - previous.managedBytes) / previous.managedBytes) *
            100,
    };
    const alerts = sqliteStateAlerts(
      stateFiles.find(({ name }) => name === "sqlite"),
    );
    const report = {
      type: "rental-apartments-maintenance-report",
      version: 1,
      sampledAt: sampledAt.toISOString(),
      stateFiles,
      httpSession: { bytes: cookieBytes },
      managedStorage: {
        bytes: managedBytes,
        stateBytes,
        growth,
      },
      disk,
      alerts,
    };
    await saveState(historyFilename, {
      type: "rental-apartments-maintenance-history",
      version: 1,
      sampledAt: report.sampledAt,
      managedBytes,
    });
    return report;
  } finally {
    await lease.release();
  }
}
