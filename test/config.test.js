import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIGURATION_CATALOG,
  productionExplicitConfigurationNames,
  readConfigurationEnvironment,
} from "../src/config-catalog.js";
import { getConfig, validateStartupConfig } from "../src/config.js";
import {
  getEnvironmentName,
  getHealthEndpointConfig,
} from "../src/environment-config.js";
import { LIST_AM_URL_TEMPLATE, pageUrl } from "../src/target.js";

const requiredEnvironment = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_OWNER_ID: "42",
};

function stateConfig(dataDirectory) {
  return getConfig(
    {
      ...requiredEnvironment,
      DATA_DIRECTORY: dataDirectory,
    },
    "/app",
  );
}

function permissions(details) {
  return details.mode & 0o777;
}

test("configuration uses the requested target and initial crawl defaults", () => {
  const config = getConfig(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_OWNER_ID: "42",
    },
    "/app",
  );

  assert.equal(config.listUrlTemplate, LIST_AM_URL_TEMPLATE);
  assert.equal(config.initialPageCount, 10);
  assert.equal(config.initialDeliveryLimit, 100);
  assert.equal(
    pageUrl(1, config.listUrlTemplate),
    "https://www.list.am/ru/category/56/1?n=0&cmtype=0&crc=0&gl=2&srt=3",
  );
  assert.equal(config.telegramOwnerId, 42);
  assert.equal(config.telegramAccessMode, "public");
  assert.deepEqual(config.telegramAllowedUserIds, []);
  assert.equal(config.telegramUserUpdatesPerMinute, 30);
  assert.equal(config.telegramPrivateDeliveriesPerMinute, 20);
  assert.equal(config.telegramChannelId, null);
  assert.deepEqual(config.channelFilters.locations, ["r:0"]);
  assert.equal(config.dataDirectory, "/app/.data");
  assert.equal(config.apartmentsStateFile, "/app/.data/apartments.json");
  assert.equal(config.exchangeRatesStateFile, "/app/.data/exchange-rates.json");
  assert.equal(
    config.channelDeliveryStateFile,
    "/app/.data/telegram-channel-deliveries.json",
  );
  assert.equal(config.backupDirectory, undefined);
  assert.equal(config.backupDailyRetention, 7);
  assert.equal(config.backupWeeklyRetention, 4);
  assert.equal(config.diskFreeWarningFraction, 0.2);
  assert.equal(config.healthHost, "127.0.0.1");
  assert.equal(config.healthPort, 8_787);
  assert.equal(config.externalRetryBaseMs, 1_000);
  assert.equal(config.externalRetryMaxMs, 60_000);
  assert.equal(config.browserCacheMaxBytes, 64 * 1024 * 1024);
  assert.equal(config.browserLoadImages, false);
});

test("runtime and health helpers share catalog defaults and strict parsing", () => {
  assert.equal(getEnvironmentName({}), "development");
  assert.deepEqual(getHealthEndpointConfig({}), {
    host: "127.0.0.1",
    port: 8_787,
  });
  assert.deepEqual(
    getHealthEndpointConfig({ HEALTH_HOST: "::1", HEALTH_PORT: "9090" }),
    { host: "::1", port: 9_090 },
  );
  for (const environment of [
    { HEALTH_HOST: "0.0.0.0" },
    { HEALTH_PORT: "0" },
    { HEALTH_PORT: "not-a-port" },
    { HEALTH_PORT: "65536" },
  ]) {
    assert.throws(() => getHealthEndpointConfig(environment), /HEALTH_/u);
  }
});

