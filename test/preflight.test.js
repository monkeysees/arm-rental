import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runApplication } from "../src/application.js";
import { ListAmChallengeError } from "../src/list-am-http.js";
import { getConfig } from "../src/config.js";
import { crawlApartments } from "../src/crawler.js";
import {
  PreflightError,
  runStartupPreflight,
  StateCompatibilityError,
} from "../src/preflight.js";
import { TelegramApiError } from "../src/telegram.js";
import { ListAmIntegrityReason } from "../src/source-integrity.js";
import { createMemoryStateAccess } from "../test-support/memory-state.js";

const REGULAR_ADS_HTML = `
  <div id="contentr">
    <a class="fav-item-info-container" href="/ru/item/200">
      <div class="dltitle"><div class="pt">Apartment</div></div>
      <div class="p">220000 ֏</div>
      <div class="at">Кентрон, 2 ком., 50 кв.м., 3/5 этаж</div>
      <div class="d">Friday, July 24, 2026, 14:31</div>
    </a>
  </div>`;

function regularAdsHtml(count) {
  return `<div id="contentr">${Array.from(
    { length: count },
    (_value, index) => `
      <a class="fav-item-info-container" href="/item/${200 + index}">
        <div class="dltitle"><div class="pt">Apartment ${index}</div></div>
        <div class="d">Friday, July 24, 2026, 14:31</div>
      </a>`,
  ).join("")}</div>`;
}

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

function source(events = []) {
  return {
    start: async () => events.push("source:start"),
    fetch: async () => {
      events.push("list:fetch");
      return new Response(REGULAR_ADS_HTML);
    },
    close: async () => events.push("source:close"),
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

/** Stored state as the repositories rebuild it, which is all preflight sees. */
function storedState(config, seed = {}) {
  return createMemoryStateAccess({
    listUrlTemplate: config.listUrlTemplate,
    channelConfigured: Boolean(config.telegramChannelId),
    ...seed,
  });
}

test("preflight validates every state target and all external boundaries before readiness", async (t) => {
  const config = await temporaryConfig(t, {
    TELEGRAM_CHANNEL_ID: "@rentals",
  });
  const rates = ratesSnapshot();
  const stateAccess = storedState(config, {
    apartments: {
      version: 3,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      apartments: {},
      apartmentOrder: [],
      sourceIntegrity: { recentFirstPageCounts: [] },
    },
    deliveries: { 42: { notified: {}, initialSelectionApplied: true } },
    channel: {
      version: 1,
      type: "telegram-channel-deliveries",
      channelId: config.telegramChannelId,
      urlTemplate: config.listUrlTemplate,
      initialized: true,
      filterFingerprint: "a".repeat(64),
      apartments: {},
    },
    exchangeRates: rates,
  });
  const events = [];

  const result = await runStartupPreflight(config, {
    storageValidated: true,
    singletonLock: singletonLock(config),
    sourceFetcher: source(events),
    exchangeRateService: {
      getSnapshot: async () => {
        events.push("rates:getSnapshot");
        return rates;
      },
    },
    api: telegramApi(events),
    stateAccess,
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
      source_transport: "passed",
      list_am: "passed",
      exchange_rates: "passed",
    },
  });
  assert.deepEqual(events, [
    "telegram:getMe",
    "telegram:getChat",
    "telegram:getChatMember",
    "source:start",
    "rates:getSnapshot",
    "list:fetch",
  ]);
});

test("preflight records parsed unique apartments rather than raw candidates", async (t) => {
  const config = await temporaryConfig(t);
  const integrityChecks = [];
  const diagnosticHtml = `
    <div id="contentr">
      <a class="fav-item-info-container" href="/ru/item/200">
        <div class="dltitle"><div class="pt">Apartment</div></div>
        <div class="d">Friday, July 24, 2026, 14:31</div>
      </a>
      <a class="fav-item-info-container" href="/item/200">Duplicate</a>
    </div>`;

  const result = await runStartupPreflight(config, {
    storageValidated: true,
    singletonLock: singletonLock(config),
    sourceFetcher: {
      start: async () => {},
      fetch: async () => new Response(diagnosticHtml),
    },
    exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
    api: telegramApi(),
    stateAccess: storedState(config),
    onSourceIntegrityChecked: async (observation) =>
      integrityChecks.push(observation),
  });

  assert.equal(result.status, "ready");
  assert.equal(integrityChecks[0].pages[0].parsedCount, 1);
  assert.equal(JSON.stringify(integrityChecks).includes("apartments"), false);
});

test("preflight and runtime report the same integrity reason without writes", async (t) => {
  const config = await temporaryConfig(t);
  const missingTitleHtml = `
    <div id="contentr">
      <a class="fav-item-info-container" href="/item/200">
        <div class="d">Friday, July 24, 2026, 14:31</div>
      </a>
    </div>`;
  let preflightError;

  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      sourceFetcher: {
        start: async () => {},
        fetch: async () => new Response(missingTitleHtml),
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      api: telegramApi(),
      stateAccess: storedState(config),
    }),
    (error) => {
      preflightError = error;
      return (
        error.code === "ERR_LIST_AM_SOURCE_INTEGRITY" &&
        error.details.reason ===
          ListAmIntegrityReason.TITLE_COMPLETENESS_BELOW_THRESHOLD
      );
    },
  );

  let runtimeError;
  const runtimeState = storedState(config);
  await assert.rejects(
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        stateAccess: runtimeState,
        fetchPage: async () => new Response(missingTitleHtml),
      },
    ),
    (error) => {
      runtimeError = error;
      return error.code === "ERR_LIST_AM_SOURCE_INTEGRITY";
    },
  );

  assert.equal(preflightError.details.reason, runtimeError.reason);
  assert.deepEqual(runtimeState.writes, []);
});

