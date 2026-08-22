import path from "node:path";

function entry({
  name,
  configKey,
  type,
  constraints,
  purpose,
  defaultValue,
  required = false,
  productionExplicit = false,
  secret = false,
  identifierSensitive = false,
  relativeToDataDirectory,
  defaultDescription,
}) {
  if (required && defaultValue !== undefined) {
    throw new Error(`${name} cannot be required and have a default`);
  }

  return Object.freeze({
    name,
    configKey,
    parser: Object.freeze({ type, constraints }),
    defaultValue,
    required,
    productionExplicit,
    secret,
    identifierSensitive,
    purpose,
    ...(relativeToDataDirectory ? { relativeToDataDirectory } : {}),
    ...(defaultDescription ? { defaultDescription } : {}),
  });
}

const dataPath = (name, configKey, filename, purpose) =>
  entry({
    name,
    configKey,
    type: "path",
    constraints:
      "Must resolve inside DATA_DIRECTORY and not overlap another managed path.",
    defaultValue: `.data/${filename}`,
    relativeToDataDirectory: filename,
    purpose,
  });

/**
 * Public, non-value-bearing metadata for every application environment input.
 * Runtime parsing reads defaults from this catalog; documentation checks may
 * inspect it without loading an environment file or exposing configured values.
 */
