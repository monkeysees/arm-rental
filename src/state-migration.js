import { createHash, randomUUID } from "node:crypto";
import {
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

import { migrateApartmentState } from "./apartment-state.js";
import { compatibleBotState, migrateBotState } from "./bot.js";
import { compatibleChannelState } from "./channel.js";
import { compatibleDeliveryState } from "./crawler.js";
import { compatibleExchangeRateSnapshot } from "./exchange-rates.js";
import { validateSnapshot } from "./recovery.js";
import { openStateDatabase } from "./sqlite-database.js";
import { createSqliteRepositories } from "./sqlite-repositories.js";
import { writeState } from "./state.js";
import {
  readStateBackendSelector,
  stateBackendPaths,
} from "./state-backend.js";

const LEGACY_STATE_TYPE = "sqlite-migrated";
const MINIMUM_MIGRATION_HEADROOM_BYTES = 16 * 1024 * 1024;

export class StateMigrationError extends Error {
  constructor(message, code = "ERR_STATE_MIGRATION", details) {
    super(message);
    this.name = "StateMigrationError";
    this.code = code;
    if (details) this.details = details;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function digestLogical(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sameHashes(left, right) {
  return digestLogical(left) === digestLogical(right);
}

function legacyFiles(config) {
  return {
    apartments: config.apartmentsStateFile,
    privateDeliveries: config.deliveryStateFile,
    channelDeliveries: config.channelDeliveryStateFile,
    telegram: config.telegramStateFile,
    exchangeRates: config.exchangeRatesStateFile,
  };
}

async function readLegacyFile(filename) {
  let details;
  try {
    details = await lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { present: false, hash: sha256("absent") };
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new StateMigrationError(
      "Legacy state path is not a safe regular file",
      "ERR_STATE_MIGRATION_PATH",
    );
  }
  const content = await readFile(filename);
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch (cause) {
    throw new StateMigrationError(
      "Legacy state is not valid JSON",
      "ERR_STATE_MIGRATION_INVALID_JSON",
      { cause: cause.message },
    );
  }
  return { present: true, hash: sha256(content), bytes: content.length, value };
}

function normalizePrivateDelivery(state, config, botState) {
  if (state === undefined) {
    return {
      version: 2,
      type: "telegram-deliveries",
      urlTemplate: config.listUrlTemplate,
      recipients: {},
    };
  }
  if (!compatibleDeliveryState(state, config.listUrlTemplate)) {
    throw new StateMigrationError(
      "Private-delivery state is incompatible",
      "ERR_STATE_MIGRATION_DOMAIN",
    );
  }
  const normalizeRecipient = (recipient = {}) => {
    const decisions = {
      notified: recipient.notified || {},
      skipped: recipient.skipped || {},
      filtered: recipient.filtered || {},
    };
    const itemIds = Object.values(decisions).flatMap(Object.keys);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new StateMigrationError(
        "Private delivery statuses overlap",
        "ERR_STATE_MIGRATION_DOMAIN",
      );
    }
    return {
      ...decisions,
      initialSelectionApplied:
        recipient.initialSelectionApplied ??
        Object.keys(recipient.notified || {}).length > 0,
    };
  };
  if (state.version === 2) {
    return {
      ...state,
      recipients: Object.fromEntries(
        Object.entries(state.recipients).map(([recipientId, recipient]) => [
          recipientId,
          normalizeRecipient(recipient),
        ]),
      ),
    };
  }
  const legacyRecipientId =
    botState.legacyRecipientId || String(config.telegramOwnerId);
  return {
    version: 2,
    type: "telegram-deliveries",
    urlTemplate: config.listUrlTemplate,
    recipients: { [legacyRecipientId]: normalizeRecipient(state) },
  };
}

function defaultBotState() {
  return {
    version: 3,
    type: "telegram-bot",
    updateOffset: 0,
    users: {},
  };
}

async function normalizedLegacyState(config) {
  const files = legacyFiles(config);
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, filename]) => [
      name,
      await readLegacyFile(filename),
    ]),
  );
  const source = Object.fromEntries(entries);
  const sourceHashes = Object.fromEntries(
    entries.map(([name, result]) => [name, result.hash]),
  );
  const botValue = source.telegram.value;
  if (botValue !== undefined && !compatibleBotState(botValue)) {
    throw new StateMigrationError(
      "Telegram state is incompatible",
      "ERR_STATE_MIGRATION_DOMAIN",
    );
  }
  const telegram = botValue ? migrateBotState(botValue) : defaultBotState();
  const apartmentValue = source.apartments.value;
  const apartments =
    apartmentValue === undefined
      ? undefined
      : migrateApartmentState(apartmentValue, config.listUrlTemplate);
  if (apartmentValue !== undefined && !apartments) {
    throw new StateMigrationError(
      "Apartment state is incompatible",
      "ERR_STATE_MIGRATION_DOMAIN",
    );
  }
  const channelValue = source.channelDeliveries.value;
  if (
    channelValue !== undefined &&
    !compatibleChannelState(channelValue, config)
  ) {
    throw new StateMigrationError(
      "Channel-delivery state is incompatible",
      "ERR_STATE_MIGRATION_DOMAIN",
    );
  }
  const rateValue = source.exchangeRates.value;
  if (rateValue !== undefined && !compatibleExchangeRateSnapshot(rateValue)) {
    throw new StateMigrationError(
      "Exchange-rate state is incompatible",
      "ERR_STATE_MIGRATION_DOMAIN",
    );
  }
  const logical = {
    apartments,
    privateDeliveries: normalizePrivateDelivery(
      source.privateDeliveries.value,
      config,
      telegram,
    ),
    channelDeliveries: channelValue,
    telegram,
    exchangeRates: rateValue,
  };
  return {
    logical,
    sourceHashes,
    sourceBytes: entries.reduce(
      (total, [, result]) => total + (result.bytes || 0),
      0,
    ),
  };
}

