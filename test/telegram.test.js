import assert from "node:assert/strict";
import test from "node:test";

import {
  compatibleBotState,
  isPrivateUserAuthorized,
  migrateBotState,
  privateAccessSummary,
  processUpdates,
  runTelegramBot,
} from "../src/bot.js";
import {
  formatApartmentMessage,
  isStartCommand,
  TelegramApi,
} from "../src/telegram.js";
import { createPrivateRateLimits } from "../src/rate-limit.js";
import {
  ListAmIntegrityReason,
  ListAmSourceIntegrityError,
} from "../src/source-integrity.js";

const config = { telegramOwnerId: 42 };
const initialState = {
  version: 1,
  type: "telegram-bot",
  ownerId: 42,
  active: false,
  chatId: null,
  updateOffset: 0,
};

test("multi-user bot state is independent of the server-alert owner", () => {
  assert.equal(
    compatibleBotState({
      version: 2,
      type: "telegram-bot",
      updateOffset: 0,
      users: {},
    }),
    true,
  );
  assert.equal(
    compatibleBotState({
      version: 1,
      type: "telegram-bot",
      ownerId: 99,
      updateOffset: 0,
    }),
    true,
  );
});

test("legacy bot state migrates strictly to schema version three", () => {
  const legacy = migrateBotState({
    version: 1,
    type: "telegram-bot",
    ownerId: 99,
    chatId: 99,
    active: true,
    updateOffset: 12,
  });
  assert.equal(legacy.version, 3);
  assert.equal(legacy.updateOffset, 12);
  assert.equal(legacy.users[99].chatId, 99);
  assert.equal(legacy.users[99].active, true);

  const versionTwo = migrateBotState({
    version: 2,
    type: "telegram-bot",
    updateOffset: 13,
    users: { 99: { chatId: 99, active: false } },
  });
  assert.equal(versionTwo.version, 3);
  assert.equal(versionTwo.users[99].chatId, 99);

  for (const invalid of [
    {
      version: 2,
      type: "telegram-bot",
      updateOffset: 0,
      users: { 99: { active: false } },
    },
    {
      version: 2,
      type: "telegram-bot",
      updateOffset: 0,
      users: {
        99: {
          chatId: 99,
          deletionPendingAt: "2026-07-26T12:00:00.000Z",
        },
      },
    },
    {
      version: 3,
      type: "telegram-bot",
      updateOffset: "13",
      users: {},
    },
  ]) {
    assert.equal(compatibleBotState(invalid), false);
    assert.throws(() => migrateBotState(invalid), /incompatible schema/u);
  }
});

test("private access modes authorize owners and configured users", () => {
  assert.equal(
    isPrivateUserAuthorized(
      { telegramOwnerId: 42, telegramAccessMode: "owner" },
      42,
    ),
    true,
  );
  assert.equal(
    isPrivateUserAuthorized(
      {
        telegramOwnerId: 42,
        telegramAccessMode: "allowlist",
        telegramAllowedUserIds: [99],
      },
      99,
    ),
    true,
  );
  assert.equal(
    isPrivateUserAuthorized(
      { telegramOwnerId: 42, telegramAccessMode: "owner" },
      99,
    ),
    false,
  );
});

function update(updateId, fromId, text, type = "private") {
  return {
    update_id: updateId,
    message: {
      from: { id: fromId },
      chat: { id: fromId, type },
      text,
    },
  };
}

function callback(updateId, data, messageId = 100, fromId = 42) {
  return {
    update_id: updateId,
    callback_query: {
      id: `query-${updateId}`,
      from: { id: fromId },
      data,
      message: {
        message_id: messageId,
        chat: { id: fromId, type: "private" },
      },
    },
  };
}

test("restricted access advances offsets without creating or mutating users", async () => {
  const saved = [];
  const answered = [];
  const restrictedState = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: {
      99: {
        active: true,
        chatId: 99,
        sendInitialApartments: false,
        filters: {
          price: { min: null, max: null },
          rooms: { min: null, max: null },
          locations: ["r:0"],
        },
        pendingFilterInput: null,
      },
    },
  };
  const mismatched = callback(3, "m:stop", 100, 42);
  mismatched.callback_query.message.chat.id = 99;

  const state = await processUpdates(
    [
      update(1, 7, "/start"),
      callback(2, "f:reset", 100, 99),
      mismatched,
      update(4, 42, "/start"),
    ],
    { telegramOwnerId: 42, telegramAccessMode: "owner" },
    restrictedState,
    {
      sendMessage: async () => {},
      editMessage: async () => {},
      answerCallback: async (id) => answered.push(id),
      saveState: async (value) => saved.push(structuredClone(value)),
    },
  );

  assert.equal(state.updateOffset, 5);
  assert.equal(state.users[7], undefined);
  assert.deepEqual(state.users[99], restrictedState.users[99]);
  assert.ok(saved.some(({ updateOffset }) => updateOffset === 2));
  assert.ok(saved.some(({ updateOffset }) => updateOffset === 3));
  assert.deepEqual(answered, ["query-2", "query-3"]);
  assert.equal(state.users[42].active, false);
});

