import assert from "node:assert/strict";
import test from "node:test";

import {
  compatibleBotState,
  processUpdates,
  runTelegramBot,
} from "../src/bot.js";
import {
  formatApartmentMessage,
  isStartCommand,
  TelegramApi,
} from "../src/telegram.js";

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
    compatibleBotState({ version: 2, type: "telegram-bot", users: {} }),
    true,
  );
  assert.equal(
    compatibleBotState({ version: 1, type: "telegram-bot", ownerId: 99 }),
    true,
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
      callback(14, "m:start"),
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

  assert.equal(state.version, 2);
  assert.equal(state.users["99"].active, false);
  assert.equal(state.users["42"].active, false);
  assert.equal(state.updateOffset, 16);
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /Мониторинг: остановлен/u);
  assert.equal(sent[0][2].inline_keyboard.at(-1)[0].callback_data, "m:start");
  assert.match(edited[0][2], /Мониторинг: запущен/u);
  assert.equal(edited[0][3].inline_keyboard.at(-1)[0].callback_data, "m:stop");
  assert.match(edited.at(-1)[2], /Мониторинг: остановлен/u);
  assert.deepEqual(subscriptionChanges, [{ active: true }, { active: false }]);
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
        return [update(1, 42, "/start"), callback(2, "m:start")];
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
  assert.match(edited[0][1], /Мониторинг: запущен/u);
  assert.equal(sent[1][1].startsWith("Apartment 100"), true);
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
        filters: {},
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
