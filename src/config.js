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
import { LIST_AM_URL_TEMPLATE } from "./target.js";

const SUPPORTED_RUNTIME_MODES = new Set(["development", "test", "production"]);
const RESERVED_DATA_PATHS = new Set([
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

function optionalChannelId(value) {
  const channelId = value?.trim();
  if (!channelId) return null;
  if (!/^@[a-z][a-z0-9_]{4,31}$/iu.test(channelId)) {
    throw new Error("TELEGRAM_CHANNEL_ID must be a public Telegram @username");
  }
  return channelId;
}

function runtimeMode(value) {
  const mode = value?.trim() || "development";
  if (!SUPPORTED_RUNTIME_MODES.has(mode)) {
    throw new Error(
      `NODE_ENV must be one of: ${[...SUPPORTED_RUNTIME_MODES].join(", ")}`,
    );
  }
  return mode;
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

  requireValue(env.DATA_DIRECTORY, "DATA_DIRECTORY");
  requireValue(env.CHROME_EXECUTABLE_PATH, "CHROME_EXECUTABLE_PATH");
  requireValue(env.BROWSER_HEADLESS, "BROWSER_HEADLESS");

  if (!path.isAbsolute(config.chromeExecutablePath)) {
    throw new Error("CHROME_EXECUTABLE_PATH must be absolute in production");
  }
  if (!config.browserHeadless) {
    throw new Error("BROWSER_HEADLESS must be true in production");
  }
}

export function getConfig(env = process.env, cwd = process.cwd()) {
  const telegramChannelId = optionalChannelId(env.TELEGRAM_CHANNEL_ID);
  const dataDirectory = path.resolve(cwd, env.DATA_DIRECTORY || ".data");
  const environmentName = runtimeMode(env.NODE_ENV);

  const config = {
    environmentName,
    dataDirectory,
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
    initialPageCount: positiveInteger(
      env.INITIAL_PAGE_COUNT,
      10,
      "INITIAL_PAGE_COUNT",
    ),
    initialDeliveryLimit: positiveInteger(
      env.INITIAL_DELIVERY_LIMIT,
      10,
      "INITIAL_DELIVERY_LIMIT",
    ),
    apartmentsStateFile: path.resolve(
      cwd,
      env.APARTMENTS_STATE_FILE || path.join(dataDirectory, "apartments.json"),
    ),
    deliveryStateFile: path.resolve(
      cwd,
      env.DELIVERY_STATE_FILE ||
        path.join(dataDirectory, "telegram-deliveries.json"),
    ),
    channelDeliveryStateFile: path.resolve(
      cwd,
      env.CHANNEL_DELIVERY_STATE_FILE ||
        path.join(dataDirectory, "telegram-channel-deliveries.json"),
    ),
    exchangeRatesStateFile: path.resolve(
      cwd,
      env.EXCHANGE_RATES_STATE_FILE ||
        path.join(dataDirectory, "exchange-rates.json"),
    ),
    telegramBotToken: requireValue(
      env.TELEGRAM_BOT_TOKEN,
      "TELEGRAM_BOT_TOKEN",
    ),
    telegramOwnerId: positiveInteger(
      requireValue(env.TELEGRAM_OWNER_ID, "TELEGRAM_OWNER_ID"),
      undefined,
      "TELEGRAM_OWNER_ID",
    ),
    telegramChannelId,
    channelFilters: parseChannelFilters({
      price: env.CHANNEL_FILTER_PRICE_AMD,
      rooms: env.CHANNEL_FILTER_ROOMS,
      locations: env.CHANNEL_FILTER_LOCATIONS,
    }),
    telegramStateFile: path.resolve(
      cwd,
      env.TELEGRAM_STATE_FILE || path.join(dataDirectory, "telegram-bot.json"),
    ),
    telegramPollTimeoutSeconds: positiveInteger(
      env.TELEGRAM_POLL_TIMEOUT_SECONDS,
      25,
      "TELEGRAM_POLL_TIMEOUT_SECONDS",
    ),
    pollIntervalMs: positiveInteger(
      env.POLL_INTERVAL_MS,
      60_000,
      "POLL_INTERVAL_MS",
    ),
    timeoutMs: positiveInteger(env.TIMEOUT_MS, 30_000, "TIMEOUT_MS"),
    chromeExecutablePath: env.CHROME_EXECUTABLE_PATH?.trim() || undefined,
    browserProfileDir: path.resolve(
      cwd,
      env.BROWSER_PROFILE_DIR || path.join(dataDirectory, "chrome-profile"),
    ),
    browserHeadless: boolean(env.BROWSER_HEADLESS, false, "BROWSER_HEADLESS"),
    browserChallengeTimeoutMs: positiveInteger(
      env.BROWSER_CHALLENGE_TIMEOUT_MS,
      120_000,
      "BROWSER_CHALLENGE_TIMEOUT_MS",
    ),
    browserProtocolTimeoutMs: positiveInteger(
      env.BROWSER_PROTOCOL_TIMEOUT_MS,
      30_000,
      "BROWSER_PROTOCOL_TIMEOUT_MS",
    ),
    browserDebugPort: port(
      env.BROWSER_DEBUG_PORT,
      49_222,
      "BROWSER_DEBUG_PORT",
    ),
    backupDirectory: env.BACKUP_DIRECTORY?.trim()
      ? path.resolve(cwd, env.BACKUP_DIRECTORY)
      : undefined,
    backupDailyRetention: positiveInteger(
      env.BACKUP_DAILY_RETENTION,
      7,
      "BACKUP_DAILY_RETENTION",
    ),
    backupWeeklyRetention: positiveInteger(
      env.BACKUP_WEEKLY_RETENTION,
      4,
      "BACKUP_WEEKLY_RETENTION",
    ),
    diskFreeWarningFraction:
      percentage(
        env.DISK_FREE_WARNING_PERCENT,
        20,
        "DISK_FREE_WARNING_PERCENT",
      ) / 100,
  };

  if (config.backupDailyRetention < 7) {
    throw new Error("BACKUP_DAILY_RETENTION must be at least 7");
  }
  if (config.backupWeeklyRetention < 4) {
    throw new Error("BACKUP_WEEKLY_RETENTION must be at least 4");
  }

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
