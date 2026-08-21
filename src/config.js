import path from "node:path";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { constants as filesystemConstants } from "node:fs";
import { randomUUID } from "node:crypto";

import { parseChannelFilters } from "./channel.js";
import {
  productionExplicitConfigurationNames,
  readConfigurationEnvironment,
} from "./config-catalog.js";
import { MAX_RETRY_DELAY_MS } from "./retry.js";
import { LIST_AM_URL_TEMPLATE } from "./target.js";
import {
  getEnvironmentName,
  getHealthEndpointConfig,
} from "./environment-config.js";

const RESERVED_DATA_PATHS = new Set([
  ".maintenance-history.json",
  ".singleton.json",
  ".singleton.sock",
  ".singleton-recovery",
]);

function requireValue(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function percentage(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
    throw new Error(`${name} must be greater than 0 and less than 100`);
  }
  return parsed;
}

function boolean(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function port(value, fallback, name) {
  const parsed = positiveInteger(value, fallback, name);
  if (parsed > 65_535) throw new Error(`${name} must be at most 65535`);
  return parsed;
}

function boundedInteger(value, minimum, maximum, name) {
  const parsed = positiveInteger(value, undefined, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return parsed;
}

function accessMode(value) {
  const supported = new Set(["public", "owner", "allowlist"]);
  const normalized = value?.trim();
  if (!supported.has(normalized)) {
    throw new Error("TELEGRAM_ACCESS_MODE must be public, owner, or allowlist");
  }
  return normalized;
}

function positiveIntegerList(value, name) {
  if (!value?.trim()) return [];
  const values = value.split(",").map((candidate) => candidate.trim());
  const parsedValues = values.map(Number);
  if (
    values.some((candidate) => !/^[1-9]\d*$/u.test(candidate)) ||
    parsedValues.some(
      (candidate) => !Number.isSafeInteger(candidate) || candidate <= 0,
    ) ||
    new Set(parsedValues).size !== parsedValues.length
  ) {
    throw new Error(`${name} must contain unique positive integer IDs`);
  }
  return parsedValues;
}

export function validateTelegramAccessPolicy(config) {
  const mode = config.telegramAccessMode ?? "public";
  const allowedUserIds = config.telegramAllowedUserIds ?? [];
  if (!["public", "owner", "allowlist"].includes(mode)) {
    throw new Error("TELEGRAM_ACCESS_MODE must be public, owner, or allowlist");
  }
  if (
    !Array.isArray(allowedUserIds) ||
    allowedUserIds.some(
      (userId) => !Number.isSafeInteger(userId) || userId <= 0,
    ) ||
    new Set(allowedUserIds).size !== allowedUserIds.length
  ) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_IDS must contain unique positive integer IDs",
    );
  }
  if (allowedUserIds.includes(config.telegramOwnerId)) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_IDS must not repeat TELEGRAM_OWNER_ID",
    );
  }
  if (mode === "allowlist" && allowedUserIds.length === 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_IDS must contain at least one ID in allowlist mode",
    );
  }
  if (mode !== "allowlist" && allowedUserIds.length > 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_IDS must be blank unless TELEGRAM_ACCESS_MODE is allowlist",
    );
  }
}

