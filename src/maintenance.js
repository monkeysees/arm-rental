import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  compatibleApartmentState,
  sourceIntegrityStateSummary,
} from "./apartment-state.js";
import { compatibleBotState } from "./bot.js";
import {
  browserVerificationStateFile,
  compatibleBrowserVerification,
} from "./browser-verification-state.js";
import { compatibleChannelState } from "./channel.js";
import { compatibleDeliveryState, deliveryStateCounts } from "./crawler.js";
import { compatibleExchangeRateSnapshot } from "./exchange-rates.js";
import { checkDiskSpace } from "./recovery.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import { openStateDatabase } from "./sqlite-database.js";
import { readState, writeState } from "./state.js";
import {
  readStateBackendSelector,
  stateBackendPaths,
} from "./state-backend.js";

export const STATE_SIZE_WARNING_BYTES = 25 * 1024 * 1024;
export const STATE_SIZE_MIGRATION_BYTES = 50 * 1024 * 1024;
export const MAINTENANCE_HISTORY_FILENAME = ".maintenance-history.json";

// Only reconstructible network, bytecode, shader, and GPU caches belong here.
// Cookies, Local Storage, IndexedDB, and Service Worker storage are deliberate
// omissions because they may contain browser-verification state.
export const CHROME_CACHE_PATHS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "DawnCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
];

export class MaintenanceValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MaintenanceValidationError";
    this.code = "ERR_MAINTENANCE_VALIDATION";
    this.details = details;
  }
}

function stateSpecifications(config) {
  return [
    {
      name: "apartments",
      filename: config.apartmentsStateFile,
      compatible: (state) =>
        compatibleApartmentState(state, config.listUrlTemplate),
      counts: (state) => ({
        entryCount: Object.keys(state.apartments).length,
        apartments: Object.keys(state.apartments).length,
        ...sourceIntegrityStateSummary(state),
      }),
    },
    {
      name: "privateDelivery",
      filename: config.deliveryStateFile,
      compatible: (state) =>
        compatibleDeliveryState(state, config.listUrlTemplate),
      counts: (state) => {
        const { recipients, notified, skipped, filtered } =
          deliveryStateCounts(state);
        return {
          entryCount: notified + skipped + filtered,
          recipients,
          notified,
          skipped,
          filtered,
        };
      },
    },
    {
      name: "channelDelivery",
      filename: config.channelDeliveryStateFile,
      compatible: (state) => compatibleChannelState(state, config),
      counts: (state) => ({
        entryCount: Object.keys(state.apartments).length,
        published: Object.values(state.apartments).filter(
          ({ status }) => status === "published",
        ).length,
      }),
    },
    {
      name: "exchangeRates",
      filename: config.exchangeRatesStateFile,
      compatible: compatibleExchangeRateSnapshot,
      counts: (state) => ({
        entryCount: Object.keys(state.rates).length,
      }),
    },
    {
      name: "telegram",
      filename: config.telegramStateFile,
      compatible: (state) =>
        compatibleBotState(state) &&
        Number.isSafeInteger(state.updateOffset) &&
        state.updateOffset >= 0,
      counts: (state) => ({
        entryCount: 1,
        updateOffset: state.updateOffset,
      }),
    },
    {
      name: "browserVerification",
      filename: browserVerificationStateFile(config),
      compatible: (state) =>
        compatibleBrowserVerification(state, config.listUrlTemplate),
      counts: (state) => ({
        entryCount: 1,
        verifiedAt: state.verifiedAt,
      }),
    },
  ];
}

export function stateSizeStatus(bytes) {
  if (bytes >= STATE_SIZE_MIGRATION_BYTES) return "migration_required";
  if (bytes >= STATE_SIZE_WARNING_BYTES) return "warning";
  return "ok";
}

export function stateSizeAlerts(stateFile) {
  const alerts = [];
  if (stateFile.bytes >= STATE_SIZE_WARNING_BYTES) {
    alerts.push({
      alertName: "state_file_growth",
      stateFile: stateFile.stateFile,
      bytes: stateFile.bytes,
      thresholdBytes: STATE_SIZE_WARNING_BYTES,
    });
  }
  if (stateFile.bytes >= STATE_SIZE_MIGRATION_BYTES) {
    alerts.push({
      alertName: "state_sqlite_migration",
      stateFile: stateFile.stateFile,
      bytes: stateFile.bytes,
      thresholdBytes: STATE_SIZE_MIGRATION_BYTES,
    });
  }
  return alerts;
}

