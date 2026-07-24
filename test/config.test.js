import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getConfig, validateStartupConfig } from "../src/config.js";
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

test("configuration uses the requested target and ten initial pages", () => {
  const config = getConfig(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_OWNER_ID: "42",
    },
    "/app",
  );

  assert.equal(config.listUrlTemplate, LIST_AM_URL_TEMPLATE);
  assert.equal(config.initialPageCount, 10);
  assert.equal(config.initialDeliveryLimit, 10);
  assert.equal(
    pageUrl(1, config.listUrlTemplate),
    "https://www.list.am/ru/category/56/1?n=0&cmtype=0&crc=0&gl=2&srt=3",
  );
  assert.equal(config.telegramOwnerId, 42);
  assert.equal(config.telegramChannelId, null);
  assert.deepEqual(config.channelFilters.locations, ["r:0"]);
  assert.equal(config.dataDirectory, "/app/.data");
  assert.equal(config.apartmentsStateFile, "/app/.data/apartments.json");
  assert.equal(config.exchangeRatesStateFile, "/app/.data/exchange-rates.json");
  assert.equal(
    config.channelDeliveryStateFile,
    "/app/.data/telegram-channel-deliveries.json",
  );
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