test("denied users receive one bounded response without limiter or state entries", async () => {
  let now = 0;
  const senderId = 73_429_851;
  const events = [];
  const sent = [];
  const answered = [];
  const saves = [];
  const limits = createPrivateRateLimits(5, {
    monotonicNow: () => now,
  });
  const state = await processUpdates(
    [
      update(1, senderId, "/start private-payload"),
      update(2, senderId, "/start"),
      callback(3, "f:reset", 100, senderId),
      update(4, senderId, "/start", "group"),
    ],
    { telegramOwnerId: 42, telegramAccessMode: "owner" },
    initialState,
    {
      sendMessage: async (...arguments_) => sent.push(arguments_),
      editMessage: async () => assert.fail("denied callbacks must not edit"),
      answerCallback: async (id) => answered.push(id),
      saveState: async (value) => saves.push(structuredClone(value)),
      onAccessDenied: async (event) => events.push(event),
      rateLimits: limits,
    },
  );

  assert.equal(state.users[senderId], undefined);
  assert.equal(state.updateOffset, 5);
  assert.equal(limits.inboundUpdates.size, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], new RegExp(String(senderId), "u"));
  assert.deepEqual(answered, ["query-3"]);
  assert.deepEqual(
    events,
    Array.from({ length: 3 }, () => ({
      accessMode: "owner",
      reason: "not_authorized",
    })),
  );
  assert.ok(saves.some(({ updateOffset }) => updateOffset === 2));
  assert.ok(saves.some(({ updateOffset }) => updateOffset === 3));
  assert.ok(saves.some(({ updateOffset }) => updateOffset === 4));

  now += 5 * 60_000;
  await processUpdates(
    [update(5, senderId, "/start")],
    { telegramOwnerId: 42, telegramAccessMode: "owner" },
    state,
    {
      sendMessage: async (...arguments_) => sent.push(arguments_),
      saveState: async () => {},
      rateLimits: limits,
    },
  );
  assert.equal(sent.length, 2);
});

test("inbound limits are shared across messages and callbacks with durable offsets", async () => {
  const senderId = 84_765_219;
  const limits = createPrivateRateLimits(5, { monotonicNow: () => 0 });
  const saves = [];
  const sent = [];
  const answered = [];
  const edits = [];
  const events = [];
  const state = await processUpdates(
    [
      update(1, senderId, "/start"),
      update(2, senderId, "plain-one"),
      callback(3, "unknown", 100, senderId),
      update(4, senderId, "plain-two"),
      callback(5, "unknown", 100, senderId),
      callback(6, "f:reset", 100, senderId),
      update(7, senderId, "/filters"),
    ],
    {
      telegramOwnerId: 42,
      telegramAccessMode: "public",
      telegramUserUpdatesPerMinute: 5,
    },
    initialState,
    {
      sendMessage: async (...arguments_) => sent.push(arguments_),
      editMessage: async (...arguments_) => edits.push(arguments_),
      answerCallback: async (id) => answered.push(id),
      saveState: async (value) => saves.push(structuredClone(value)),
      onUserRateLimited: async (event) => events.push(event),
      rateLimits: limits,
    },
  );

  assert.equal(state.updateOffset, 8);
  assert.equal(state.users[senderId].active, false);
  assert.equal(edits.length, 0);
  assert.deepEqual(answered, ["query-3", "query-5", "query-6"]);
  assert.equal(sent.length, 2);
  assert.match(sent[1][1], /Слишком много запросов/u);
  assert.deepEqual(events, [{ updatesPerMinute: 5 }]);
  assert.ok(saves.some(({ updateOffset }) => updateOffset === 7));
  assert.ok(saves.some(({ updateOffset }) => updateOffset === 8));
});

test("public access persists many authorized users without admission capacity", async () => {
  const userCount = 300;
  const state = await processUpdates(
    Array.from({ length: userCount }, (_, index) =>
      update(index + 1, 10_000 + index, "/start"),
    ),
    {
      telegramOwnerId: 42,
      telegramAccessMode: "public",
      telegramUserUpdatesPerMinute: 30,
    },
    {
      version: 2,
      type: "telegram-bot",
      updateOffset: 0,
      users: {},
    },
    {
      sendMessage: async () => {},
      saveState: async () => {},
    },
  );

  assert.equal(Object.keys(state.users).length, userCount);
  assert.equal(state.updateOffset, userCount + 1);
});

test("accepted and rejected update replays keep their original rate decisions", async () => {
  let now = 0;
  const senderId = 91_234;
  const limits = createPrivateRateLimits(5, { monotonicNow: () => now });
  const runtimeConfig = {
    telegramOwnerId: 42,
    telegramAccessMode: "public",
    telegramUserUpdatesPerMinute: 5,
  };
  let state = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: {},
  };

  await assert.rejects(
    processUpdates([update(1, senderId, "/start")], runtimeConfig, state, {
      sendMessage: async () => {},
      saveState: async () => {
        throw new Error("temporary state failure");
      },
      rateLimits: limits,
    }),
    /temporary state failure/u,
  );
  state = await processUpdates(
    [
      update(1, senderId, "/start"),
      update(2, senderId, "plain"),
      update(3, senderId, "plain"),
      update(4, senderId, "plain"),
      update(5, senderId, "plain"),
      update(6, senderId, "/filters"),
    ],
    runtimeConfig,
    state,
    {
      sendMessage: async () => {},
      saveState: async () => {},
      rateLimits: limits,
    },
  );
  assert.equal(state.users[senderId].active, false);

  now += 12_000;
  const sent = [];
  state = await processUpdates(
    [update(6, senderId, "/filters"), update(7, senderId, "/filters")],
    runtimeConfig,
    state,
    {
      sendMessage: async (...arguments_) => sent.push(arguments_),
      saveState: async () => {},
      rateLimits: limits,
    },
  );

  assert.equal(sent.length, 1, "the new update uses the refilled token");
  assert.doesNotMatch(sent[0][1], /Слишком много запросов/u);
  assert.equal(state.updateOffset, 8);
});