async function stateFileReport(specification) {
  let details;
  try {
    details = await lstat(specification.filename);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        name: specification.name,
        stateFile: path.basename(specification.filename),
        present: false,
        bytes: 0,
        entryCount: 0,
        status: "ok",
      };
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new MaintenanceValidationError(
      `Managed state is not a safe regular file: ${specification.filename}`,
      { filename: specification.filename },
    );
  }

  let state;
  try {
    state = await readState(specification.filename);
  } catch (error) {
    throw new MaintenanceValidationError(
      `Managed state is unreadable: ${specification.filename}`,
      { filename: specification.filename, cause: error.message },
    );
  }
  if (!specification.compatible(state)) {
    throw new MaintenanceValidationError(
      `Managed state has an incompatible schema: ${specification.name}`,
      {
        filename: specification.filename,
        type: state?.type,
        version: state?.version,
      },
    );
  }

  return {
    name: specification.name,
    stateFile: path.basename(specification.filename),
    present: true,
    bytes: details.size,
    ...specification.counts(state),
    status: stateSizeStatus(details.size),
  };
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
  const paths = stateBackendPaths(config.dataDirectory);
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
      schemaVersion: 1,
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

async function treeSize(root) {
  let details;
  try {
    details = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new MaintenanceValidationError(
      `Browser profile is not a safe directory: ${root}`,
      { profileDirectory: root },
    );
  }

  let bytes = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) bytes += await treeSize(filename);
    else if (entry.isFile()) bytes += (await lstat(filename)).size;
    // Chrome's singleton links and sockets do not contribute file content.
  }
  return bytes;
}

async function cleanupChromeCaches(profileDirectory, dataDirectory) {
  const cleanedPaths = [];
  let removedBytes = 0;

  for (const relative of CHROME_CACHE_PATHS) {
    const target = path.join(profileDirectory, relative);
    let details;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new MaintenanceValidationError(
        `Chrome cache path is not a safe directory: ${target}`,
        { cachePath: target },
      );
    }

    const bytes = await treeSize(target);
    const quarantine = path.join(
      dataDirectory,
      `.maintenance-cache-${randomUUID()}`,
    );
    await rename(target, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    removedBytes += bytes;
    cleanedPaths.push(relative);
  }

  return { cleanedPaths, removedBytes };
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
 * singleton lease as the application makes profile cleanup and all samples
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
    const profileBytesBeforeCleanup = await treeSize(config.browserProfileDir);
    const selector = await readStateBackendSelector(config.dataDirectory);
    if (selector.backend === "migrating") {
      throw new MaintenanceValidationError(
        "Maintenance cannot inspect an incomplete state migration",
      );
    }
    const stateFiles =
      selector.backend === "sqlite"
        ? await Promise.all([
            sqliteStateReport(config),
            stateFileReport(
              stateSpecifications(config).find(
                ({ name }) => name === "browserVerification",
              ),
            ),
          ])
        : await Promise.all(stateSpecifications(config).map(stateFileReport));
    const cacheCleanup = await cleanupChromeCaches(
      config.browserProfileDir,
      config.dataDirectory,
    );
    const profileBytes = await treeSize(config.browserProfileDir);
    const stateBytes = stateFiles.reduce(
      (total, stateFile) => total + stateFile.bytes,
      0,
    );
    const profileEmbeddedStateBytes =
      stateFiles.find(({ name }) => name === "browserVerification")?.bytes || 0;
    const managedBytes = stateBytes - profileEmbeddedStateBytes + profileBytes;
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
    const alerts = stateFiles.flatMap(stateSizeAlerts);
    const report = {
      type: "rental-apartments-maintenance-report",
      version: 1,
      sampledAt: sampledAt.toISOString(),
      stateFiles,
      browserProfile: {
        bytes: profileBytes,
        bytesBeforeCleanup: profileBytesBeforeCleanup,
        cacheBytesRemoved: cacheCleanup.removedBytes,
        cleanedCachePaths: cacheCleanup.cleanedPaths,
      },
      managedStorage: {
        bytes: managedBytes,
        stateBytes,
        profileEmbeddedStateBytes,
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