test("logger and health probe do not bypass canonical named environment parsing", async () => {
  for (const filename of ["src/logger.js", "src/health-check.js"]) {
    const source = await readFile(
      new URL(`../${filename}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /process\.env\.(?:NODE_ENV|APPLICATION_VERSION|HEALTH_HOST|HEALTH_PORT)/u,
      filename,
    );
  }
});

test("configuration catalog is complete, unique, and safe to inspect offline", () => {
  const names = CONFIGURATION_CATALOG.map(({ name }) => name);
  const configKeys = CONFIGURATION_CATALOG.map(({ configKey }) => configKey);

  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(configKeys).size, configKeys.length);
  for (const configuration of CONFIGURATION_CATALOG) {
    assert.match(configuration.name, /^[A-Z][A-Z0-9_]*$/u);
    assert.ok(configuration.parser.type);
    assert.ok(configuration.parser.constraints);
    assert.ok(configuration.purpose);
    assert.equal(
      configuration.required && configuration.defaultValue !== undefined,
      false,
    );
    assert.equal(Object.isFrozen(configuration), true);
    assert.equal(Object.isFrozen(configuration.parser), true);
  }

  assert.deepEqual(productionExplicitConfigurationNames().sort(), [
    "BROWSER_HEADLESS",
    "CHROME_EXECUTABLE_PATH",
    "DATA_DIRECTORY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OWNER_ID",
  ]);
  assert.equal(
    readConfigurationEnvironment({}, "APARTMENTS_STATE_FILE", {
      dataDirectory: "/srv/rental-data",
    }),
    "/srv/rental-data/apartments.json",
  );
  assert.throws(
    () => readConfigurationEnvironment({}, "TELEGRAM_BOT_TOKEN"),
    /^Error: TELEGRAM_BOT_TOKEN is required$/u,
  );

  const accessedNames = new Set();
  const environment = new Proxy(requiredEnvironment, {
    get(target, property) {
      if (typeof property === "string") accessedNames.add(property);
      return target[property];
    },
  });
  getConfig(environment, "/app");
  assert.deepEqual([...accessedNames].sort(), names.sort());
});

test("access catalog settings parse validated defaults and bounded overrides", () => {
  const config = getConfig({
    ...requiredEnvironment,
    TELEGRAM_ACCESS_MODE: "allowlist",
    TELEGRAM_ALLOWED_USER_IDS: "7,9007199254740991",
    TELEGRAM_USER_UPDATES_PER_MINUTE: "120",
    TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE: "1",
  });

  assert.equal(config.telegramAccessMode, "allowlist");
  assert.deepEqual(config.telegramAllowedUserIds, [7, 9_007_199_254_740_991]);
  assert.equal(config.telegramUserUpdatesPerMinute, 120);
  assert.equal(config.telegramPrivateDeliveriesPerMinute, 1);

  for (const [name, value] of [
    ["TELEGRAM_ACCESS_MODE", "private"],
    ["TELEGRAM_ALLOWED_USER_IDS", "7,07"],
    ["TELEGRAM_USER_UPDATES_PER_MINUTE", "4"],
    ["TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE", "31"],
  ]) {
    assert.throws(
      () => getConfig({ ...requiredEnvironment, [name]: value }),
      new RegExp(name, "u"),
    );
  }
});

test("access modes enforce allowlist policy without exposing identifiers", () => {
  const sensitiveId = "987654321";
  for (const environment of [
    { TELEGRAM_ACCESS_MODE: "public" },
    { TELEGRAM_ACCESS_MODE: "owner" },
    {
      TELEGRAM_ACCESS_MODE: "allowlist",
      TELEGRAM_ALLOWED_USER_IDS: sensitiveId,
    },
  ]) {
    assert.doesNotThrow(() =>
      getConfig({ ...requiredEnvironment, ...environment }),
    );
  }

  for (const environment of [
    {
      TELEGRAM_ACCESS_MODE: "public",
      TELEGRAM_ALLOWED_USER_IDS: sensitiveId,
    },
    {
      TELEGRAM_ACCESS_MODE: "owner",
      TELEGRAM_ALLOWED_USER_IDS: sensitiveId,
    },
    { TELEGRAM_ACCESS_MODE: "allowlist" },
    {
      TELEGRAM_ACCESS_MODE: "allowlist",
      TELEGRAM_ALLOWED_USER_IDS: `42,${sensitiveId}`,
    },
  ]) {
    assert.throws(
      () => getConfig({ ...requiredEnvironment, ...environment }),
      (error) =>
        error.message.includes("TELEGRAM_ALLOWED_USER_IDS") &&
        !error.message.includes(sensitiveId),
    );
  }

  assert.deepEqual(
    getConfig({
      ...requiredEnvironment,
      TELEGRAM_ACCESS_MODE: " allowlist ",
      TELEGRAM_ALLOWED_USER_IDS: "   7, 8   ",
    }).telegramAllowedUserIds,
    [7, 8],
  );
  assert.deepEqual(
    getConfig({
      ...requiredEnvironment,
      TELEGRAM_ALLOWED_USER_IDS: "   ",
    }).telegramAllowedUserIds,
    [],
  );
});

test("startup revalidates access policy before touching persistent storage", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rental-access-config-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await chmod(temporaryDirectory, 0o755);
  const config = stateConfig(temporaryDirectory);
  config.telegramAccessMode = "allowlist";
  config.telegramAllowedUserIds = [];

  await assert.rejects(
    validateStartupConfig(config),
    /TELEGRAM_ALLOWED_USER_IDS/u,
  );
  assert.equal(permissions(await lstat(temporaryDirectory)), 0o755);
  await assert.rejects(lstat(config.browserProfileDir), { code: "ENOENT" });
});

test("configuration relocates default persistent files together", () => {
  const config = getConfig(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_OWNER_ID: "42",
      DATA_DIRECTORY: "/var/lib/rental-apartments",
    },
    "/app",
  );

  assert.equal(config.dataDirectory, "/var/lib/rental-apartments");
  assert.equal(
    config.apartmentsStateFile,
    "/var/lib/rental-apartments/apartments.json",
  );
  assert.equal(
    config.deliveryStateFile,
    "/var/lib/rental-apartments/telegram-deliveries.json",
  );
  assert.equal(
    config.browserProfileDir,
    "/var/lib/rental-apartments/chrome-profile",
  );
});

test("configuration rejects invalid owner and page values", () => {
  assert.throws(
    () =>
      getConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_OWNER_ID: "not-a-number",
      }),
    /TELEGRAM_OWNER_ID must be a positive integer/,
  );
  assert.throws(() => pageUrl(0), /positive integer/);
});

test("configuration rejects unsupported modes, unsafe paths, and collisions", () => {
  assert.throws(
    () =>
      getConfig({
        ...requiredEnvironment,
        HEALTH_HOST: "0.0.0.0",
      }),
    /HEALTH_HOST must be a loopback address/u,
  );
  assert.throws(
    () => getConfig({ ...requiredEnvironment, NODE_ENV: "staging" }),
    /NODE_ENV must be one of/u,
  );
  assert.throws(
    () =>
      getConfig(
        {
          ...requiredEnvironment,
          DATA_DIRECTORY: "/app/data",
          APARTMENTS_STATE_FILE: "/app/outside.json",
        },
        "/app",
      ),
    /APARTMENTS_STATE_FILE must resolve inside DATA_DIRECTORY/u,
  );
  assert.throws(
    () =>
      getConfig(
        {
          ...requiredEnvironment,
          DATA_DIRECTORY: "/",
        },
        "/app",
      ),
    /must not be the filesystem root/u,
  );
  assert.throws(
    () =>
      getConfig(
        {
          ...requiredEnvironment,
          DATA_DIRECTORY: "/app/data",
          APARTMENTS_STATE_FILE: "/app/data/shared.json",
          DELIVERY_STATE_FILE: "/app/data/shared.json",
        },
        "/app",
      ),
    /must not use the same path/u,
  );
  assert.throws(
    () =>
      getConfig(
        {
          ...requiredEnvironment,
          DATA_DIRECTORY: "/app/data",
          BROWSER_PROFILE_DIR: "/app/data/profile",
          APARTMENTS_STATE_FILE: "/app/data/profile/apartments.json",
        },
        "/app",
      ),
    /must not overlap the path/u,
  );
  assert.throws(
    () =>
      getConfig(
        {
          ...requiredEnvironment,
          DATA_DIRECTORY: "/app/data",
          TELEGRAM_STATE_FILE: "/app/data/.singleton.json",
        },
        "/app",
      ),
    /conflicts with a reserved runtime path/u,
  );
  assert.throws(
    () =>
      getConfig(
        {
          ...requiredEnvironment,
          DATA_DIRECTORY: "/app/data",
          BACKUP_DIRECTORY: "/app/data/backups",
        },
        "/app",
      ),
    /BACKUP_DIRECTORY must be independent/u,
  );
  assert.throws(
    () =>
      getConfig({
        ...requiredEnvironment,
        BACKUP_DAILY_RETENTION: "6",
      }),
    /at least 7/u,
  );
  assert.throws(
    () =>
      getConfig({
        ...requiredEnvironment,
        DISK_FREE_WARNING_PERCENT: "100",
      }),
    /less than 100/u,
  );
  assert.throws(
    () =>
      getConfig({
        ...requiredEnvironment,
        EXTERNAL_RETRY_MAX_MS: "300001",
      }),
    /must not exceed 300000/u,
  );
  assert.throws(
    () =>
      getConfig({
        ...requiredEnvironment,
        EXTERNAL_RETRY_BASE_MS: "2000",
        EXTERNAL_RETRY_MAX_MS: "1000",
      }),
    /must not exceed EXTERNAL_RETRY_MAX_MS/u,
  );
});

test("production requires explicit persistent browser configuration", () => {
  const production = {
    ...requiredEnvironment,
    NODE_ENV: "production",
    DATA_DIRECTORY: "/app/.data",
    BROWSER_HEADLESS: "true",
    CHROME_EXECUTABLE_PATH: "/opt/chrome/chrome",
  };

  assert.equal(getConfig(production, "/app").environmentName, "production");
  for (const variable of [
    "DATA_DIRECTORY",
    "BROWSER_HEADLESS",
    "CHROME_EXECUTABLE_PATH",
  ]) {
    const incomplete = { ...production };
    delete incomplete[variable];
    assert.throws(() => getConfig(incomplete, "/app"), variable);
  }
  assert.throws(
    () => getConfig({ ...production, BROWSER_HEADLESS: "false" }, "/app"),
    /BROWSER_HEADLESS must be true in production/u,
  );
  assert.throws(
    () =>
      getConfig(
        { ...production, CHROME_EXECUTABLE_PATH: "google-chrome" },
        "/app",
      ),
    /CHROME_EXECUTABLE_PATH must be absolute/u,
  );
});

test("startup secures and proves the persistent data tree before use", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rental-config-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await chmod(temporaryDirectory, 0o755);
  const config = stateConfig(temporaryDirectory);
  await writeFile(config.telegramStateFile, "{}\n", { mode: 0o644 });

  await validateStartupConfig(config);

  assert.equal(permissions(await lstat(temporaryDirectory)), 0o700);
  assert.equal(permissions(await lstat(config.browserProfileDir)), 0o700);
  assert.equal(permissions(await lstat(config.telegramStateFile)), 0o600);
  assert.equal(
    (await readdir(temporaryDirectory)).some((entry) =>
      entry.startsWith(".configuration-write-probe."),
    ),
    false,
  );
});

test("startup rejects a persistent path redirected through a symlink", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rental-config-"),
  );
  const externalDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rental-external-"),
  );
  t.after(() =>
    Promise.all([
      rm(temporaryDirectory, { recursive: true, force: true }),
      rm(externalDirectory, { recursive: true, force: true }),
    ]),
  );
  await symlink(externalDirectory, path.join(temporaryDirectory, "redirect"));
  const config = getConfig(
    {
      ...requiredEnvironment,
      DATA_DIRECTORY: temporaryDirectory,
      APARTMENTS_STATE_FILE: path.join(
        temporaryDirectory,
        "redirect",
        "apartments.json",
      ),
    },
    "/app",
  );

  await assert.rejects(
    validateStartupConfig(config),
    /not a safe directory|resolves outside DATA_DIRECTORY/u,
  );
});
