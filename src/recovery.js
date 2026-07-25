import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import path from "node:path";

import { compatibleBotState } from "./bot.js";
import {
  browserVerificationStateFile,
  compatibleBrowserVerification,
} from "./browser-verification-state.js";
import { compatibleChannelState } from "./channel.js";
import {
  compatibleApartmentState,
  compatibleDeliveryState,
  deliveryStateCounts,
} from "./crawler.js";
import { compatibleExchangeRateSnapshot } from "./exchange-rates.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import { readState, writeState } from "./state.js";

const BACKUP_TYPE = "rental-apartments-backup";
const BACKUP_VERSION = 1;
const DEFAULT_DAILY_RETENTION = 7;
const DEFAULT_WEEKLY_RETENTION = 4;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);
const EXCLUDED_PROFILE_ENTRIES = new Set([
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);

export class RecoveryValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecoveryValidationError";
    this.code = "ERR_RECOVERY_VALIDATION";
    this.details = details;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function validateBackupDestination(config, backupDirectory) {
  if (!backupDirectory) {
    throw new Error("BACKUP_DIRECTORY must be configured");
  }
  const resolved = path.resolve(backupDirectory);
  const dataDirectory = path.resolve(config.dataDirectory);
  if (isWithin(dataDirectory, resolved) || isWithin(resolved, dataDirectory)) {
    throw new Error(
      "BACKUP_DIRECTORY must be independent of DATA_DIRECTORY and may not contain it",
    );
  }
  return resolved;
}

function relocated(config, root, filename) {
  return path.join(root, path.relative(config.dataDirectory, filename));
}

function stateSpecifications(config, root) {
  return [
    {
      name: "apartments",
      filename: relocated(config, root, config.apartmentsStateFile),
      compatible: (state) =>
        compatibleApartmentState(state, config.listUrlTemplate),
      emptyCounts: { apartments: 0 },
      counts: (state) => ({
        apartments: Object.keys(state.apartments).length,
      }),
    },
    {
      name: "delivery",
      filename: relocated(config, root, config.deliveryStateFile),
      compatible: (state) =>
        compatibleDeliveryState(state, config.listUrlTemplate),
      emptyCounts: { notified: 0, skipped: 0, filtered: 0 },
      counts: deliveryStateCounts,
    },
    {
      name: "bot",
      filename: relocated(config, root, config.telegramStateFile),
      compatible: (state) =>
        compatibleBotState(state) &&
        Number.isSafeInteger(state.updateOffset) &&
        state.updateOffset >= 0,
      emptyCounts: { updateOffset: 0 },
      counts: (state) => ({ updateOffset: state.updateOffset }),
    },
    {
      name: "exchangeRates",
      filename: relocated(config, root, config.exchangeRatesStateFile),
      compatible: compatibleExchangeRateSnapshot,
      emptyCounts: { currencies: 0 },
      counts: (state) => ({
        currencies: Object.keys(state.rates).length,
      }),
    },
    {
      name: "channel",
      filename: relocated(config, root, config.channelDeliveryStateFile),
      compatible: (state) => compatibleChannelState(state, config),
      emptyCounts: { apartments: 0, published: 0 },
      counts: (state) => ({
        apartments: Object.keys(state.apartments).length,
        published: Object.values(state.apartments).filter(
          ({ status }) => status === "published",
        ).length,
      }),
    },
  ];
}

async function optionalState(filename) {
  try {
    return await readState(filename);
  } catch (error) {
    throw new RecoveryValidationError(
      `Recovery state is unreadable: ${filename}`,
      { filename, cause: error.message },
    );
  }
}

export async function validateRecoveryState(config, root) {
  const summary = {};
  for (const specification of stateSpecifications(config, root)) {
    const state = await optionalState(specification.filename);
    if (state === undefined) {
      summary[specification.name] = {
        present: false,
        ...specification.emptyCounts,
      };
      continue;
    }
    if (!specification.compatible(state)) {
      throw new RecoveryValidationError(
        `Recovery state has an incompatible schema: ${specification.name}`,
        {
          name: specification.name,
          filename: specification.filename,
          type: state?.type,
          version: state?.version,
        },
      );
    }
    summary[specification.name] = {
      present: true,
      ...specification.counts(state),
    };
  }

  const profileDirectory = relocated(config, root, config.browserProfileDir);
  let profileDetails;
  try {
    profileDetails = await lstat(profileDirectory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!profileDetails?.isDirectory() || profileDetails.isSymbolicLink()) {
    throw new RecoveryValidationError(
      "Required browser profile is missing or unsafe",
      { profileDirectory },
    );
  }
  const verificationFilename = relocated(
    config,
    root,
    browserVerificationStateFile(config),
  );
  const verification = await optionalState(verificationFilename);
  if (!compatibleBrowserVerification(verification, config.listUrlTemplate)) {
    throw new RecoveryValidationError(
      "Browser profile does not contain a compatible verification record",
      { filename: verificationFilename },
    );
  }
  summary.browser = {
    present: true,
    verifiedAt: verification.verifiedAt,
    regularAdsCount: verification.regularAdsCount,
  };
  return summary;
}

async function visitFiles(root, visitor, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      relative === path.relative(root, root) &&
      EXCLUDED_PROFILE_ENTRIES.has(entry.name)
    ) {
      continue;
    }
    const entryRelative = path.join(relative, entry.name);
    const filename = path.join(root, entryRelative);
    if (entry.isSymbolicLink()) {
      throw new RecoveryValidationError(
        `Browser profile contains an unsafe symbolic link: ${filename}`,
        { filename },
      );
    }
    if (entry.isDirectory()) {
      await visitor(filename, entryRelative, "directory");
      await visitFiles(root, visitor, entryRelative);
    } else if (entry.isFile()) {
      await visitor(filename, entryRelative, "file");
    } else {
      throw new RecoveryValidationError(
        `Browser profile contains an unsupported entry: ${filename}`,
        { filename },
      );
    }
  }
}