test("a failed rejection reply cannot roll back its durable update offset", async () => {
  const saved = [];
  await assert.rejects(
    processUpdates(
      [update(10, 77, "/start")],
      { telegramOwnerId: 42, telegramAccessMode: "owner" },
      initialState,
      {
        sendMessage: async () => {
          throw new Error("reply unavailable");
        },
        saveState: async (value) => saved.push(structuredClone(value)),
      },
    ),
    /reply unavailable/u,
  );

  assert.equal(saved.at(-1).updateOffset, 11);
  assert.equal(saved.at(-1).users[77], undefined);
});

test("runtime offsets follow durable writes across later and earlier failures", async (testContext) => {
  const runFailureCase = async ({
    accessMode,
    failSave = false,
    failTelemetry = false,
    failReply = false,
  }) => {
    const controller = new AbortController();
    const offsets = [];
    let polls = 0;
    let saves = 0;
    const api = {
      getUpdates: async (offset) => {
        offsets.push(offset);
        polls += 1;
        if (polls === 1) return [update(1, 99, "/start")];
        controller.abort();
        return [];
      },
      sendMessage: async () => {
        if (failReply) throw new Error("reply failed after save");
      },
    };

    await runTelegramBot(
      {
        telegramBotToken: "token",
        telegramOwnerId: 42,
        telegramAccessMode: accessMode,
        telegramStateFile: "/state/bot.json",
        telegramPollTimeoutSeconds: 25,
        telegramUserUpdatesPerMinute: 30,
        telegramPrivateDeliveriesPerMinute: 20,
        timeoutMs: 1_000,
        pollIntervalMs: 60_000,
      },
      {
        api,
        signal: controller.signal,
        loadState: async () => undefined,
        saveState: async () => {
          saves += 1;
          if (failSave && saves === 1) {
            throw new Error("durable write failed");
          }
        },
        sleep: async () => {},
        onError: async () => {},
        onPrivateAccessDenied: async () => {
          if (failTelemetry) throw new Error("telemetry failed after save");
        },
      },
    );
    return offsets;
  };

  await testContext.test(
    "failed durable write keeps the old offset",
    async () => {
      assert.deepEqual(
        await runFailureCase({ accessMode: "public", failSave: true }),
        [0, 0],
      );
    },
  );
  await testContext.test(
    "telemetry failure keeps the saved offset",
    async () => {
      assert.deepEqual(
        await runFailureCase({ accessMode: "owner", failTelemetry: true }),
        [0, 2],
      );
    },
  );
  await testContext.test("reply failure keeps the saved offset", async () => {
    assert.deepEqual(
      await runFailureCase({ accessMode: "public", failReply: true }),
      [0, 2],
    );
  });
});

test("persisted suspended users have a reserved access-bypass route", async () => {
  const bypassed = [];
  const limits = createPrivateRateLimits(5, { monotonicNow: () => 0 });
  for (let count = 0; count < 5; count += 1) {
    limits.inboundUpdates.tryConsume(99);
  }
  const state = await processUpdates(
    [update(1, 99, "/future-delete")],
    { telegramOwnerId: 42, telegramAccessMode: "owner" },
    {
      version: 2,
      type: "telegram-bot",
      updateOffset: 0,
      users: { 99: { active: true, chatId: 99 } },
    },
    {
      sendMessage: async () => {},
      editMessage: async () => {},
      saveState: async () => {},
      isPersistedUserAccessBypass: ({ senderId }) => {
        bypassed.push(senderId);
        return true;
      },
      rateLimits: limits,
    },
  );

  assert.deepEqual(bypassed, [99]);
  assert.equal(state.users[99].active, true);
  assert.equal(state.updateOffset, 2);
});

test("access summaries suspend users without changing their saved choices", () => {
  const state = {
    users: {
      42: { chatId: 42, active: false },
      99: {
        chatId: 99,
        active: true,
        sendInitialApartments: false,
        filters: { locations: ["r:0"] },
      },
    },
  };
  const before = structuredClone(state);

  assert.deepEqual(
    privateAccessSummary(state, {
      telegramOwnerId: 42,
      telegramAccessMode: "owner",
    }),
    {
      accessMode: "owner",
      persistedUserCount: 2,
      authorizedUserCount: 1,
      suspendedUserCount: 1,
      activeUserCount: 0,
    },
  );
  assert.equal(
    privateAccessSummary(state, {
      telegramOwnerId: 42,
      telegramAccessMode: "public",
    }).activeUserCount,
    1,
  );
  assert.deepEqual(state, before);
});

test("private users explicitly start and stop monitoring from the setup panel", async () => {
  const sent = [];
  const edited = [];
  const saved = [];
  const subscriptionChanges = [];
  const state = await processUpdates(
    [
      update(10, 99, "/start"),
      update(11, 42, "/start", "group"),
      update(12, 42, "/start"),
      callback(13, "m:start"),
      callback(14, "m:start:new"),
      callback(15, "m:stop"),
    ],
    config,
    initialState,
    {
      sendMessage: async (...args) => sent.push(args),
      editMessage: async (...args) => edited.push(args),
      saveState: async (value) => saved.push(structuredClone(value)),
      onSubscriptionChanged: async (_state, event) =>
        subscriptionChanges.push(event),
    },
  );

  assert.equal(state.version, 3);
  assert.equal(state.users["99"].active, false);
  assert.equal(state.users["42"].active, false);
  assert.equal(state.users["42"].sendInitialApartments, false);
  assert.equal(state.updateOffset, 16);
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /Мониторинг: остановлен/u);
  assert.equal(sent[0][2].inline_keyboard.at(-1)[0].callback_data, "m:start");
  assert.match(edited[0][2], /Отправить уже найденные квартиры/u);
  assert.match(edited[1][2], /Мониторинг: запущен/u);
  assert.equal(edited[1][3].inline_keyboard.at(-1)[0].callback_data, "m:stop");
  assert.match(edited.at(-1)[2], /Мониторинг: остановлен/u);
  assert.deepEqual(subscriptionChanges, [
    { active: true, sendInitialApartments: false },
    { active: false, sendInitialApartments: false },
  ]);
  assert.equal(
    saved.some(
      (value) =>
        value.updateOffset === 14 && value.users["42"]?.active === false,
    ),
    true,
  );
  assert.equal(
    saved.some((value) => value.users["42"]?.active === true),
    true,
  );
  assert.equal(saved.at(-1).updateOffset, 16);
});

