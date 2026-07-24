import path from "node:path";

import { LIST_AM_URL_TEMPLATE } from "./target.js";

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

export function getConfig(env = process.env, cwd = process.cwd()) {
  return {
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
      env.APARTMENTS_STATE_FILE || ".data/apartments.json",
    ),
    deliveryStateFile: path.resolve(
      cwd,
      env.DELIVERY_STATE_FILE || ".data/telegram-deliveries.json",
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
    telegramStateFile: path.resolve(
      cwd,
      env.TELEGRAM_STATE_FILE || ".data/telegram-bot.json",
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
    chromeExecutablePath: env.CHROME_EXECUTABLE_PATH || undefined,
    browserProfileDir: path.resolve(
      cwd,
      env.BROWSER_PROFILE_DIR || ".data/chrome-profile",
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
  };
}