test("preflight applies the persisted count baseline before readiness", async (t) => {
  const config = await temporaryConfig(t);
  const baseline = storedState(config, {
    apartments: {
      version: 3,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      apartments: {},
      apartmentOrder: [],
      sourceIntegrity: {
        recentFirstPageCounts: [20, 20, 20],
        lastSuccessfulAt: "2026-07-26T11:00:00.000Z",
      },
    },
  });

  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      sourceFetcher: {
        start: async () => {},
        fetch: async () => new Response(regularAdsHtml(9)),
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      api: telegramApi(),
      stateAccess: baseline,
    }),
    (error) =>
      error.code === "ERR_LIST_AM_SOURCE_INTEGRITY" &&
      error.details.reason === ListAmIntegrityReason.FIRST_PAGE_COUNT_DROP,
  );
});

test("preflight refuses stored rows the running code cannot use", async (t) => {
  const config = await temporaryConfig(t, { TELEGRAM_CHANNEL_ID: "@rentals" });
  const unreadable = () => {
    const error = new Error("Stored private delivery decision is invalid");
    error.code = "ERR_STATE_DATABASE_DOMAIN_INVALID";
    throw error;
  };
  const cases = [
    {
      name: "an apartment history longer than the source-integrity window",
      seed: {
        apartments: {
          version: 3,
          type: "list-am-apartments",
          urlTemplate: config.listUrlTemplate,
          apartments: {},
          apartmentOrder: [],
          sourceIntegrity: { recentFirstPageCounts: [1, 2, 3, 4, 5, 6] },
        },
      },
      domain: "apartments",
      reason: /rebuilt state is malformed/u,
    },
    {
      name: "apartments belonging to a different List.am target",
      seed: {
        apartments: {
          version: 3,
          type: "list-am-apartments",
          urlTemplate: "https://www.list.am/category/99/{page}",
          apartments: {},
          apartmentOrder: [],
          sourceIntegrity: { recentFirstPageCounts: [] },
        },
      },
      domain: "apartments",
      reason: /rebuilt state is malformed/u,
    },
    {
      name: "a channel state pointing at another channel",
      seed: {
        channel: {
          version: 1,
          type: "telegram-channel-deliveries",
          channelId: "@somewhere_else",
          urlTemplate: config.listUrlTemplate,
          initialized: true,
          filterFingerprint: "a".repeat(64),
          apartments: {},
        },
      },
      domain: "channel delivery",
      reason: /rebuilt state is malformed/u,
    },
    {
      name: "a bot user whose pending deletion left it active",
      seed: {
        telegram: {
          version: 3,
          type: "telegram-bot",
          updateOffset: 10,
          users: {
            42: {
              chatId: 42,
              active: true,
              sendInitialApartments: false,
              filters: {
                price: { min: null, max: null },
                rooms: { min: null, max: null },
                locations: [],
              },
              pendingFilterInput: null,
              deletionPendingAt: "2026-07-26T12:00:00.000Z",
            },
          },
        },
      },
      domain: "Telegram bot",
      reason: /rebuilt state is malformed/u,
    },
    {
      name: "a delivery decision row the repository refuses to decode",
      seed: {},
      corrupt: (stateAccess) => {
        stateAccess.privateDeliveries.validate = unreadable;
      },
      domain: "private delivery",
      reason: /stored rows could not be read/u,
    },
    {
      // The rows are readable and the store still refuses them: a decision
      // timestamp that would not survive being decoded when the recipient it
      // belongs to is next delivered to.
      name: "a delivery decision timestamp the store judges malformed",
      seed: {
        deliveries: {
          42: { notified: { 61: "2026-07-26T12:00:00Z" } },
        },
      },
      domain: "private delivery",
      reason: /stored rows are malformed/u,
    },
  ];

  for (const stateCase of cases) {
    await t.test(stateCase.name, async () => {
      const stateAccess = storedState(config, stateCase.seed);
      stateCase.corrupt?.(stateAccess);
      await assert.rejects(
        runStartupPreflight(config, { storageValidated: true, stateAccess }),
        (error) => {
          assert.ok(error instanceof StateCompatibilityError);
          assert.equal(error.code, "ERR_STATE_INCOMPATIBLE");
          assert.equal(error.terminal, true);
          assert.equal(error.domain, stateCase.domain);
          assert.match(error.message, stateCase.reason);
          assert.equal(error.preflightResult.failure.domain, stateCase.domain);
          assert.equal(error.preflightResult.checks.state, "failed");
          return true;
        },
      );
      // Refusing must never rewrite what it refused.
      assert.deepEqual(stateAccess.writes, []);
    });
  }

  // Channel publication has no storage to reach when a channel is configured
  // but the database predates it, so preflight refuses rather than crash later.
  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      stateAccess: createMemoryStateAccess({
        listUrlTemplate: config.listUrlTemplate,
      }),
    }),
    (error) =>
      error instanceof StateCompatibilityError &&
      error.domain === "channel delivery" &&
      /storage is not configured/u.test(error.message),
  );
});