test("a user configures ranges and multiple locations through Telegram", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const saved = [];

  const state = await processUpdates(
    [
      update(20, 42, "/filters"),
      callback(21, "f:locations"),
      callback(22, "f:region:0"),
      callback(23, "f:place:0:1"),
      callback(24, "f:locations"),
      callback(25, "f:region:1"),
      callback(26, "f:all:1"),
      callback(27, "f:price"),
      update(28, 42, "150000-300000"),
    ],
    config,
    initialState,
    {
      sendMessage: async (...args) => sent.push(args),
      editMessage: async (...args) => edited.push(args),
      answerCallback: async (id) => answered.push(id),
      saveState: async (value) => saved.push(structuredClone(value)),
    },
  );

  assert.deepEqual(state.users["42"].filters.price, {
    min: 150_000,
    max: 300_000,
  });
  assert.deepEqual(state.users["42"].filters.locations, ["p:0:1", "r:1"]);
  assert.equal(state.users["42"].pendingFilterInput, null);
  assert.equal(state.updateOffset, 29);
  assert.equal(answered.length, 7);
  const locationsView = edited.find((entry) =>
    entry[2].startsWith("Выбор местоположения"),
  );
  assert.match(locationsView[3].inline_keyboard[0][0].text, /Ереван/);
  assert.match(sent.at(-1)[1], /Цена \(֏\): 150\u00a0000–300\u00a0000/);
  assert.doesNotMatch(sent.at(-1)[1], /валюте объявления/);
  assert.equal(
    sent
      .at(-1)[2]
      .inline_keyboard.flat()
      .some(({ text }) => text === "Готово"),
    false,
  );
  assert.equal(saved.at(-1).updateOffset, 29);
});

test("filter changes are persisted before the menu is refreshed", async () => {
  const events = [];

  const state = await processUpdates(
    [callback(30, "f:all:0")],
    config,
    initialState,
    {
      sendMessage: async () => {},
      editMessage: async () => events.push("edit"),
      answerCallback: async () => events.push("answer"),
      saveState: async () => events.push("save"),
    },
  );

  assert.deepEqual(state.users["42"].filters.locations, ["r:0"]);
  assert.deepEqual(events.slice(0, 3), ["answer", "save", "edit"]);
});

test("private users maintain independent filter input and settings", async () => {
  const state = await processUpdates(
    [callback(40, "f:price", 100, 99), update(41, 99, "200000-250000")],
    config,
    initialState,
    {
      sendMessage: async () => {},
      editMessage: async () => {},
      answerCallback: async () => {},
      saveState: async () => {},
    },
  );

  assert.deepEqual(state.users["99"].filters.price, {
    min: 200_000,
    max: 250_000,
  });
  assert.equal(state.users["99"].pendingFilterInput, null);
  assert.deepEqual(state.users["42"].filters.price, {
    min: null,
    max: null,
  });
});

test("Telegram helpers format normalized apartment data", () => {
  assert.equal(isStartCommand("/start@rental_bot payload"), true);
  assert.equal(isStartCommand("/starter"), false);
  assert.equal(
    formatApartmentMessage({
      itemId: "200",
      title: "Apartment on Komitas",
      price: { amount: 220_000, currency: "֏" },
      location: "Arabkir",
      rooms: 2,
      areaSqM: 50,
      floor: "3/5",
      date: "Friday, July 24, 2026, 14:31",
      url: "https://www.list.am/ru/item/200",
    }),
    [
      "Apartment on Komitas",
      "Цена: 220 000 ֏",
      "Местоположение: Arabkir",
      "Количество комнат: 2",
      "Площадь: 50 м²",
      "Этаж: 3/5",
      "https://www.list.am/ru/item/200",
    ].join("\n"),
  );
});

test("Telegram helpers use Russian fallbacks for missing apartment data", () => {
  assert.equal(
    formatApartmentMessage({
      itemId: "201",
      title: "",
      price: { amount: null, currency: null },
      location: "",
      rooms: null,
      areaSqM: null,
      floor: null,
      date: null,
      url: "https://www.list.am/ru/item/201",
    }),
    [
      "Квартира 201",
      "Цена: не указана",
      "Местоположение: не указано",
      "Количество комнат: не указано",
      "Площадь: не указана",
      "Этаж: не указан",
      "https://www.list.am/ru/item/201",
    ].join("\n"),
  );
});

test("Telegram messages show the original foreign-currency price", () => {
  const message = formatApartmentMessage({
    itemId: "202",
    title: "Apartment in Kentron",
    price: {
      amountAmd: 585_392,
      originalAmount: 1_600,
      originalCurrency: "USD",
      exchangeRate: 365.87,
      exchangeRateFetchedAt: "2026-07-24T09:15:00.000Z",
      exchangeRateEffectiveDate: "2026-07-24",
    },
    location: "Кентрон",
    rooms: 2,
    areaSqM: 75,
    floor: "11/14",
    url: "https://www.list.am/ru/item/202",
  });

  assert.match(message, /Цена: 1\u00a0600 \$/u);
  assert.doesNotMatch(message, /585/u);
});