function optionalChannelId(value) {
  const channelId = value?.trim();
  if (!channelId) return null;
  if (!/^@[a-z][a-z0-9_]{4,31}$/iu.test(channelId)) {
    throw new Error("TELEGRAM_CHANNEL_ID must be a public Telegram @username");
  }
  return channelId;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function validatePersistentPaths(config) {
  if (path.parse(config.dataDirectory).root === config.dataDirectory) {
    throw new Error("DATA_DIRECTORY must not be the filesystem root");
  }

  const paths = new Map([
    ["APARTMENTS_STATE_FILE", config.apartmentsStateFile],
    ["DELIVERY_STATE_FILE", config.deliveryStateFile],
    ["CHANNEL_DELIVERY_STATE_FILE", config.channelDeliveryStateFile],
    ["EXCHANGE_RATES_STATE_FILE", config.exchangeRatesStateFile],
    ["TELEGRAM_STATE_FILE", config.telegramStateFile],
    ["BROWSER_PROFILE_DIR", config.browserProfileDir],
  ]);
  const usedPaths = new Map();

  for (const [name, statePath] of paths) {
    if (!isInside(config.dataDirectory, statePath)) {
      throw new Error(
        `${name} must resolve inside DATA_DIRECTORY (${config.dataDirectory})`,
      );
    }

    const priorName = usedPaths.get(statePath);
    if (priorName) {
      throw new Error(`${name} must not use the same path as ${priorName}`);
    }
    for (const [usedPath, usedName] of usedPaths) {
      if (isInside(usedPath, statePath) || isInside(statePath, usedPath)) {
        throw new Error(
          `${name} must not overlap the path used by ${usedName}`,
        );
      }
    }
    if (
      path.dirname(statePath) === config.dataDirectory &&
      RESERVED_DATA_PATHS.has(path.basename(statePath))
    ) {
      throw new Error(`${name} conflicts with a reserved runtime path`);
    }
    usedPaths.set(statePath, name);
  }

  if (
    config.backupDirectory &&
    (isInside(config.dataDirectory, config.backupDirectory) ||
      isInside(config.backupDirectory, config.dataDirectory) ||
      config.backupDirectory === config.dataDirectory)
  ) {
    throw new Error(
      "BACKUP_DIRECTORY must be independent of DATA_DIRECTORY and may not contain it",
    );
  }
}

function validateProductionConfig(env, config) {
  if (config.environmentName !== "production") return;

  for (const name of productionExplicitConfigurationNames()) {
    requireValue(env[name], name);
  }

  if (!path.isAbsolute(config.chromeExecutablePath)) {
    throw new Error("CHROME_EXECUTABLE_PATH must be absolute in production");
  }
  if (!config.browserHeadless) {
    throw new Error("BROWSER_HEADLESS must be true in production");
  }
}

export function getConfig(env = process.env, cwd = process.cwd()) {
  const read = (name, context = {}) =>
    readConfigurationEnvironment(env, name, context);
  const dataDirectory = path.resolve(cwd, read("DATA_DIRECTORY"));
  const environmentName = getEnvironmentName(env);
  const healthEndpoint = getHealthEndpointConfig(env);
  const telegramChannelId = optionalChannelId(read("TELEGRAM_CHANNEL_ID"));
  const dataContext = { dataDirectory };

  const config = {
    environmentName,
    dataDirectory,
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
    initialPageCount: positiveInteger(
      read("INITIAL_PAGE_COUNT"),
      undefined,
      "INITIAL_PAGE_COUNT",
    ),
    initialDeliveryLimit: positiveInteger(
      read("INITIAL_DELIVERY_LIMIT"),
      undefined,
      "INITIAL_DELIVERY_LIMIT",
    ),
    apartmentsStateFile: path.resolve(
      cwd,
      read("APARTMENTS_STATE_FILE", dataContext),
    ),
    deliveryStateFile: path.resolve(
      cwd,
      read("DELIVERY_STATE_FILE", dataContext),
    ),
    channelDeliveryStateFile: path.resolve(
      cwd,
      read("CHANNEL_DELIVERY_STATE_FILE", dataContext),
    ),
    exchangeRatesStateFile: path.resolve(
      cwd,
      read("EXCHANGE_RATES_STATE_FILE", dataContext),
    ),
    telegramBotToken: requireValue(
      read("TELEGRAM_BOT_TOKEN"),
      "TELEGRAM_BOT_TOKEN",
    ),
    telegramOwnerId: positiveInteger(
      requireValue(read("TELEGRAM_OWNER_ID"), "TELEGRAM_OWNER_ID"),
      undefined,
      "TELEGRAM_OWNER_ID",
    ),
    telegramAccessMode: accessMode(read("TELEGRAM_ACCESS_MODE")),
    telegramAllowedUserIds: positiveIntegerList(
      read("TELEGRAM_ALLOWED_USER_IDS"),
      "TELEGRAM_ALLOWED_USER_IDS",
    ),
    telegramUserUpdatesPerMinute: boundedInteger(
      read("TELEGRAM_USER_UPDATES_PER_MINUTE"),
      5,
      120,
      "TELEGRAM_USER_UPDATES_PER_MINUTE",
    ),
    telegramPrivateDeliveriesPerMinute: boundedInteger(
      read("TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE"),
      1,
      30,
      "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE",
    ),
    telegramChannelId,
    channelFilters: parseChannelFilters({
      price: read("CHANNEL_FILTER_PRICE_AMD"),
      rooms: read("CHANNEL_FILTER_ROOMS"),
      locations: read("CHANNEL_FILTER_LOCATIONS"),
    }),
    telegramStateFile: path.resolve(
      cwd,
      read("TELEGRAM_STATE_FILE", dataContext),
    ),
    telegramPollTimeoutSeconds: positiveInteger(
      read("TELEGRAM_POLL_TIMEOUT_SECONDS"),
      undefined,
      "TELEGRAM_POLL_TIMEOUT_SECONDS",
    ),
    pollIntervalMs: positiveInteger(
      read("POLL_INTERVAL_MS"),
      undefined,
      "POLL_INTERVAL_MS",
    ),
    timeoutMs: positiveInteger(read("TIMEOUT_MS"), undefined, "TIMEOUT_MS"),
    externalRetryBaseMs: positiveInteger(
      read("EXTERNAL_RETRY_BASE_MS"),
      undefined,
      "EXTERNAL_RETRY_BASE_MS",
    ),
    externalRetryMaxMs: positiveInteger(
      read("EXTERNAL_RETRY_MAX_MS"),
      undefined,
      "EXTERNAL_RETRY_MAX_MS",
    ),
    chromeExecutablePath: read("CHROME_EXECUTABLE_PATH")?.trim() || undefined,
    browserProfileDir: path.resolve(
      cwd,
      read("BROWSER_PROFILE_DIR", dataContext),
    ),
    browserHeadless: boolean(
      read("BROWSER_HEADLESS"),
      undefined,
      "BROWSER_HEADLESS",
    ),
    browserChallengeTimeoutMs: positiveInteger(
      read("BROWSER_CHALLENGE_TIMEOUT_MS"),
      undefined,
      "BROWSER_CHALLENGE_TIMEOUT_MS",
    ),
    browserProtocolTimeoutMs: positiveInteger(
      read("BROWSER_PROTOCOL_TIMEOUT_MS"),
      undefined,
      "BROWSER_PROTOCOL_TIMEOUT_MS",
    ),
    browserCacheMaxBytes: positiveInteger(
      read("BROWSER_CACHE_MAX_BYTES"),
      undefined,
      "BROWSER_CACHE_MAX_BYTES",
    ),
    browserDebugPort: port(
      read("BROWSER_DEBUG_PORT"),
      undefined,
      "BROWSER_DEBUG_PORT",
    ),
    backupDirectory: read("BACKUP_DIRECTORY")?.trim()
      ? path.resolve(cwd, read("BACKUP_DIRECTORY"))
      : undefined,
    backupDailyRetention: positiveInteger(
      read("BACKUP_DAILY_RETENTION"),
      undefined,
      "BACKUP_DAILY_RETENTION",
    ),
    backupWeeklyRetention: positiveInteger(
      read("BACKUP_WEEKLY_RETENTION"),
      undefined,
      "BACKUP_WEEKLY_RETENTION",
    ),
    diskFreeWarningFraction:
      percentage(
        read("DISK_FREE_WARNING_PERCENT"),
        undefined,
        "DISK_FREE_WARNING_PERCENT",
      ) / 100,
    healthHost: healthEndpoint.host,
    healthPort: healthEndpoint.port,
  };

  if (config.externalRetryMaxMs > MAX_RETRY_DELAY_MS) {
    throw new Error("EXTERNAL_RETRY_MAX_MS must not exceed 300000");
  }
  if (config.externalRetryBaseMs > config.externalRetryMaxMs) {
    throw new Error(
      "EXTERNAL_RETRY_BASE_MS must not exceed EXTERNAL_RETRY_MAX_MS",
    );
  }
  if (config.backupDailyRetention < 7) {
    throw new Error("BACKUP_DAILY_RETENTION must be at least 7");
  }
  if (config.backupWeeklyRetention < 4) {
    throw new Error("BACKUP_WEEKLY_RETENTION must be at least 4");
  }

  validateTelegramAccessPolicy(config);
  validatePersistentPaths(config);
  validateProductionConfig(env, config);
  return config;
}

async function secureDirectory(directory, canonicalDataDirectory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Persistent path is not a safe directory: ${directory}`);
  }
  const canonicalDirectory = await realpath(directory);
  if (
    canonicalDataDirectory &&
    canonicalDirectory !== canonicalDataDirectory &&
    !isInside(canonicalDataDirectory, canonicalDirectory)
  ) {
    throw new Error(
      `Persistent directory resolves outside DATA_DIRECTORY: ${directory}`,
    );
  }
  await chmod(directory, 0o700);
  await access(
    directory,
    filesystemConstants.R_OK |
      filesystemConstants.W_OK |
      filesystemConstants.X_OK,
  );
}

async function secureExistingStateFile(filename) {
  let details;
  try {
    details = await lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`State path is not a safe regular file: ${filename}`);
  }
  await chmod(filename, 0o600);
}

export async function validateStartupConfig(config) {
  // Recheck callers that construct configuration without getConfig, including
  // operational scripts, before granting them access to persistent storage.
  validateTelegramAccessPolicy(config);
  validatePersistentPaths(config);

  const stateFiles = [
    config.apartmentsStateFile,
    config.deliveryStateFile,
    config.channelDeliveryStateFile,
    config.exchangeRatesStateFile,
    config.telegramStateFile,
  ];
  const stateDirectories = new Set([
    config.dataDirectory,
    config.browserProfileDir,
    ...stateFiles.map((filename) => path.dirname(filename)),
  ]);

  await secureDirectory(config.dataDirectory);
  const canonicalDataDirectory = await realpath(config.dataDirectory);
  for (const directory of stateDirectories) {
    await secureDirectory(directory, canonicalDataDirectory);
  }
  for (const filename of stateFiles) {
    await secureExistingStateFile(filename);
  }
  const probePath = path.join(
    config.dataDirectory,
    `.configuration-write-probe.${process.pid}.${randomUUID()}`,
  );
  const renamedProbePath = `${probePath}.renamed`;
  let probe;
  try {
    probe = await open(probePath, "wx", 0o600);
    await probe.writeFile("persistent storage probe\n", "utf8");
    await probe.close();
    probe = undefined;
    await rename(probePath, renamedProbePath);
    await rm(renamedProbePath);
  } catch (error) {
    throw new Error(
      `Persistent data directory is not writable: ${config.dataDirectory}`,
      { cause: error },
    );
  } finally {
    await probe?.close().catch(() => {});
    await rm(probePath, { force: true }).catch(() => {});
    await rm(renamedProbePath, { force: true }).catch(() => {});
  }
}