test("preflight without an opened state backend refuses to start", async (t) => {
  const config = await temporaryConfig(t);
  await assert.rejects(
    runStartupPreflight(config, { storageValidated: true }),
    (error) =>
      error.code === "ERR_PREFLIGHT_STATE" &&
      error.terminal === true &&
      error.preflightResult.checks.state === "failed",
  );
});

test("invalid credentials and missing channel permissions are terminal", async (t) => {
  const config = await temporaryConfig(t, {
    TELEGRAM_CHANNEL_ID: "@rentals",
  });
  let sourceStarted = false;

  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      sourceFetcher: source(),
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      stateAccess: storedState(config),
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
      sourceFetcher: {
        ...source(),
        start: async () => {
          sourceStarted = true;
        },
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      stateAccess: storedState(config),
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
  assert.equal(sourceStarted, false);
});

test("HTTP challenge is a distinct non-ready result", async (t) => {
  const config = await temporaryConfig(t);
  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      sourceFetcher: {
        start: async () => {},
        fetch: async () => {
          throw new ListAmChallengeError(403, "edge");
        },
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      stateAccess: storedState(config),
      api: telegramApi(),
    }),
    (error) => {
      assert.equal(error.code, "ERR_LIST_AM_CHALLENGE");
      assert.equal(error.terminal, false);
      assert.equal(error.preflightResult.status, "source_challenge");
      assert.equal(error.preflightResult.checks.source_transport, "passed");
      assert.equal(error.preflightResult.checks.exchange_rates, "passed");
      assert.equal(error.preflightResult.checks.list_am, "source_challenge");
      return true;
    },
  );
});