test("TelegramApi obeys retry_after when Telegram rate limits delivery", async () => {
  const sleeps = [];
  let calls = 0;
  const api = new TelegramApi("secret", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          {
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 2 },
          },
          { status: 429 },
        );
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  await api.sendMessage(42, "hello");

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test("TelegramApi retries network and 5xx failures but not invalid credentials", async () => {
  const sleeps = [];
  let calls = 0;
  const api = new TelegramApi("secret", {
    retryBaseMs: 1_000,
    retryMaxMs: 5_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      if (calls === 2) {
        return Response.json(
          { ok: false, description: "Bad Gateway" },
          { status: 502 },
        );
      }
      return Response.json({ ok: true, result: true });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  await api.getMe();
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0]);

  const terminalApi = new TelegramApi("invalid", {
    fetchImpl: async () =>
      Response.json(
        { ok: false, description: "Unauthorized", error_code: 401 },
        { status: 401 },
      ),
    sleep: async () => assert.fail("terminal failures must not sleep"),
  });
  await assert.rejects(terminalApi.getMe(), (error) => error.terminal === true);
});

test("TelegramApi serializes interactive filter controls", async () => {
  const requests = [];
  const api = new TelegramApi("secret", {
    fetchImpl: async (url, options) => {
      requests.push({
        method: new URL(url).pathname.split("/").at(-1),
        body: JSON.parse(options.body),
      });
      return Response.json({ ok: true, result: true });
    },
  });
  const replyMarkup = {
    inline_keyboard: [[{ text: "Фильтры", callback_data: "f:menu" }]],
  };

  await api.getUpdates(5, 25);
  await api.sendMessage(42, "Настройки", undefined, replyMarkup);
  await api.editMessageText(42, 10, "Фильтры", undefined, replyMarkup);
  await api.answerCallbackQuery("query-1");

  assert.deepEqual(requests, [
    {
      method: "getUpdates",
      body: {
        offset: 5,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      },
    },
    {
      method: "sendMessage",
      body: {
        chat_id: 42,
        text: "Настройки",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      },
    },
    {
      method: "editMessageText",
      body: {
        chat_id: 42,
        message_id: 10,
        text: "Фильтры",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      },
    },
    {
      method: "answerCallbackQuery",
      body: { callback_query_id: "query-1" },
    },
  ]);
});

test("the start button wakes the monitor after /start setup", async () => {
  const controller = new AbortController();
  const sent = [];
  const edited = [];
  let updateCalls = 0;
  const api = {
    getUpdates: async (_offset, _timeout, signal) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        return [
          update(1, 42, "/start"),
          callback(2, "m:start"),
          callback(3, "m:start:initial"),
        ];
      }
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    },
    sendMessage: async (chatId, text) => {
      sent.push([chatId, text]);
      if (text.startsWith("Apartment 100")) controller.abort();
    },
    editMessageText: async (chatId, _messageId, text) => {
      edited.push([chatId, text]);
    },
    answerCallbackQuery: async () => {},
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => undefined,
      saveState: async () => {},
      crawl: async (_config, { privateDeliveries }) => {
        assert.equal(privateDeliveries[0].sendInitialApartments, true);
        await privateDeliveries[0].deliverApartment({
          itemId: "100",
          title: "Apartment 100",
          price: { amount: 200_000, currency: "֏" },
          location: "Arabkir",
          rooms: 2,
          areaSqM: 50,
          floor: "3/5",
          date: "Friday, July 24, 2026, 14:31",
          url: "https://www.list.am/ru/item/100",
        });
        return {
          status: "new-apartments",
          discoveredCount: 1,
          notifiedCount: 1,
        };
      },
    },
  );

  assert.deepEqual(
    sent.map(([chatId]) => chatId),
    [42, 42],
  );
  assert.match(sent[0][1], /Мониторинг: остановлен/u);
  assert.match(edited[0][1], /Отправить уже найденные квартиры/u);
  assert.match(edited[1][1], /Мониторинг: запущен/u);
  assert.equal(sent[1][1].startsWith("Apartment 100"), true);
});

test("private controls cannot interrupt the singleton crawl interval", async () => {
  const controller = new AbortController();
  const crawlStarted = Promise.withResolvers();
  const sleepDelays = [];
  let updateCalls = 0;
  let crawlCalls = 0;
  const state = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: {
      42: { active: true, chatId: 42 },
    },
  };
  const api = {
    getUpdates: async (_offset, _timeout, signal) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        await crawlStarted.promise;
        return [
          callback(1, "m:stop"),
          callback(2, "m:start"),
          callback(3, "m:start:new"),
          callback(4, "f:reset"),
        ];
      }
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    },
    editMessageText: async () => {},
    answerCallbackQuery: async () => {},
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramAccessMode: "public",
      telegramUserUpdatesPerMinute: 30,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => state,
      saveState: async () => {},
      sleep: async (milliseconds, _value, { signal }) => {
        sleepDelays.push(milliseconds);
        if (signal.aborted) return;
        return new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
      crawl: async () => {
        crawlCalls += 1;
        crawlStarted.resolve();
        return {
          status: "unchanged",
          pagesParsed: 1,
          discoveredCount: 0,
          updatedCount: 0,
          notifiedCount: 0,
          skippedCount: 0,
          filteredCount: 0,
          totalCount: 0,
        };
      },
      onTelegramSuccess: () => controller.abort(),
    },
  );

  assert.equal(crawlCalls, 1);
  assert.deepEqual(sleepDelays, [60_000]);
});