async function secureTree(root) {
  await chmod(root, 0o700);
  await visitFiles(root, async (filename, _relative, type) => {
    await chmod(filename, type === "directory" ? 0o700 : 0o600);
  });
}

async function syncHandle(filename, { directory = false } = {}) {
  let handle;
  try {
    handle = await open(filename, "r");
    await handle.sync();
  } catch (error) {
    if (!directory || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function makeTreeDurable(root) {
  await secureTree(root);
  const directories = [];
  await visitFiles(root, async (filename, _relative, type) => {
    if (type === "file") await syncHandle(filename);
    else directories.push(filename);
  });
  for (const directory of directories.reverse()) {
    await syncHandle(directory, { directory: true });
  }
  await syncHandle(root, { directory: true });
}

async function fileHashes(root) {
  const hashes = {};
  await visitFiles(root, async (filename, relative, type) => {
    if (type !== "file") return;
    hashes[relative.split(path.sep).join("/")] = createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  });
  return hashes;
}

async function copyData(config, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const targets = [
    config.apartmentsStateFile,
    config.deliveryStateFile,
    config.telegramStateFile,
    config.exchangeRatesStateFile,
    config.channelDeliveryStateFile,
  ];
  for (const source of targets) {
    const destination = relocated(config, destinationRoot, source);
    let details;
    try {
      details = await lstat(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new RecoveryValidationError(
        `Managed state is not a regular file: ${source}`,
        { filename: source },
      );
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }

  const profileDestination = relocated(
    config,
    destinationRoot,
    config.browserProfileDir,
  );
  await visitFiles(config.browserProfileDir, async () => {});
  await cp(config.browserProfileDir, profileDestination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: (source) => !EXCLUDED_PROFILE_ENTRIES.has(path.basename(source)),
  });
  await makeTreeDurable(destinationRoot);
}

function snapshotId(now) {
  return now.toISOString().replaceAll(":", "-").replace(".", "-");
}

async function retentionDirectories(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

async function enforceRetention(directory, retain) {
  const entries = await retentionDirectories(directory);
  await Promise.all(
    entries.slice(retain).map((entry) =>
      rm(path.join(directory, entry), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

async function cloneSnapshot(source, destination) {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  await makeTreeDurable(destination);
}

export async function createSnapshot(
  config,
  {
    backupDirectory = config.backupDirectory,
    dailyRetention = DEFAULT_DAILY_RETENTION,
    weeklyRetention = DEFAULT_WEEKLY_RETENTION,
    now = () => new Date(),
    acquireLock = acquireSingletonLock,
    onEvent = () => {},
  } = {},
) {
  if (dailyRetention < 7 || weeklyRetention < 4) {
    throw new Error(
      "Backup retention must be at least seven daily and four weekly",
    );
  }
  const destination = validateBackupDestination(config, backupDirectory);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const lease = await acquireLock(config.dataDirectory);
  const createdAt = now();
  const id = snapshotId(createdAt);
  const temporary = path.join(destination, `.snapshot-${randomUUID()}.tmp`);
  const dailyDirectory = path.join(destination, "daily");
  const weeklyDirectory = path.join(destination, "weekly");
  const dailySnapshot = path.join(dailyDirectory, id);

  try {
    onEvent({ name: "backup.started", destination });
    const sourceSummary = await validateRecoveryState(
      config,
      config.dataDirectory,
    );
    await copyData(config, path.join(temporary, "data"));
    const copiedSummary = await validateRecoveryState(
      config,
      path.join(temporary, "data"),
    );
    if (JSON.stringify(copiedSummary) !== JSON.stringify(sourceSummary)) {
      throw new RecoveryValidationError(
        "Snapshot counts changed while copying state",
      );
    }
    const hashes = await fileHashes(path.join(temporary, "data"));
    const manifest = {
      type: BACKUP_TYPE,
      version: BACKUP_VERSION,
      createdAt: createdAt.toISOString(),
      summary: copiedSummary,
      hashes,
    };
    await writeState(path.join(temporary, "manifest.json"), manifest);
    await syncHandle(temporary, { directory: true });
    await mkdir(dailyDirectory, { recursive: true, mode: 0o700 });
    await rename(temporary, dailySnapshot);
    await syncHandle(dailyDirectory, { directory: true });

    let weeklySnapshot;
    if (createdAt.getUTCDay() === 0) {
      await mkdir(weeklyDirectory, { recursive: true, mode: 0o700 });
      weeklySnapshot = path.join(weeklyDirectory, id);
      const temporaryWeekly = path.join(
        destination,
        `.weekly-${randomUUID()}.tmp`,
      );
      try {
        await cloneSnapshot(dailySnapshot, temporaryWeekly);
        await rename(temporaryWeekly, weeklySnapshot);
        await syncHandle(weeklyDirectory, { directory: true });
      } finally {
        await rm(temporaryWeekly, { recursive: true, force: true }).catch(
          () => {},
        );
      }
    }
    await enforceRetention(dailyDirectory, dailyRetention);
    await enforceRetention(weeklyDirectory, weeklyRetention);
    const result = {
      snapshot: dailySnapshot,
      ...(weeklySnapshot ? { weeklySnapshot } : {}),
      summary: copiedSummary,
    };
    onEvent({ name: "backup.completed", ...result });
    return result;
  } catch (error) {
    onEvent({
      name: "backup.failed",
      code: error.code || "ERR_BACKUP",
      message: error.message,
    });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    await lease.release();
  }
}

export async function validateSnapshot(config, snapshotDirectory) {
  const manifest = await optionalState(
    path.join(snapshotDirectory, "manifest.json"),
  );
  if (
    manifest?.type !== BACKUP_TYPE ||
    manifest.version !== BACKUP_VERSION ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    !manifest.summary ||
    !manifest.hashes
  ) {
    throw new RecoveryValidationError("Backup manifest is incompatible", {
      snapshotDirectory,
    });
  }
  const dataRoot = path.join(snapshotDirectory, "data");
  const hashes = await fileHashes(dataRoot);
  if (JSON.stringify(hashes) !== JSON.stringify(manifest.hashes)) {
    throw new RecoveryValidationError("Backup content checksum failed", {
      snapshotDirectory,
    });
  }
  const summary = await validateRecoveryState(config, dataRoot);
  if (JSON.stringify(summary) !== JSON.stringify(manifest.summary)) {
    throw new RecoveryValidationError(
      "Backup schema counts or Telegram update offset do not match its manifest",
      { snapshotDirectory },
    );
  }
  return { manifest, summary };
}

function managedTargets(config) {
  return [
    config.apartmentsStateFile,
    config.deliveryStateFile,
    config.telegramStateFile,
    config.exchangeRatesStateFile,
    config.channelDeliveryStateFile,
    config.browserProfileDir,
  ];
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

export async function restoreSnapshot(
  config,
  snapshotDirectory,
  {
    backupDirectory = config.backupDirectory,
    acquireLock = acquireSingletonLock,
    onEvent = () => {},
  } = {},
) {
  validateBackupDestination(config, backupDirectory);
  const resolvedSnapshot = path.resolve(snapshotDirectory);
  if (!isWithin(path.resolve(backupDirectory), resolvedSnapshot)) {
    throw new Error("The snapshot must be inside BACKUP_DIRECTORY");
  }
  const validated = await validateSnapshot(config, resolvedSnapshot);
  const lease = await acquireLock(config.dataDirectory);
  const stage = path.join(
    config.dataDirectory,
    `.restore-stage-${randomUUID()}`,
  );
  const rollback = path.join(
    config.dataDirectory,
    `.restore-rollback-${randomUUID()}`,
  );
  const installed = [];
  const movedAside = [];
  let preserveRollback = false;

  try {
    onEvent({ name: "restore.started", snapshot: resolvedSnapshot });
    await cloneSnapshot(path.join(resolvedSnapshot, "data"), stage);
    await secureTree(stage);
    await validateRecoveryState(config, stage);
    await mkdir(rollback, { recursive: true, mode: 0o700 });

    for (const target of managedTargets(config)) {
      const relative = path.relative(config.dataDirectory, target);
      const stagedTarget = path.join(stage, relative);
      const rollbackTarget = path.join(rollback, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (await exists(target)) {
        await mkdir(path.dirname(rollbackTarget), {
          recursive: true,
          mode: 0o700,
        });
        await rename(target, rollbackTarget);
        movedAside.push({ target, rollbackTarget });
      }
      if (await exists(stagedTarget)) {
        await rename(stagedTarget, target);
        installed.push(target);
      }
    }

    const restoredSummary = await validateRecoveryState(
      config,
      config.dataDirectory,
    );
    if (JSON.stringify(restoredSummary) !== JSON.stringify(validated.summary)) {
      throw new RecoveryValidationError(
        "Restored state does not match the validated backup",
      );
    }
    await rm(rollback, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
    const result = {
      snapshot: resolvedSnapshot,
      summary: restoredSummary,
      browserVerificationRequired: true,
    };
    onEvent({ name: "restore.completed", ...result });
    return result;
  } catch (error) {
    const rollbackErrors = [];
    for (const target of installed.reverse()) {
      await rm(target, { recursive: true, force: true }).catch(
        (rollbackError) => rollbackErrors.push(rollbackError),
      );
    }
    for (const { target, rollbackTarget } of movedAside.reverse()) {
      try {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await rename(rollbackTarget, target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    const reportedError =
      rollbackErrors.length === 0
        ? error
        : new AggregateError(
            [error, ...rollbackErrors],
            `Restore failed and prior state rollback was incomplete; preserve ${rollback}`,
          );
    preserveRollback = rollbackErrors.length > 0;
    onEvent({
      name: "restore.failed",
      code: reportedError.code || "ERR_RESTORE",
      message: reportedError.message,
    });
    throw reportedError;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (!preserveRollback) {
      await rm(rollback, { recursive: true, force: true }).catch(() => {});
    }
    await lease.release();
  }
}

export async function checkDiskSpace(
  directory,
  { warningThreshold = 0.2, onEvent = () => {} } = {},
) {
  const statistics = await statfs(directory);
  const totalBytes = Number(statistics.blocks) * Number(statistics.bsize);
  const freeBytes = Number(statistics.bavail) * Number(statistics.bsize);
  const freeFraction = totalBytes === 0 ? 0 : freeBytes / totalBytes;
  const status = freeFraction < warningThreshold ? "warning" : "ok";
  const result = {
    status,
    freeBytes,
    totalBytes,
    freeFraction,
    warningThreshold,
  };
  onEvent({
    name: status === "warning" ? "storage.low_disk" : "storage.disk_ok",
    component: "storage",
    ...result,
  });
  return result;
}