test("application logs a safe source challenge and starts bot controls", async (t) => {
  const config = await temporaryConfig(t);
  const events = [];
  const records = [];
  let sourceOptions;
  const fakeSource = {
    start: async () => {},
    fetch: async () => {
      await sourceOptions.onEvent({
        name: "list_am.challenge",
        component: "list_am",
        code: "ERR_LIST_AM_CHALLENGE",
        httpStatus: 403,
        challengeSource: "edge",
      });
      throw new ListAmChallengeError(403, "edge");
    },
    close: async () => events.push("source:close"),
  };

  await runApplication({
    config,
    sleep: async (milliseconds) => events.push(`cooldown:${milliseconds}`),
    signalEmitter: new EventEmitter(),
    logger: {
      info: (message, context) => records.push({ message, context }),
      warn: (message, context) => records.push({ message, context }),
      error: (message, error, context) =>
        records.push({ message, error, context }),
    },
    validateConfig: async () => events.push("storage"),
    acquireLock: async () => singletonLock(config, events),
    sourceFetcherFactory: (_sourceConfig, options) => {
      sourceOptions = options;
      return fakeSource;
    },
    exchangeRateServiceFactory: () => ({
      getSnapshot: async () => ratesSnapshot(),
    }),
    stateBackendFactory: async () => ({
      stateAccess: storedState(config),
      close: () => events.push("state:close"),
    }),
    preflight: (preflightConfig, options) =>
      runStartupPreflight(preflightConfig, {
        ...options,
        api: telegramApi(),
      }),
    runBot: async () => events.push("bot"),
  });

  const preflightRecords = records.filter(
    ({ message }) => message === "Startup preflight completed",
  );
  assert.equal(preflightRecords.length, 1);
  assert.equal(
    preflightRecords[0].context.preflight.status,
    "source_challenge",
  );
  assert.equal(
    JSON.stringify(preflightRecords[0]).includes(config.telegramBotToken),
    false,
  );
  const challengeRecords = records.filter(
    ({ message }) => message === "List.am challenge detected",
  );
  assert.deepEqual(challengeRecords, [
    {
      message: "List.am challenge detected",
      context: {
        event: "list_am.challenge",
        component: "list_am",
        code: "ERR_LIST_AM_CHALLENGE",
        httpStatus: 403,
        challengeSource: "edge",
      },
    },
  ]);
  assert.deepEqual(events, [
    "storage",
    "bot",
    "source:close",
    "state:close",
    "lock:release",
  ]);
});

test("missing native transport is terminal before any source request", async (t) => {
  const config = await temporaryConfig(t);
  let fetches = 0;
  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      sourceFetcher: {
        start: async () => {
          throw new Error("executable missing");
        },
        fetch: async () => {
          fetches += 1;
        },
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      stateAccess: storedState(config),
      api: telegramApi(),
    }),
    (error) => {
      assert.equal(error.code, "ERR_PREFLIGHT_SOURCE_TRANSPORT");
      assert.equal(error.terminal, true);
      assert.equal(error.preflightResult.checks.source_transport, "failed");
      return true;
    },
  );
  assert.equal(fetches, 0);
});

test("preflight preserves HTTP rate-limit cooldown without exposing response content", async (t) => {
  const config = await temporaryConfig(t);
  await assert.rejects(
    runStartupPreflight(config, {
      storageValidated: true,
      singletonLock: singletonLock(config),
      sourceFetcher: {
        start: async () => {},
        fetch: async () =>
          new Response("PRIVATE RESPONSE", {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      },
      exchangeRateService: { getSnapshot: async () => ratesSnapshot() },
      stateAccess: storedState(config),
      api: telegramApi(),
    }),
    (error) => {
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterMs, 120_000);
      assert.equal(error.terminal, false);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE RESPONSE/u);
      return true;
    },
  );
});