test("stopping during an activation cadence wait returns to dormancy", async () => {
  const controller = new AbortController();
  const crawlStarted = Promise.withResolvers();
  const firstStop = Promise.withResolvers();
  const postCrawlSleepReturned = Promise.withResolvers();
  const cadenceWaitStarted = Promise.withResolvers();
  const secondStop = Promise.withResolvers();
  let updateCalls = 0;
  let crawlCalls = 0;
  let stopCount = 0;
  let now = 0;
  const state = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: { 42: { active: true, chatId: 42 } },
  };
  const api = {
    getUpdates: async (_offset, _timeout, signal) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        await crawlStarted.promise;
        return [callback(1, "m:stop")];
      }
      if (updateCalls === 2) {
        await postCrawlSleepReturned.promise;
        await new Promise((resolve) => setImmediate(resolve));
        return [callback(2, "m:start"), callback(3, "m:start:new")];
      }
      if (updateCalls === 3) {
        await cadenceWaitStarted.promise;
        return [callback(4, "m:stop")];
      }
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    },
    editMessageText: async () => {},
    answerCallbackQuery: async () => {},
  };
  let sleepCalls = 0;

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramAccessMode: "public",
      telegramUserUpdatesPerMinute: 30,
      telegramPrivateDeliveriesPerMinute: 20,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      monotonicNow: () => now,
      loadState: async () => state,
      saveState: async () => {},
      sleep: async (milliseconds, _value, { signal }) => {
        signal.throwIfAborted();
        sleepCalls += 1;
        if (sleepCalls === 1) {
          postCrawlSleepReturned.resolve();
          return;
        }
        cadenceWaitStarted.resolve();
        await secondStop.promise;
        now += milliseconds;
        setImmediate(() => controller.abort());
      },
      crawl: async () => {
        crawlCalls += 1;
        crawlStarted.resolve();
        if (crawlCalls === 1) await firstStop.promise;
        return {
          status: "unchanged",
          pagesParsed: 1,
          discoveredCount: 0,
          updatedCount: 0,
          notifiedCount: 0,
          skippedCount: 0,
          filteredCount: 0,
          totalCount: 0,
        };
      },
      onPrivateMonitoringChanged: ({ active }) => {
        if (active) return;
        stopCount += 1;
        if (stopCount === 1) firstStop.resolve();
        if (stopCount === 2) secondStop.resolve();
      },
    },
  );

  assert.equal(crawlCalls, 1);
  assert.equal(stopCount, 2);
});

test("private controls cannot bypass crawl failure backoff", async () => {
  const controller = new AbortController();
  const crawlStarted = Promise.withResolvers();
  const retries = [];
  let crawlCalls = 0;
  const state = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: {
      42: { active: true, chatId: 42 },
    },
  };
  const api = {
    getUpdates: async () => {
      await crawlStarted.promise;
      return [callback(1, "f:reset")];
    },
    editMessageText: async () => {},
    answerCallbackQuery: async () => {},
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramAccessMode: "public",
      telegramUserUpdatesPerMinute: 30,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
      externalRetryBaseMs: 1_000,
      externalRetryMaxMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => state,
      saveState: async () => {},
      sleep: async (milliseconds, _value, { signal }) => {
        retries.push(milliseconds);
        if (signal.aborted) return;
        return new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
      crawl: async () => {
        crawlCalls += 1;
        crawlStarted.resolve();
        throw new TypeError("temporary upstream failure");
      },
      onError: async () => {},
      onRetry: async () => {},
      onTelegramSuccess: () => controller.abort(),
    },
  );

  assert.equal(crawlCalls, 1);
  assert.equal(retries.length, 1);
  assert.ok(retries[0] >= 800 && retries[0] <= 1_000);
});

test("source-integrity failure uses crawl backoff and recovers", async () => {
  const controller = new AbortController();
  const retryDelays = [];
  let crawlCalls = 0;
  const state = {
    version: 3,
    type: "telegram-bot",
    updateOffset: 0,
    users: {
      42: { active: true, chatId: 42 },
    },
  };
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramAccessMode: "public",
      telegramUserUpdatesPerMinute: 30,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
      externalRetryBaseMs: 1_000,
      externalRetryMaxMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => state,
      saveState: async () => {},
      sleep: async (milliseconds, _value, { signal }) => {
        signal.throwIfAborted();
        retryDelays.push(milliseconds);
      },
      crawl: async () => {
        crawlCalls += 1;
        if (crawlCalls === 1) {
          throw new ListAmSourceIntegrityError(
            ListAmIntegrityReason.IDENTITY_REJECTION,
            { page: 1 },
          );
        }
        return {};
      },
      onError: async () => {},
      onRetry: async () => {},
      onResult: () => controller.abort(),
    },
  );

  assert.equal(crawlCalls, 2);
  assert.equal(retryDelays.length, 1);
  assert.ok(retryDelays[0] >= 800 && retryDelays[0] <= 1_000);
});

test("exchange rates refresh without private monitoring activation", async () => {
  const controller = new AbortController();
  let refreshCalls = 0;
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => initialState,
      saveState: async () => {},
      exchangeRateService: {
        getSnapshot: async () => {
          refreshCalls += 1;
          controller.abort();
        },
      },
      crawl: async () => {
        throw new Error("Inactive monitoring must not crawl");
      },
    },
  );

  assert.equal(refreshCalls, 1);
});

