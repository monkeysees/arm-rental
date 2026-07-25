import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runApplication } from "../src/application.js";
import { BrowserVerificationRequiredError } from "../src/browser-fetch.js";
import { getConfig } from "../src/config.js";
import {
  PreflightError,
  runStartupPreflight,
  StateCompatibilityError,
} from "../src/preflight.js";
import { TelegramApiError } from "../src/telegram.js";

const REGULAR_ADS_HTML = `
  <div id="contentr">
    <a class="fav-item-info-container" href="/ru/item/200">
      <div class="dltitle"><div class="pt">Apartment</div></div>
      <div class="p">220000 ֏</div>
      <div class="at">Кентрон, 2 ком., 50 кв.м., 3/5 этаж</div>
    </a>
  </div>`;

function ratesSnapshot() {
  return {
    version: 1,
    type: "cba-exchange-rates",
    baseCurrency: "AMD",
    fetchedAt: "2026-07-25T08:00:00.000Z",
    effectiveDate: "2026-07-25",
    rates: {
      USD: { amount: 1, rate: 382 },
      EUR: { amount: 1, rate: 448 },
      RUB: { amount: 1, rate: 4.8 },
    },
  };
}

async function temporaryConfig(testContext, overrides = {}) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rental-preflight-"),
  );
  testContext.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return getConfig(
    {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
      DATA_DIRECTORY: dataDirectory,
      ...overrides,
    },
    "/app",
  );
}

function singletonLock(config, events = []) {
  return {
    dataDirectory: config.dataDirectory,
    owner: { id: "lease-id" },
    release: async () => events.push("lock:release"),
  };
}

function browser(events = []) {
  return {
    start: async () => events.push("browser:start"),
    fetch: async () => {
      events.push("list:fetch");
      return new Response(REGULAR_ADS_HTML);
    },
    close: async () => events.push("browser:close"),
  };
}

function telegramApi(events = [], overrides = {}) {
  return {
    getMe: async () => {
      events.push("telegram:getMe");
      return { id: 100, is_bot: true };
    },
    getChat: async () => {
      events.push("telegram:getChat");
      return { type: "channel", username: "rentals" };
    },
    getChatMember: async () => {
      events.push("telegram:getChatMember");
      return {
        status: "administrator",
        can_post_messages: true,
        can_edit_messages: true,
      };
    },
    ...overrides,
  };
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("preflight validates every state target and all external boundaries before readiness", async (t) => {
  const config = await temporaryConfig(t, {
    TELEGRAM_CHANNEL_ID: "@rentals",
  });
  const rates = ratesSnapshot();
  await Promise.all([
    writeJson(config.apartmentsStateFile, {
      version: 2,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      apartments: {},
      apartmentOrder: [],
    }),
    writeJson(config.deliveryStateFile, {
      version: 1,
      type: "telegram-deliveries",
      urlTemplate: config.listUrlTemplate,
      notified: {},
    }),
    writeJson(config.channelDeliveryStateFile, {
      version: 1,
      type: "telegram-channel-deliveries",
      channelId: config.telegramChannelId,
      urlTemplate: config.listUrlTemplate,
      initialized: true,
      filterFingerprint: "a".repeat(64),
      apartments: {},
    }),
    writeJson(config.exchangeRatesStateFile, rates),
    writeJson(config.telegramStateFile, {
      version: 1,
      type: "telegram-bot",
      ownerId: config.telegramOwnerId,
    }),
  ]);
  const events = [];

  const result = await runStartupPreflight(config, {
    storageValidated: true,
    singletonLock: singletonLock(config),
    browserFetcher: browser(events),
    exchangeRateService: {
      getSnapshot: async () => {
        events.push("rates:getSnapshot");
        return rates;
      },
    },
    api: telegramApi(events),
  });

  assert.deepEqual(result, {
    status: "ready",
    ready: true,
    terminal: false,
    checks: {
      storage: "passed",
      state: "passed",
      singleton: "passed",
      telegram: "passed",
      channel: "passed",
      browser: "passed",
      list_am: "passed",
      exchange_rates: "passed",
    },
  });
  assert.deepEqual(events, [
    "telegram:getMe",
    "telegram:getChat",
    "telegram:getChatMember",
    "browser:start",
    "list:fetch",
    "rates:getSnapshot",
  ]);
});

test("unsupported and malformed state fails closed without changing files", async (t) => {
  const config = await temporaryConfig(t);
  const cases = [
    {
      filename: config.apartmentsStateFile,
      state: {
        version: 99,
        type: "list-am-apartments",
        urlTemplate: config.listUrlTemplate,
        apartments: {},
      },
      reason: /unsupported type or version/u,
      schema: { type: "list-am-apartments", version: 99 },
    },
    {
      filename: config.telegramStateFile,
      state: {
        version: 2,
        type: "telegram-bot",
        users: [],
      },
      reason: /schema contents are malformed/u,
      schema: { type: "telegram-bot", version: 2 },
    },
  ];

  for (const stateCase of cases) {
    await Promise.all(
      cases.map(({ filename }) => rm(filename, { force: true })),
    );
    const contents = `${JSON.stringify(stateCase.state, null, 4)}\n`;
    await writeFile(stateCase.filename, contents, "utf8");

    await assert.rejects(
      runStartupPreflight(config, {
        storageValidated: true,
        loadState: undefined,
      }),
      (error) => {
        assert.ok(error instanceof StateCompatibilityError);
        assert.equal(error.code, "ERR_STATE_INCOMPATIBLE");
        assert.equal(error.terminal, true);
        assert.equal(error.filename, stateCase.filename);
        assert.deepEqual(error.observedSchema, stateCase.schema);
        assert.match(error.message, stateCase.reason);
        assert.equal(
          error.preflightResult.failure.filename,
          stateCase.filename,
        );
        return true;
      },
    );
    assert.equal(await readFile(stateCase.filename, "utf8"), contents);
  }
});

test("invalid credentials and missing channel permissions are terminal", async (t) => {
  const config = await temporaryConfig(t, {
    TELEGRAM_CHANNEL_ID: "@rentals",
  });
  let browserStarted = false;

  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      browserFetcher: browser(),
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      api: telegramApi([], {
        getMe: async () => {
          throw new TelegramApiError("getMe", "Unauthorized", {
            httpStatus: 401,
            telegramErrorCode: 401,
          });
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof PreflightError);
      assert.equal(error.code, "ERR_TELEGRAM_CREDENTIALS");
      assert.equal(error.terminal, true);
      return true;
    },
  );

  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      browserFetcher: {
        ...browser(),
        start: async () => {
          browserStarted = true;
        },
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      api: telegramApi([], {
        getChatMember: async () => ({
          status: "administrator",
          can_post_messages: true,
          can_edit_messages: false,
        }),
      }),
    }),
    (error) => {
      assert.equal(error.code, "ERR_TELEGRAM_CHANNEL_PERMISSIONS");
      assert.equal(error.terminal, true);
      return true;
    },
  );
  assert.equal(browserStarted, false);
});