function importLogicalState(database, repositories, logical) {
  database.transaction("state_import", () => {
    if (logical.apartments) {
      repositories.apartments.importState(logical.apartments, {
        transaction: false,
      });
    }
    repositories.privateDeliveries.importState(logical.privateDeliveries, {
      transaction: false,
    });
    if (logical.channelDeliveries) {
      if (!repositories.channelDeliveries) {
        throw new StateMigrationError(
          "Channel state exists but no channel is configured",
          "ERR_STATE_MIGRATION_TARGET",
        );
      }
      repositories.channelDeliveries.importState(logical.channelDeliveries, {
        transaction: false,
      });
    }
    repositories.telegram.importState(logical.telegram, {
      transaction: false,
    });
    if (logical.exchangeRates) {
      repositories.exchangeRates.importState(logical.exchangeRates, {
        transaction: false,
      });
    }
  });
}

function exportLogicalState(repositories) {
  return {
    apartments: repositories.apartments.load(),
    privateDeliveries: repositories.privateDeliveries.loadAllDecisions(),
    channelDeliveries: repositories.channelDeliveries?.load(),
    telegram: repositories.telegram.load(),
    exchangeRates: repositories.exchangeRates.load(),
  };
}

function sanitizedSummary(database, logical, sourceBytes = 0) {
  return {
    sourceBytes,
    logicalCounts: database.logicalCounts(),
    canonicalDigest: digestLogical(logical),
  };
}

async function requireMigrationHeadroom(config, sourceBytes) {
  const filesystem = await statfs(config.dataDirectory);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredBytes = Math.max(
    MINIMUM_MIGRATION_HEADROOM_BYTES,
    sourceBytes * 4,
  );
  if (freeBytes < requiredBytes) {
    throw new StateMigrationError(
      "Insufficient free space for state migration",
      "ERR_STATE_MIGRATION_DISK",
      { freeBytes, requiredBytes },
    );
  }
  return { freeBytes, requiredBytes };
}