test("an enabled channel crawls and publishes without private activation", async () => {
  const controller = new AbortController();
  let crawlCalls = 0;
  let channelCalls = 0;
  let privateDelivery;
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramChannelId: "@rentals",
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => initialState,
      saveState: async () => {},
      crawl: async (_config, options) => {
        crawlCalls += 1;
        privateDelivery = options.privateDeliveries;
        await options.afterStateSaved({
          apartments: {},
          apartmentOrder: [],
        });
        return { status: "unchanged", discoveredCount: 0, notifiedCount: 0 };
      },
      publishChannel: async () => {
        channelCalls += 1;
        controller.abort();
        return {
          sentCount: 0,
          editedCount: 0,
          filteredCount: 0,
          skippedCount: 0,
        };
      },
    },
  );

  assert.equal(crawlCalls, 1);
  assert.equal(channelCalls, 1);
  assert.equal(privateDelivery, undefined);
});

test("runtime crawls only authorized active users and exposes live predicates", async () => {
  const controller = new AbortController();
  const accessStates = [];
  const stored = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: {
      42: { active: true, chatId: 42 },
      99: { active: true, chatId: 99, sendInitialApartments: false },
    },
  };
  const runtimeConfig = {
    telegramBotToken: "token",
    telegramOwnerId: 42,
    telegramAccessMode: "owner",
    telegramAllowedUserIds: [],
    telegramStateFile: "/state/bot.json",
    telegramPollTimeoutSeconds: 25,
    timeoutMs: 1_000,
    pollIntervalMs: 60_000,
  };
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
  };

  await runTelegramBot(runtimeConfig, {
    api,
    signal: controller.signal,
    loadState: async () => stored,
    saveState: async () => {},
    crawl: async (_config, { privateDeliveries }) => {
      assert.deepEqual(
        privateDeliveries.map(({ recipientId }) => recipientId),
        ["42"],
      );
      assert.equal(privateDeliveries[0].isAuthorized(), true);
      runtimeConfig.telegramOwnerId = 7;
      assert.equal(privateDeliveries[0].isAuthorized(), false);
      controller.abort();
      return {
        status: "unchanged",
        pagesParsed: 1,
        discoveredCount: 0,
        updatedCount: 0,
        notifiedCount: 0,
        skippedCount: 0,
        filteredCount: 0,
        totalCount: 0,
      };
    },
    onPrivateAccessState: async (state) => accessStates.push(state),
  });

  assert.deepEqual(accessStates[0], {
    accessMode: "owner",
    persistedUserCount: 2,
    authorizedUserCount: 1,
    suspendedUserCount: 1,
    activeUserCount: 1,
  });
  assert.deepEqual(accessStates[1], {
    accessMode: "owner",
    persistedUserCount: 2,
    authorizedUserCount: 0,
    suspendedUserCount: 2,
    activeUserCount: 0,
  });
  assert.equal(
    new Set(accessStates.map((summary) => JSON.stringify(summary))).size,
    accessStates.length,
  );
  assert.deepEqual(stored.users[99].sendInitialApartments, false);
});

test("private delivery reauthorizes after a limiter wait without deactivation", async () => {
  const controller = new AbortController();
  const stored = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: { 42: { active: true, chatId: 42 } },
  };
  const runtimeConfig = {
    telegramBotToken: "token",
    telegramOwnerId: 42,
    telegramAccessMode: "owner",
    telegramAllowedUserIds: [],
    telegramStateFile: "/state/bot.json",
    telegramPollTimeoutSeconds: 25,
    telegramUserUpdatesPerMinute: 30,
    telegramPrivateDeliveriesPerMinute: 1,
    timeoutMs: 1_000,
    pollIntervalMs: 60_000,
  };
  let now = 0;
  const sent = [];
  const deactivations = [];
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
    sendMessage: async (_chatId, text) => sent.push(text),
  };

  await runTelegramBot(runtimeConfig, {
    api,
    signal: controller.signal,
    monotonicNow: () => now,
    sleep: async (milliseconds, _value, { signal } = {}) => {
      signal?.throwIfAborted();
      now += milliseconds;
      runtimeConfig.telegramOwnerId = 7;
    },
    loadState: async () => stored,
    saveState: async () => {},
    crawl: async (_config, { privateDeliveries }) => {
      const delivery = privateDeliveries[0];
      for (let index = 0; index < 5; index += 1) {
        await delivery.deliverApartment({
          itemId: String(index),
          url: `https://www.list.am/ru/item/${index}`,
        });
      }
      await assert.rejects(
        delivery.deliverApartment({
          itemId: "5",
          url: "https://www.list.am/ru/item/5",
        }),
        (error) => error.privateRecipientUnavailable === true,
      );
      controller.abort();
      return {
        status: "unchanged",
        pagesParsed: 1,
        discoveredCount: 0,
        updatedCount: 0,
        notifiedCount: 5,
        skippedCount: 0,
        filteredCount: 0,
        totalCount: 5,
      };
    },
    onPrivateUserDeactivated: async (event) => deactivations.push(event),
  });

  assert.equal(sent.length, 5);
  assert.deepEqual(deactivations, []);
  assert.equal(stored.users[42].active, true);
});