test("browser verification is a distinct non-ready result with remediation", async (t) => {
  const config = await temporaryConfig(t);
  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      browserFetcher: {
        start: async () => {},
        fetch: async () => {
          throw new BrowserVerificationRequiredError();
        },
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      api: telegramApi(),
    }),
    (error) => {
      assert.equal(error.code, "ERR_BROWSER_VERIFICATION_REQUIRED");
      assert.equal(error.terminal, false);
      assert.equal(
        error.preflightResult.status,
        "browser_verification_required",
      );
      assert.equal(
        error.preflightResult.remediationCommand,
        "npm run browser:verify",
      );
      assert.equal(error.preflightResult.checks.browser, "passed");
      assert.equal(
        error.preflightResult.checks.list_am,
        "browser_verification_required",
      );
      return true;
    },
  );
});

test("application logs one safe preflight result and never enters loops on challenge", async (t) => {
  const config = await temporaryConfig(t);
  const events = [];
  const records = [];
  let browserOptions;
  const fakeBrowser = {
    start: async () => {},
    fetch: async () => {
      await browserOptions.onEvent({
        name: "browser.challenge",
        component: "browser",
        code: "ERR_BROWSER_VERIFICATION_REQUIRED",
        remediationCommand: "npm run browser:verify",
      });
      throw new BrowserVerificationRequiredError();
    },
    close: async () => events.push("browser:close"),
  };

  await assert.rejects(
    runApplication({
      config,
      signalEmitter: new EventEmitter(),
      logger: {
        info: (message, context) => records.push({ message, context }),
        warn: (message, context) => records.push({ message, context }),
        error: (message, error, context) =>
          records.push({ message, error, context }),
      },
      validateConfig: async () => events.push("storage"),
      acquireLock: async () => singletonLock(config, events),
      browserFetcherFactory: (_browserConfig, options) => {
        browserOptions = options;
        return fakeBrowser;
      },
      exchangeRateServiceFactory: () => ({
        getSnapshot: async () => ratesSnapshot(),
      }),
      preflight: (preflightConfig, options) =>
        runStartupPreflight(preflightConfig, {
          ...options,
          api: telegramApi(),
        }),
      runBot: async () => events.push("bot"),
    }),
    /browser verification/iu,
  );

  const preflightRecords = records.filter(
    ({ message }) => message === "Startup preflight completed",
  );
  assert.equal(preflightRecords.length, 1);
  assert.equal(
    preflightRecords[0].context.preflight.status,
    "browser_verification_required",
  );
  assert.equal(
    JSON.stringify(preflightRecords[0]).includes(config.telegramBotToken),
    false,
  );
  const challengeRecords = records.filter(
    ({ message }) => message === "Browser challenge detected",
  );
  assert.deepEqual(challengeRecords, [
    {
      message: "Browser challenge detected",
      context: {
        eventName: "browser.challenge",
        component: "browser",
        code: "ERR_BROWSER_VERIFICATION_REQUIRED",
        remediationCommand: "npm run browser:verify",
      },
    },
  ]);
  assert.deepEqual(events, ["storage", "browser:close", "lock:release"]);
});