export const CONFIGURATION_CATALOG = Object.freeze([
  entry({
    name: "NODE_ENV",
    configKey: "environmentName",
    type: "enum",
    constraints: "development, test, or production.",
    defaultValue: "development",
    purpose: "Selects the runtime validation and logging mode.",
  }),
  entry({
    name: "TELEGRAM_BOT_TOKEN",
    configKey: "telegramBotToken",
    type: "non-empty string",
    constraints: "Must be supplied by the runtime secret facility.",
    required: true,
    productionExplicit: true,
    secret: true,
    purpose: "Authenticates the bot to the Telegram Bot API.",
  }),
  entry({
    name: "TELEGRAM_OWNER_ID",
    configKey: "telegramOwnerId",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    required: true,
    productionExplicit: true,
    identifierSensitive: true,
    purpose:
      "Receives server alerts and is always authorized for private controls.",
  }),
  entry({
    name: "TELEGRAM_ACCESS_MODE",
    configKey: "telegramAccessMode",
    type: "enum",
    constraints: "public, owner, or allowlist.",
    defaultValue: "public",
    purpose: "Chooses who may use private Telegram controls.",
  }),
  entry({
    name: "TELEGRAM_ALLOWED_USER_IDS",
    configKey: "telegramAllowedUserIds",
    type: "positive safe integer list",
    constraints:
      "Comma-separated unique positive IDs; allowlist mode requires at least one non-owner ID, the owner must not be repeated, and other modes require a blank value.",
    defaultValue: "",
    identifierSensitive: true,
    purpose: "Adds private users when access mode is allowlist.",
  }),
  entry({
    name: "TELEGRAM_USER_UPDATES_PER_MINUTE",
    configKey: "telegramUserUpdatesPerMinute",
    type: "bounded integer",
    constraints: "Integer from 5 through 120.",
    defaultValue: "30",
    purpose: "Limits private updates accepted per user each minute.",
  }),
  entry({
    name: "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE",
    configKey: "telegramPrivateDeliveriesPerMinute",
    type: "bounded integer",
    constraints: "Integer from 1 through 30.",
    defaultValue: "20",
    purpose:
      "Limits apartment notifications sent per private recipient each minute.",
  }),
  entry({
    name: "TELEGRAM_CHANNEL_ID",
    configKey: "telegramChannelId",
    type: "Telegram public username",
    constraints: "Blank or an @username with 5 through 32 username characters.",
    defaultValue: "",
    identifierSensitive: true,
    purpose: "Enables publishing to a public Telegram channel.",
  }),
  entry({
    name: "CHANNEL_FILTER_PRICE_AMD",
    configKey: "channelFilterPriceAmd",
    type: "range",
    constraints:
      "Blank, an exact positive AMD amount, or an open/closed positive range.",
    defaultValue: "",
    purpose: "Filters public-channel apartments by canonical AMD price.",
  }),
  entry({
    name: "CHANNEL_FILTER_ROOMS",
    configKey: "channelFilterRooms",
    type: "range",
    constraints:
      "Blank, an exact positive room count, or an open/closed positive range.",
    defaultValue: "",
    purpose: "Filters public-channel apartments by room count.",
  }),
  entry({
    name: "CHANNEL_FILTER_LOCATIONS",
    configKey: "channelFilterLocations",
    type: "location selector list",
    constraints: "Comma-separated known region/place selectors or all.",
    defaultValue: "region:Ереван",
    purpose: "Filters public-channel apartments by configured locations.",
  }),
  entry({
    name: "DATA_DIRECTORY",
    configKey: "dataDirectory",
    type: "path",
    constraints:
      "Must not be the filesystem root; managed paths must remain inside it.",
    defaultValue: ".data",
    productionExplicit: true,
    purpose:
      "Contains persistent state, the browser profile, and singleton lease.",
  }),
  dataPath(
    "APARTMENTS_STATE_FILE",
    "apartmentsStateFile",
    "apartments.json",
    "Stores normalized apartment and crawl state.",
  ),
  dataPath(
    "DELIVERY_STATE_FILE",
    "deliveryStateFile",
    "telegram-deliveries.json",
    "Stores per-user private delivery decisions.",
  ),
  dataPath(
    "CHANNEL_DELIVERY_STATE_FILE",
    "channelDeliveryStateFile",
    "telegram-channel-deliveries.json",
    "Stores public-channel admission and publication state.",
  ),
  dataPath(
    "EXCHANGE_RATES_STATE_FILE",
    "exchangeRatesStateFile",
    "exchange-rates.json",
    "Stores the last validated exchange-rate snapshot.",
  ),
  dataPath(
    "TELEGRAM_STATE_FILE",
    "telegramStateFile",
    "telegram-bot.json",
    "Stores private-user settings and Telegram update offset.",
  ),
  entry({
    name: "TELEGRAM_POLL_TIMEOUT_SECONDS",
    configKey: "telegramPollTimeoutSeconds",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "25",
    purpose: "Sets the Telegram long-poll duration in seconds.",
  }),
  entry({
    name: "POLL_INTERVAL_MS",
    configKey: "pollIntervalMs",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "60000",
    purpose: "Sets the delay between shared apartment crawls.",
  }),
  entry({
    name: "INITIAL_PAGE_COUNT",
    configKey: "initialPageCount",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "10",
    purpose: "Sets pages parsed per List.am category with no history.",
  }),
  entry({
    name: "ADDED_CATEGORY_PAGE_COUNT",
    configKey: "addedCategoryPageCount",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "2",
    purpose: "Caps the first crawl of a category added to a populated install.",
  }),
  entry({
    name: "INITIAL_DELIVERY_LIMIT",
    configKey: "initialDeliveryLimit",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "100",
    purpose: "Caps the latest initial private or channel selection.",
  }),
  entry({
    name: "TIMEOUT_MS",
    configKey: "timeoutMs",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "30000",
    purpose: "Sets browser navigation and API request timeout.",
  }),
  entry({
    name: "EXTERNAL_RETRY_BASE_MS",
    configKey: "externalRetryBaseMs",
    type: "positive safe integer",
    constraints: "Must not exceed EXTERNAL_RETRY_MAX_MS.",
    defaultValue: "1000",
    purpose: "Sets the initial external retry delay.",
  }),
  entry({
    name: "EXTERNAL_RETRY_MAX_MS",
    configKey: "externalRetryMaxMs",
    type: "bounded integer",
    constraints: "Positive integer no greater than 300000.",
    defaultValue: "60000",
    purpose: "Caps external retry delays.",
  }),
  entry({
    name: "CHROME_EXECUTABLE_PATH",
    configKey: "chromeExecutablePath",
    type: "path",
    constraints: "When set in production, must be absolute.",
    defaultValue: undefined,
    defaultDescription: "auto-detected",
    productionExplicit: true,
    purpose: "Selects the Chrome or Chromium executable.",
  }),
  dataPath(
    "BROWSER_PROFILE_DIR",
    "browserProfileDir",
    "chrome-profile",
    "Stores the persistent Chrome profile.",
  ),
  entry({
    name: "BROWSER_HEADLESS",
    configKey: "browserHeadless",
    type: "boolean",
    constraints: "true or false; production requires true.",
    defaultValue: "false",
    productionExplicit: true,
    purpose: "Controls headless Chrome operation.",
  }),
  entry({
    name: "BROWSER_CHALLENGE_TIMEOUT_MS",
    configKey: "browserChallengeTimeoutMs",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "120000",
    purpose: "Bounds browser verification waits.",
  }),
  entry({
    name: "BROWSER_PROTOCOL_TIMEOUT_MS",
    configKey: "browserProtocolTimeoutMs",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "30000",
    purpose: "Bounds Chrome protocol commands.",
  }),
  entry({
    name: "BROWSER_CACHE_MAX_BYTES",
    configKey: "browserCacheMaxBytes",
    type: "positive safe integer",
    constraints: "Must be a positive JavaScript safe integer.",
    defaultValue: "67108864",
    purpose: "Caps the Chrome HTTP disk cache.",
  }),
  entry({
    name: "BROWSER_DEBUG_PORT",
    configKey: "browserDebugPort",
    type: "TCP port",
    constraints: "Integer from 1 through 65535.",
    defaultValue: "49222",
    purpose: "Selects the loopback background-Chrome control port.",
  }),
  entry({
    name: "BACKUP_DIRECTORY",
    configKey: "backupDirectory",
    type: "path",
    constraints:
      "Must be independent of DATA_DIRECTORY and may not contain it.",
    defaultValue: "",
    purpose: "Selects the snapshot destination.",
  }),
  entry({
    name: "BACKUP_DAILY_RETENTION",
    configKey: "backupDailyRetention",
    type: "bounded integer",
    constraints: "Positive integer of at least 7.",
    defaultValue: "7",
    purpose: "Sets daily recovery points to retain.",
  }),
  entry({
    name: "BACKUP_WEEKLY_RETENTION",
    configKey: "backupWeeklyRetention",
    type: "bounded integer",
    constraints: "Positive integer of at least 4.",
    defaultValue: "4",
    purpose: "Sets weekly recovery points to retain.",
  }),
  entry({
    name: "DISK_FREE_WARNING_PERCENT",
    configKey: "diskFreeWarningPercent",
    type: "percentage",
    constraints: "Number greater than 0 and less than 100.",
    defaultValue: "20",
    purpose: "Sets the low-disk warning threshold.",
  }),
  entry({
    name: "HEALTH_HOST",
    configKey: "healthHost",
    type: "loopback address",
    constraints: "127.0.0.1 or ::1.",
    defaultValue: "127.0.0.1",
    purpose: "Selects the private health endpoint bind address.",
  }),
  entry({
    name: "HEALTH_PORT",
    configKey: "healthPort",
    type: "TCP port",
    constraints: "Integer from 1 through 65535.",
    defaultValue: "8787",
    purpose: "Selects the private health endpoint port.",
  }),
]);

const CATALOG_BY_NAME = new Map(
  CONFIGURATION_CATALOG.map((configuration) => [
    configuration.name,
    configuration,
  ]),
);

export function readConfigurationEnvironment(env, name, context = {}) {
  const configuration = CATALOG_BY_NAME.get(name);
  if (!configuration) throw new Error(`Unknown configuration field: ${name}`);

  const supplied = env[name];
  if (supplied !== undefined && supplied !== "") return supplied;
  if (configuration.required) throw new Error(`${name} is required`);
  if (configuration.relativeToDataDirectory) {
    return path.join(
      context.dataDirectory,
      configuration.relativeToDataDirectory,
    );
  }
  return configuration.defaultValue;
}

export function productionExplicitConfigurationNames() {
  return CONFIGURATION_CATALOG.filter(
    (configuration) => configuration.productionExplicit,
  ).map((configuration) => configuration.name);
}