test("a channel failure does not prevent an active private delivery", async () => {
  const controller = new AbortController();
  const sent = [];
  const errors = [];
  const activeState = {
    ...initialState,
    active: true,
    chatId: 42,
  };
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
    sendMessage: async (chatId, text) => {
      sent.push([chatId, text]);
    },
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramChannelId: "@rentals",
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => activeState,
      saveState: async () => {},
      crawl: async (_config, options) => {
        await Promise.all([
          options.privateDeliveries[0].deliverApartment({
            itemId: "100",
            title: "Apartment 100",
            price: { amount: 200_000, currency: "֏" },
            location: "Арабкир",
            rooms: 2,
            areaSqM: 50,
            floor: "3/5",
            url: "https://www.list.am/ru/item/100",
          }),
          options.afterStateSaved({ apartments: {}, apartmentOrder: [] }),
        ]);
        controller.abort();
        return {
          status: "new-apartments",
          discoveredCount: 1,
          notifiedCount: 1,
        };
      },
      publishChannel: async () => {
        throw new Error("Channel state unavailable");
      },
      onError: async (error, context) => errors.push([error, context]),
    },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 42);
  assert.match(sent[0][1], /^Apartment 100/u);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].component, "telegram-channel");
});

test("a blocked private user is deactivated without stopping the bot", async () => {
  const controller = new AbortController();
  const saved = [];
  const deactivations = [];
  const blocked = new Error("Forbidden: bot was blocked by the user");
  blocked.code = "ERR_TELEGRAM_API";
  blocked.terminal = true;
  const activeUserState = {
    version: 2,
    type: "telegram-bot",
    ownerId: 42,
    updateOffset: 0,
    users: {
      99: {
        active: true,
        chatId: 99,
        pendingFilterInput: null,
      },
    },
  };
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
    sendMessage: async () => {
      throw blocked;
    },
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => activeUserState,
      saveState: async (_filename, value) => saved.push(structuredClone(value)),
      crawl: async (_config, { privateDeliveries }) => {
        await assert.rejects(
          privateDeliveries[0].deliverApartment({
            itemId: "100",
            title: "Apartment 100",
            price: { amount: 200_000, currency: "֏" },
            url: "https://www.list.am/ru/item/100",
          }),
          (error) => error.privateRecipientUnavailable === true,
        );
        return {
          status: "unchanged",
          pagesParsed: 1,
          discoveredCount: 0,
          updatedCount: 0,
          notifiedCount: 0,
          skippedCount: 0,
          filteredCount: 0,
          totalCount: 1,
        };
      },
      onPrivateUserDeactivated: async (event) => {
        deactivations.push(event);
      },
      onResult: () => controller.abort(),
    },
  );

  assert.equal(saved.at(-1).users["99"].active, false);
  assert.deepEqual(deactivations, [{ reason: "ERR_TELEGRAM_API" }]);
});

test("concurrent unavailable recipients preserve cumulative bot state", async () => {
  const controller = new AbortController();
  const stored = {
    version: 2,
    type: "telegram-bot",
    updateOffset: 0,
    users: {
      42: { active: true, chatId: 42 },
      99: { active: true, chatId: 99 },
    },
  };
  const blocked = Object.assign(new Error("Forbidden: bot was blocked"), {
    code: "ERR_TELEGRAM_API",
    terminal: true,
  });
  let writesInFlight = 0;
  let maximumWritesInFlight = 0;
  const saved = [];
  const api = {
    getUpdates: async (_offset, _timeout, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
    sendMessage: async () => {
      throw blocked;
    },
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramAccessMode: "public",
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      telegramUserUpdatesPerMinute: 30,
      telegramPrivateDeliveriesPerMinute: 20,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => stored,
      saveState: async (_filename, value) => {
        writesInFlight += 1;
        maximumWritesInFlight = Math.max(maximumWritesInFlight, writesInFlight);
        await Promise.resolve();
        saved.push(structuredClone(value));
        writesInFlight -= 1;
      },
      crawl: async (_config, { privateDeliveries }) => {
        await Promise.all(
          privateDeliveries.map((delivery) =>
            assert.rejects(
              delivery.deliverApartment({
                itemId: "100",
                url: "https://www.list.am/ru/item/100",
              }),
              (error) => error.privateRecipientUnavailable === true,
            ),
          ),
        );
        controller.abort();
        return {
          status: "unchanged",
          pagesParsed: 1,
          discoveredCount: 0,
          updatedCount: 0,
          notifiedCount: 0,
          skippedCount: 0,
          filteredCount: 0,
          totalCount: 1,
        };
      },
    },
  );

  assert.equal(maximumWritesInFlight, 1);
  assert.equal(saved.at(-1).users[42].active, false);
  assert.equal(saved.at(-1).users[99].active, false);
});

test("a terminal command reply deactivates only that private user", async () => {
  const controller = new AbortController();
  const saved = [];
  let updateCalls = 0;
  const blocked = new Error("Forbidden: bot was blocked by the user");
  blocked.code = "ERR_TELEGRAM_API";
  blocked.terminal = true;
  const api = {
    getUpdates: async (_offset, _timeout, signal) => {
      updateCalls += 1;
      if (updateCalls === 1) return [update(1, 99, "/start")];
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    },
    sendMessage: async () => {
      throw blocked;
    },
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => undefined,
      saveState: async (_filename, value) => saved.push(structuredClone(value)),
      crawl: async () => ({
        status: "unchanged",
        pagesParsed: 1,
        discoveredCount: 0,
        updatedCount: 0,
        notifiedCount: 0,
        skippedCount: 0,
        filteredCount: 0,
        totalCount: 0,
      }),
      onPrivateUserDeactivated: () => controller.abort(),
    },
  );

  assert.equal(saved.at(-1).updateOffset, 2);
  assert.equal(saved.at(-1).users["99"].active, false);
});