async function requireProtectedSnapshot(config) {
  if (!config.backupDirectory) {
    throw new StateMigrationError(
      "BACKUP_DIRECTORY is required for migration",
      "ERR_STATE_MIGRATION_BACKUP",
    );
  }
  const directory = path.join(config.backupDirectory, "protected");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") entries = [];
    else throw error;
  }
  const candidates = entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("pre-sqlite-"),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    throw new StateMigrationError(
      "A protected pre-SQLite snapshot is required",
      "ERR_STATE_MIGRATION_BACKUP",
    );
  }
  await validateSnapshot(config, candidates[0]);
  return path.basename(candidates[0]);
}

async function syncPath(filename) {
  const handle = await open(filename, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function openMigrationDatabase(config, dataDirectory, metadata) {
  return openStateDatabase({
    dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
    ...metadata,
  });
}

export async function planStateMigration(config) {
  const selector = await readStateBackendSelector(config.dataDirectory, {
    allowAbsent: true,
  });
  if (selector.backend !== "json") {
    throw new StateMigrationError(
      "Migration planning requires the JSON backend",
      "ERR_STATE_MIGRATION_SELECTOR",
    );
  }
  const normalized = await normalizedLegacyState(config);
  const disk = await requireMigrationHeadroom(config, normalized.sourceBytes);
  const protectedSnapshot = await requireProtectedSnapshot(config);
  return {
    status: "planned",
    backend: "json",
    protectedSnapshot,
    ...sanitizedSummary(
      {
        logicalCounts: () => ({
          apartments: Object.keys(
            normalized.logical.apartments?.apartments || {},
          ).length,
          privateRecipients: Object.keys(
            normalized.logical.privateDeliveries.recipients,
          ).length,
          privateDecisions: Object.values(
            normalized.logical.privateDeliveries.recipients,
          ).reduce(
            (total, recipient) =>
              total +
              ["notified", "skipped", "filtered"].reduce(
                (sum, status) =>
                  sum + Object.keys(recipient[status] || {}).length,
                0,
              ),
            0,
          ),
          channelDeliveries: Object.keys(
            normalized.logical.channelDeliveries?.apartments || {},
          ).length,
          telegramUsers: Object.keys(normalized.logical.telegram.users).length,
          exchangeRateSnapshots: normalized.logical.exchangeRates ? 1 : 0,
        }),
      },
      normalized.logical,
      normalized.sourceBytes,
    ),
    migrationHeadroomBytes: disk.requiredBytes,
  };
}

async function installSentinels(config, migrationId, databaseId) {
  const sentinel = {
    version: 1,
    type: LEGACY_STATE_TYPE,
    backend: "sqlite",
    migrationId,
    databaseId,
  };
  for (const filename of Object.values(legacyFiles(config))) {
    await writeState(filename, sentinel);
  }
}

function validateInstalledDatabase(config, selector) {
  const database = openMigrationDatabase(config, config.dataDirectory, {});
  try {
    const metadata = database
      .prepare(
        "SELECT database_id, migration_id FROM application_metadata WHERE singleton = 1",
      )
      .get();
    if (
      (selector.databaseId && metadata?.database_id !== selector.databaseId) ||
      metadata?.migration_id !== selector.migrationId
    ) {
      throw new StateMigrationError(
        "Installed database identity does not match the migration",
        "ERR_STATE_MIGRATION_IDENTITY",
      );
    }
    database.validate({ full: true });
    const repositories = createSqliteRepositories(database, {
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
    });
    const logical = exportLogicalState(repositories);
    return {
      databaseId: metadata.database_id,
      ...sanitizedSummary(database, logical),
    };
  } finally {
    database.close();
  }
}

export async function migrateState(config, { migrationId } = {}) {
  const paths = stateBackendPaths(config.dataDirectory);
  // The pre-migration installation has no selector file yet, so planning and
  // migrating are the two places that still read an absent one as JSON.
  const selector = await readStateBackendSelector(config.dataDirectory, {
    allowAbsent: true,
  });
  if (selector.backend === "sqlite") {
    return {
      status: "already-migrated",
      ...validateInstalledDatabase(config, selector),
    };
  }
  if (selector.backend === "migrating") {
    if (migrationId && selector.migrationId !== migrationId) {
      throw new StateMigrationError(
        "A different state migration is already in progress",
        "ERR_STATE_MIGRATION_IDENTITY",
      );
    }
    migrationId = selector.migrationId;
    let installed = true;
    try {
      await lstat(paths.database);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      installed = false;
    }
    if (!installed) {
      const current = await normalizedLegacyState(config);
      if (!sameHashes(current.sourceHashes, selector.sourceHashes)) {
        throw new StateMigrationError(
          "Legacy source hashes changed during migration",
          "ERR_STATE_MIGRATION_SOURCE_CHANGED",
        );
      }
      await rename(paths.migrationDatabase, paths.database);
      await syncPath(paths.database);
      await syncPath(config.dataDirectory);
    }
    const summary = validateInstalledDatabase(config, selector);
    const installedSelector = {
      backend: "sqlite",
      version: 1,
      migrationId,
      databaseId: summary.databaseId,
    };
    await installSentinels(config, migrationId, summary.databaseId);
    await writeState(paths.selector, installedSelector);
    return { status: "migrated", resumed: true, ...summary };
  }

  migrationId ??= randomUUID();
  const normalized = await normalizedLegacyState(config);
  await requireMigrationHeadroom(config, normalized.sourceBytes);
  await requireProtectedSnapshot(config);
  for (const candidate of [
    paths.database,
    paths.databaseWal,
    paths.databaseShm,
    paths.migrationWorkDirectory,
  ]) {
    try {
      await lstat(candidate);
      throw new StateMigrationError(
        "Unexpected SQLite migration target already exists",
        "ERR_STATE_MIGRATION_PATH",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const databaseId = randomUUID();
  await mkdir(paths.migrationWorkDirectory, { mode: 0o700 });
  const workDatabase = openMigrationDatabase(
    config,
    paths.migrationWorkDirectory,
    {
      databaseId,
      migratedFrom: "json",
      migrationId,
    },
  );
  try {
    const repositories = createSqliteRepositories(workDatabase, {
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
    });
    importLogicalState(workDatabase, repositories, normalized.logical);
    const exported = exportLogicalState(repositories);
    if (digestLogical(exported) !== digestLogical(normalized.logical)) {
      throw new StateMigrationError(
        "Imported state is not semantically equivalent",
        "ERR_STATE_MIGRATION_EQUIVALENCE",
      );
    }
    workDatabase.validate({ full: true });
  } catch (error) {
    workDatabase.close({ checkpoint: false });
    await rm(paths.migrationWorkDirectory, { recursive: true, force: true });
    throw error;
  }
  workDatabase.close();
  const createdDatabase = path.join(
    paths.migrationWorkDirectory,
    "state.sqlite3",
  );
  await rename(createdDatabase, paths.migrationDatabase);
  await syncPath(paths.migrationDatabase);
  await syncPath(paths.migrationWorkDirectory);

  await writeState(paths.selector, {
    backend: "migrating",
    version: 1,
    migrationId,
    sourceHashes: normalized.sourceHashes,
  });
  await rename(paths.migrationDatabase, paths.database);
  await syncPath(paths.database);
  await syncPath(config.dataDirectory);
  const sqliteSelector = {
    backend: "sqlite",
    version: 1,
    migrationId,
    databaseId,
  };
  const summary = validateInstalledDatabase(config, sqliteSelector);
  await installSentinels(config, migrationId, databaseId);
  await writeState(paths.selector, sqliteSelector);
  await rm(paths.migrationWorkDirectory, { recursive: true, force: true });
  return {
    status: "migrated",
    resumed: false,
    ...summary,
  };
}

export async function validateMigratedState(config) {
  const selector = await readStateBackendSelector(config.dataDirectory);
  if (selector.backend !== "sqlite") {
    throw new StateMigrationError(
      "SQLite validation requires a completed migration selector",
      "ERR_STATE_MIGRATION_SELECTOR",
    );
  }
  return { status: "valid", ...validateInstalledDatabase(config, selector) };
}

export { digestLogical };
